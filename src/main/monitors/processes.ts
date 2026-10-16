import { exec } from 'child_process'
import { promisify } from 'util'
import type { ProcessInfo, ProcessGroup } from '../../shared/types'
import { isWindows } from '../platform'

const execAsync = promisify(exec)

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
  // Try Windows-style path (e.g. C:\Users\... or C:/Users/...)
  const winMatch = command.match(/[A-Za-z]:[/\\](?:Users|home)[/\\][^\s]+/)

  if (!unixMatch && !winMatch) return undefined

  if (unixMatch && !winMatch) {
    // Pure Unix path
    return extractWorkingDirFromSegments(unixMatch[0], '/')
  }

  // Windows path — normalize backslashes to forward slashes for consistent processing
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

  // No infrastructure dirs found — the path itself might be a file path.
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

const WINDOWS_PS_COMMAND =
  'powershell.exe -NoProfile -Command "Get-Process | Select-Object Id, ProcessName, CPU, @{N=\'Mem\';E={[math]::Round($_.WorkingSet64/1MB,1)}}, Path, @{N=\'User\';E={try{$p=$_.GetOwner();if($p){$p.User}}catch{\'\'}}} | ConvertTo-Csv -NoTypeInformation"'

export function parseWindowsProcessOutput(output: string): ProcessInfo[] {
  const lines = output.trim().split('\n')
  if (lines.length < 2) return []

  return lines
    .slice(1) // skip CSV header
    .map((line) => {
      const trimmed = line.trim()
      if (!trimmed) return null

      // Parse CSV: "Id","ProcessName","CPU","Mem","Path","User"
      // Fields may be quoted and may contain commas inside quotes
      const fields = parseCSVLine(trimmed)
      if (fields.length < 4) return null

      const pid = parseInt(fields[0], 10)
      const processName = fields[1] || ''
      const cpu = parseFloat(fields[2]) || 0
      const mem = parseFloat(fields[3]) || 0
      const path = fields[4] || ''
      const user = fields[5] || ''

      const command = path || processName
      const name = extractProcessName(command || processName)
      const cwd = path ? extractWorkingDir(path) : undefined

      return { pid, user, cpu, mem, command, name, cwd } as ProcessInfo
    })
    .filter((p): p is ProcessInfo => p !== null && !isNaN(p.pid))
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

export async function getProcesses(): Promise<ProcessInfo[]> {
  try {
    if (isWindows()) {
      const { stdout } = await execAsync(WINDOWS_PS_COMMAND, { maxBuffer: 10 * 1024 * 1024 })
      return parseWindowsProcessOutput(stdout)
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
