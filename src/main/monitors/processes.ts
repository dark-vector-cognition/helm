import { exec, execFile } from 'child_process'
import { promisify } from 'util'
import { cpus, totalmem } from 'os'
import type { ProcessInfo, ProcessGroup } from '../../shared/types'
import { isWindows } from '../platform'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

const AGENT_PATTERNS = ['claude', 'codex', 'gemini']
const SERVICE_PATTERNS = ['postgres', 'redis', 'mysql', 'mongo', 'nginx', 'docker']

export function parseProcessOutput(output: string): ProcessInfo[] {
  const lines = output.trim().split('\n')
  return lines
    .slice(1)
    .map((line) => {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 11) return null

      const user = parts[0]
      const pid = parseInt(parts[1], 10)
      const cpu = parseFloat(parts[2])
      const mem = parseFloat(parts[3])
      const command = parts.slice(10).join(' ')
      const name = extractProcessName(command)
      const cwd = extractWorkingDir(command)

      return { pid, user, cpu, mem, command, name, cwd } as ProcessInfo
    })
    .filter((p): p is ProcessInfo => p !== null && !isNaN(p.pid))
}

function extractProcessName(command: string): string {
  const executable = command.split(/\s+/)[0]
  return executable.split(/[/\\]/).pop() || executable
}

function extractWorkingDir(command: string): string | undefined {
  // Try Unix-style path first
  const unixMatch = command.match(/\/(Users|home)\/[^\s]+/)
  // Try Windows-style path (a drive letter, then Users or home, with either slash style)
  const winMatch = command.match(/[A-Za-z]:[/\\](?:Users|home)[/\\][^\s]+/)

  if (!unixMatch && !winMatch) return undefined

  if (unixMatch && !winMatch) {
    // Pure Unix path
    return extractWorkingDirFromSegments(unixMatch[0], '/')
  }

  // Windows path - normalize backslashes to forward slashes for consistent processing
  const rawPath = (winMatch || unixMatch)![0]
  const normalized = rawPath.replace(/\\/g, '/')
  return extractWorkingDirFromSegments(normalized, '/')
}

function extractWorkingDirFromSegments(fullPath: string, sep: string): string | undefined {
  const segments = fullPath.split(sep)

  // Infrastructure directories that indicate we've gone past the project root
  const INFRA_DIRS = ['node_modules', '.bin', 'bin', 'lib', '.nvm', 'versions']

  // Walk forward from the start. When we hit an infrastructure directory,
  // the project root is everything before it.
  for (let i = 0; i < segments.length; i++) {
    if (INFRA_DIRS.includes(segments[i])) {
      // Return everything up to (but not including) this infrastructure dir
      if (i >= 3) {
        return segments.slice(0, i).join(sep)
      }
      return undefined
    }
    // Skip version-like segments that are children of .nvm/versions etc.
    if (i > 3 && /^v?\d+[\.\d]*$/.test(segments[i])) {
      if (i >= 3) {
        return segments.slice(0, i).join(sep)
      }
      return undefined
    }
  }

  // No infrastructure dirs found - the path itself might be a file path.
  // Return the directory (everything except the last segment if it looks like a file).
  const lastSegment = segments[segments.length - 1]
  if (lastSegment.includes('.') && segments.length > 3) {
    return segments.slice(0, segments.length - 1).join(sep)
  }

  // Return the full path if it's a directory path
  if (segments.length > 3) {
    return fullPath
  }

  return undefined
}

export function groupProcesses(processes: ProcessInfo[]): ProcessGroup[] {
  const groups = new Map<string, ProcessGroup>()

  for (const proc of processes) {
    const { groupName, type } = classifyProcess(proc)
    const key = `${type}:${groupName}`

    if (!groups.has(key)) {
      groups.set(key, {
        name: groupName,
        type,
        processes: [],
        totalCpu: 0,
        totalMem: 0,
        ports: []
      })
    }

    const group = groups.get(key)!
    group.processes.push(proc)
    group.totalCpu += proc.cpu
    group.totalMem += proc.mem
  }

  return Array.from(groups.values())
}

function classifyProcess(proc: ProcessInfo): { groupName: string; type: ProcessGroup['type'] } {
  const cmdLower = proc.command.toLowerCase()
  const nameLower = proc.name.toLowerCase()

  // Check agent patterns first (agents take priority)
  if (AGENT_PATTERNS.some((p) => cmdLower.includes(p))) {
    const agent = AGENT_PATTERNS.find((p) => cmdLower.includes(p))!
    return { groupName: agent.charAt(0).toUpperCase() + agent.slice(1), type: 'agent' }
  }

  // Check service patterns
  if (SERVICE_PATTERNS.some((p) => nameLower.includes(p))) {
    const service = SERVICE_PATTERNS.find((p) => nameLower.includes(p))!
    return { groupName: service.charAt(0).toUpperCase() + service.slice(1), type: 'service' }
  }

  // Group by project directory if detected
  if (proc.cwd) {
    const projectName = proc.cwd.split(/[/\\]/).pop() || 'Unknown'
    return { groupName: projectName, type: 'project' }
  }

  return { groupName: 'System', type: 'other' }
}

const WINDOWS_PS_SCRIPT = `
$culture = [Globalization.CultureInfo]::InvariantCulture
Get-Process | Select-Object Id, ProcessName,
  @{N='CPU';E={try{$_.TotalProcessorTime.TotalSeconds.ToString('R', $culture)}catch{''}}},
  @{N='WorkingSetBytes';E={$_.WorkingSet64}}, Path,
  @{N='User';E={''}},
  @{N='StartTime';E={try{$_.StartTime.ToUniversalTime().Ticks.ToString($culture)}catch{''}}},
  @{N='SampleTime';E={([Diagnostics.Stopwatch]::GetTimestamp() / [double][Diagnostics.Stopwatch]::Frequency).ToString('R', $culture)}} |
  ConvertTo-Csv -NoTypeInformation
`

interface WindowsCpuSample {
  cpuSeconds: number
  sampledAt: number
  startedAt: string
  command: string
}

function nonNegativeNumber(value: string): number | null {
  if (!value?.trim()) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

export class WindowsProcessSampler {
  private samples = new Map<number, WindowsCpuSample>()
  private readonly logicalCpuCount: number
  private readonly totalMemoryBytes: number

  constructor(options: { logicalCpuCount?: number; totalMemoryBytes?: number } = {}) {
    this.logicalCpuCount = Math.max(1, options.logicalCpuCount ?? cpus().length)
    this.totalMemoryBytes = Math.max(1, options.totalMemoryBytes ?? totalmem())
  }

  parse(output: string): ProcessInfo[] {
    const nextSamples = new Map<number, WindowsCpuSample>()
    const processes: ProcessInfo[] = []
    for (const line of output.trim().split('\n').slice(1)) {
      const fields = parseCSVLine(line.trim())
      if (fields.length < 8) continue

      const pid = Number(fields[0])
      // PID 0 is Windows' idle pseudo-process, not an app consuming CPU.
      if (!Number.isInteger(pid) || pid <= 0) continue

      const processName = fields[1] || ''
      const cpuSeconds = nonNegativeNumber(fields[2])
      const workingSetBytes = nonNegativeNumber(fields[3]) ?? 0
      const path = fields[4] || ''
      const user = fields[5] || ''
      const startedAt = fields[6]
      const sampledAt = nonNegativeNumber(fields[7])
      const command = path || processName
      const name = extractProcessName(command || processName)
      const cwd = path ? extractWorkingDir(path) : undefined
      let cpu = 0

      if (cpuSeconds !== null && sampledAt !== null && startedAt) {
        const previous = this.samples.get(pid)
        if (previous && previous.startedAt === startedAt && previous.command === command) {
          const elapsed = sampledAt - previous.sampledAt
          const used = cpuSeconds - previous.cpuSeconds
          // CPU counters are cumulative seconds across all cores. Normalize the
          // delta to machine capacity; never treat process lifetime as usage.
          if (elapsed > 0 && used >= 0) {
            cpu = Math.min(100, (used / elapsed / this.logicalCpuCount) * 100)
          }
        }
        nextSamples.set(pid, { cpuSeconds, sampledAt, startedAt, command })
      }

      const mem = Math.min(100, (workingSetBytes / this.totalMemoryBytes) * 100)
      processes.push({ pid, user, cpu, mem, command, name, cwd })
    }
    // Missing/exited processes and inaccessible counters must not retain stale baselines.
    this.samples = nextSamples
    return processes
  }
}

export function parseWindowsProcessOutput(
  output: string,
  sampler = new WindowsProcessSampler()
): ProcessInfo[] {
  return sampler.parse(output)
}

function parseCSVLine(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"'
          i++ // skip escaped quote
        } else {
          inQuotes = false
        }
      } else {
        current += ch
      }
    } else {
      if (ch === '"') {
        inQuotes = true
      } else if (ch === ',') {
        fields.push(current)
        current = ''
      } else {
        current += ch
      }
    }
  }
  fields.push(current)
  return fields
}

const windowsSampler = new WindowsProcessSampler()
let windowsCollection: Promise<ProcessInfo[]> | undefined

async function collectWindowsProcesses(): Promise<ProcessInfo[]> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PS_SCRIPT],
    { maxBuffer: 10 * 1024 * 1024, timeout: 3500, windowsHide: true }
  )
  return windowsSampler.parse(stdout)
}

export async function getProcesses(): Promise<ProcessInfo[]> {
  try {
    if (isWindows()) {
      // Refresh and timer ticks can overlap. Share one ordered sample so they
      // cannot race or overwrite each other's CPU baselines.
      if (!windowsCollection) {
        windowsCollection = collectWindowsProcesses().finally(() => {
          windowsCollection = undefined
        })
      }
      return await windowsCollection
    }
    const { stdout } = await execAsync('ps aux')
    return parseProcessOutput(stdout)
  } catch {
    return []
  }
}

export async function getProcessGroups(): Promise<ProcessGroup[]> {
  const processes = await getProcesses()
  return groupProcesses(processes)
}
