import { exec } from 'child_process'
import { promisify } from 'util'
import type { PortInfo } from '../../shared/types'
import { isWindows } from '../platform'

const execAsync = promisify(exec)

export function parseLsofOutput(output: string): PortInfo[] {
  const lines = output.trim().split('\n')
  const results: PortInfo[] = []

  // Skip header line; handle empty/whitespace-only input
  if (lines.length <= 1 && !lines[0]?.includes('\t') && lines[0]?.startsWith('COMMAND')) {
    return results
  }
  if (output.trim() === '') return results

  for (const line of lines.slice(1)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 10) continue

    const process = parts[0]
    const pid = parseInt(parts[1], 10)
    const type = parts[4]

    if (!type?.startsWith('IPv')) continue

    const protocol = parts[7] as 'TCP' | 'UDP'
    if (protocol !== 'TCP' && protocol !== 'UDP') continue

    const nameField = parts[8]
    const stateField = parts[9]

    const parsed = parseNameField(nameField)
    if (!parsed) continue

    const state = parseState(stateField)

    results.push({
      port: parsed.port,
      pid,
      process,
      protocol,
      state,
      address: parsed.address
    })
  }

  return results
}

function parseNameField(name: string): { address: string; port: number } | null {
  // For connections like "127.0.0.1:3000->127.0.0.1:54321", take the local part
  const localPart = name.split('->')[0]
  const lastColon = localPart.lastIndexOf(':')
  if (lastColon === -1) return null

  const address = localPart.substring(0, lastColon)
  const port = parseInt(localPart.substring(lastColon + 1), 10)

  if (isNaN(port)) return null
  return { address, port }
}

function parseState(stateField: string): PortInfo['state'] {
  if (!stateField) return 'OTHER'
  const s = stateField.replace(/[()]/g, '').toUpperCase()
  if (s === 'LISTEN') return 'LISTEN'
  if (s === 'ESTABLISHED') return 'ESTABLISHED'
  if (s === 'CLOSE_WAIT') return 'CLOSE_WAIT'
  return 'OTHER'
}

function parseWindowsState(state: string): PortInfo['state'] {
  if (!state) return 'OTHER'
  const s = state.trim().toUpperCase()
  if (s === 'LISTENING') return 'LISTEN'
  if (s === 'ESTABLISHED') return 'ESTABLISHED'
  if (s === 'CLOSE_WAIT') return 'CLOSE_WAIT'
  return 'OTHER'
}

function buildPidNameMap(csvOutput: string): Map<number, string> {
  const map = new Map<number, string>()
  const lines = csvOutput.trim().split('\n')
  // First line is the CSV header: "Id","ProcessName"
  for (const line of lines.slice(1)) {
    const match = line.match(/"(\d+)","(.+?)"/)
    if (match) {
      map.set(parseInt(match[1], 10), match[2])
    }
  }
  return map
}

export function parseNetstatOutput(
  output: string,
  pidNameMap?: Map<number, string>
): PortInfo[] {
  const lines = output.trim().split('\n')
  const results: PortInfo[] = []

  if (output.trim() === '') return results

  for (const line of lines) {
    const trimmed = line.trim()

    // Skip blank lines, header lines, and the "Active Connections" title
    if (!trimmed) continue
    if (trimmed.startsWith('Active')) continue
    if (trimmed.startsWith('Proto')) continue

    const parts = trimmed.split(/\s+/)

    // TCP lines have 5 columns: Proto, Local Address, Foreign Address, State, PID
    // UDP lines have 4 columns: Proto, Local Address, Foreign Address, PID (no state)
    const proto = parts[0]?.toUpperCase()
    if (proto !== 'TCP' && proto !== 'UDP') continue

    const localAddress = parts[1]
    if (!localAddress) continue

    let state: PortInfo['state']
    let pid: number

    if (proto === 'UDP') {
      // UDP: Proto  Local Address  Foreign Address  PID
      if (parts.length < 4) continue
      state = 'OTHER'
      pid = parseInt(parts[3], 10)
    } else {
      // TCP: Proto  Local Address  Foreign Address  State  PID
      if (parts.length < 5) continue
      state = parseWindowsState(parts[3])
      pid = parseInt(parts[4], 10)
    }

    if (isNaN(pid)) continue

    // Parse local address - format is address:port
    const lastColon = localAddress.lastIndexOf(':')
    if (lastColon === -1) continue

    const address = localAddress.substring(0, lastColon)
    const port = parseInt(localAddress.substring(lastColon + 1), 10)
    if (isNaN(port)) continue

    const processName = pidNameMap?.get(pid) ?? `PID:${pid}`

    results.push({
      port,
      pid,
      process: processName,
      protocol: proto as 'TCP' | 'UDP',
      state,
      address
    })
  }

  return results
}

async function getWindowsPidNameMap(): Promise<Map<number, string>> {
  try {
    const { stdout } = await execAsync(
      'powershell.exe -NoProfile -Command "Get-Process | Select-Object Id, ProcessName | ConvertTo-Csv -NoTypeInformation"'
    )
    return buildPidNameMap(stdout)
  } catch {
    return new Map()
  }
}

export async function getPorts(): Promise<PortInfo[]> {
  try {
    if (isWindows()) {
      const [netstatResult, pidNameMap] = await Promise.all([
        execAsync('netstat -ano'),
        getWindowsPidNameMap()
      ])
      return parseNetstatOutput(netstatResult.stdout, pidNameMap)
    } else {
      const { stdout } = await execAsync('lsof -i -P -n')
      return parseLsofOutput(stdout)
    }
  } catch {
    return []
  }
}
