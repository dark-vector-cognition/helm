import { exec } from 'child_process'
import { setTimeout as delay } from 'timers/promises'
import { promisify } from 'util'
import { promises as dns } from 'dns'
import type {
  NetworkConnection,
  NetworkProcess,
  NetworkScope,
  NetworkSourceMode,
  NetworkState
} from '../../shared/types'
import { isMacOS, isWindows } from '../platform'

const execAsync = promisify(exec)

// ── Reverse DNS cache ──────────────────────────────────────────
const dnsCache = new Map<string, { host: string; expires: number }>()
const DNS_TTL_MS = 5 * 60 * 1000 // 5 minute cache
const DNS_TIMEOUT_MS = 2000
const pendingLookups = new Set<string>()

function isPrivateIp(ip: string): boolean {
  return (
    ip.startsWith('127.') ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    ip.startsWith('172.16.') || ip.startsWith('172.17.') || ip.startsWith('172.18.') ||
    ip.startsWith('172.19.') || ip.startsWith('172.2') || ip.startsWith('172.3') ||
    ip === '::1' || ip.startsWith('fe80:') || ip.startsWith('fd')
  )
}

async function resolveHost(ip: string): Promise<string | undefined> {
  const normalized = ip.replace(/^::ffff:/, '')
  if (isPrivateIp(normalized) || normalized === 'localhost') return undefined

  const cached = dnsCache.get(normalized)
  if (cached && cached.expires > Date.now()) return cached.host

  if (pendingLookups.has(normalized)) return cached?.host

  pendingLookups.add(normalized)
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), DNS_TIMEOUT_MS)
    const hostnames = await dns.reverse(normalized)
    clearTimeout(timeout)
    const host = hostnames[0] ?? undefined
    if (host) {
      dnsCache.set(normalized, { host, expires: Date.now() + DNS_TTL_MS })
    }
    return host
  } catch {
    // Cache the failure so we don't retry constantly
    dnsCache.set(normalized, { host: normalized, expires: Date.now() + DNS_TTL_MS })
    return undefined
  } finally {
    pendingLookups.delete(normalized)
  }
}

export async function enrichConnectionsWithDns(connections: NetworkConnection[]): Promise<void> {
  const internetConnections = connections.filter((c) => c.scope === 'internet')
  const uniqueIps = [...new Set(internetConnections.map((c) => c.remoteAddress.replace(/^::ffff:/, '')))]

  // Resolve up to 10 IPs per cycle to avoid blocking
  const batch = uniqueIps.slice(0, 10)
  await Promise.allSettled(batch.map((ip) => resolveHost(ip)))

  // Apply cached results to all connections
  for (const conn of connections) {
    const normalized = conn.remoteAddress.replace(/^::ffff:/, '')
    const cached = dnsCache.get(normalized)
    if (cached && cached.host !== normalized) {
      conn.resolvedHost = cached.host
    }
  }
}

interface RawNetworkEntry {
  name: string
  pid: number
  bytesIn: number
  bytesOut: number
}

interface RawNetworkConnection {
  id: string
  processName: string
  pid: number
  protocol: string
  state: string
  localAddress: string
  localPort: number | null
  remoteAddress: string
  remotePort: number | null
  scope: NetworkScope
  bytesIn: number
  bytesOut: number
}

interface RawNettopSnapshot {
  processes: RawNetworkEntry[]
  connections: RawNetworkConnection[]
}

interface Snapshot {
  processes: Map<number, { bytesIn: number; bytesOut: number }>
  connections: Map<string, { bytesIn: number; bytesOut: number }>
  timestamp: number
}

interface NetworkSourceSelection {
  mode: NetworkSourceMode
  processes: RawNetworkEntry[] | null
  connections: RawNetworkConnection[] | null
}

let previousSnapshot: Snapshot | null = null

// Track which source is working so we don't retry failed ones every poll
let nettopFailed = false

function parseMetric(value: string | undefined): number {
  const parsed = Number.parseInt((value || '').trim(), 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function isConnectionIdentifier(identifier: string): boolean {
  return /^(tcp|udp)\d?\s+/i.test(identifier)
}

function parseProcessIdentifier(identifier: string): { name: string; pid: number } | null {
  if (!identifier || isConnectionIdentifier(identifier)) return null

  const lastDotIndex = identifier.lastIndexOf('.')
  if (lastDotIndex === -1) return null

  const pid = Number.parseInt(identifier.slice(lastDotIndex + 1), 10)
  if (!Number.isFinite(pid)) return null

  const name = identifier.slice(0, lastDotIndex).trim()
  if (!name) return null

  return { name, pid }
}

function splitEndpoint(raw: string): { address: string; port: number | null } {
  const trimmed = raw.trim()
  if (!trimmed || trimmed === '*:*' || trimmed === '*.*' || trimmed === '*') {
    return { address: '*', port: null }
  }

  for (let index = trimmed.length - 1; index >= 0; index--) {
    const char = trimmed[index]
    if (char !== ':' && char !== '.') continue

    const suffix = trimmed.slice(index + 1)
    if (!suffix || !/^(\d+|\*)$/.test(suffix)) continue

    return {
      address: trimmed.slice(0, index) || '*',
      port: /^\d+$/.test(suffix) ? Number.parseInt(suffix, 10) : null
    }
  }

  return { address: trimmed, port: null }
}

function isLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase()
  return normalized === 'localhost' || normalized === '::1' || normalized.startsWith('127.')
}

function isPrivateIPv4(address: string): boolean {
  return (
    address.startsWith('10.') ||
    address.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(address) ||
    address.startsWith('169.254.')
  )
}

function isLanAddress(address: string): boolean {
  const normalized = address.toLowerCase()
  if (isPrivateIPv4(normalized)) return true
  return normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')
}

function classifyNetworkScope(localAddress: string, remoteAddress: string): NetworkScope {
  const local = localAddress.toLowerCase()
  const remote = remoteAddress.toLowerCase()

  if (remote === '*' || remote === '') return 'unknown'
  if (isLoopbackAddress(remote) || isLoopbackAddress(local)) return 'loopback'
  if (isLanAddress(remote)) return 'lan'
  return 'internet'
}

function buildConnectionId(connection: Omit<RawNetworkConnection, 'id'>): string {
  return [
    connection.pid,
    connection.protocol,
    connection.localAddress,
    connection.localPort ?? '*',
    connection.remoteAddress,
    connection.remotePort ?? '*'
  ].join('|')
}

function parseConnectionIdentifier(
  identifier: string,
  currentProcess: RawNetworkEntry | null,
  state: string,
  bytesIn: number,
  bytesOut: number
): RawNetworkConnection | null {
  if (!currentProcess) return null

  const match = identifier.match(/^((?:tcp|udp)\d?)\s+(.+?)<->(.+)$/i)
  if (!match) return null

  const protocol = match[1].toLowerCase()
  const local = splitEndpoint(match[2])
  const remote = splitEndpoint(match[3])
  const scope = classifyNetworkScope(local.address, remote.address)
  const connection = {
    processName: currentProcess.name,
    pid: currentProcess.pid,
    protocol,
    state: state || '',
    localAddress: local.address,
    localPort: local.port,
    remoteAddress: remote.address,
    remotePort: remote.port,
    scope,
    bytesIn,
    bytesOut
  }

  return {
    ...connection,
    id: buildConnectionId(connection)
  }
}

/**
 * Parse connection-aware nettop CSV output. Process rows set the active process
 * context, and following socket rows are attached to that process.
 */
export function parseNettopSnapshot(raw: string): RawNettopSnapshot {
  const trimmed = raw.trim()
  if (!trimmed) return { processes: [], connections: [] }

  const lines = trimmed.split('\n').map((line) => line.trim()).filter(Boolean)
  if (lines.length <= 1) return { processes: [], connections: [] }

  const headers = lines[0].replace(/^,/, '').replace(/,$/, '').split(',').map((part) => part.trim())
  const processes: RawNetworkEntry[] = []
  const connections: RawNetworkConnection[] = []
  let currentProcess: RawNetworkEntry | null = null

  for (let index = 1; index < lines.length; index++) {
    const parts = lines[index].replace(/,$/, '').split(',')
    if (parts.length === 0) continue

    const identifier = parts[0]?.trim()
    if (!identifier) continue

    const columns = new Map<string, string>()
    for (let columnIndex = 0; columnIndex < headers.length; columnIndex++) {
      columns.set(headers[columnIndex], parts[columnIndex + 1]?.trim() ?? '')
    }

    const bytesIn = parseMetric(columns.get('bytes_in'))
    const bytesOut = parseMetric(columns.get('bytes_out'))
    const state = columns.get('state') || ''

    const process = parseProcessIdentifier(identifier)
    if (process) {
      currentProcess = {
        ...process,
        bytesIn,
        bytesOut
      }
      processes.push(currentProcess)
      continue
    }

    const connection = parseConnectionIdentifier(identifier, currentProcess, state, bytesIn, bytesOut)
    if (connection) {
      connections.push(connection)
    }
  }

  return { processes, connections }
}

/**
 * Legacy helper used by tests and callers that only care about process totals.
 */
export function parseNettopOutput(raw: string): RawNetworkEntry[] {
  return parseNettopSnapshot(raw).processes
}

/**
 * Non-privileged nettop can emit process rows with every counter stuck at zero.
 * Treat that as unusable so we fall back to interface-level netstat data.
 */
export function hasUsableNettopData(entries: RawNetworkEntry[]): boolean {
  return entries.some((entry) => entry.bytesIn > 0 || entry.bytesOut > 0)
}

export function selectNetworkSource(
  nettopSnapshot: RawNettopSnapshot | null,
  netstatEntries: RawNetworkEntry[] | null
): NetworkSourceSelection {
  if (nettopSnapshot && hasUsableNettopData(nettopSnapshot.processes)) {
    return {
      mode: 'nettop',
      processes: aggregateByPid(nettopSnapshot.processes),
      connections: nettopSnapshot.connections
    }
  }

  if (netstatEntries && netstatEntries.length > 0) {
    return {
      mode: 'netstat',
      processes: netstatEntries,
      connections: []
    }
  }

  return {
    mode: 'unavailable',
    processes: null,
    connections: null
  }
}

/**
 * Parse netstat -ib output into interface-level byte counts.
 * Returns one entry per active interface (en0, en1, etc.) with cumulative bytes.
 */
export function parseNetstatOutput(
  raw: string
): { name: string; bytesIn: number; bytesOut: number }[] {
  const lines = raw.trim().split('\n')
  if (lines.length <= 1) return []

  const results: { name: string; bytesIn: number; bytesOut: number }[] = []
  const seen = new Set<string>()

  for (let index = 1; index < lines.length; index++) {
    const cols = lines[index].trim().split(/\s+/)
    if (cols.length < 11) continue

    const iface = cols[0]
    if (iface.startsWith('lo') || iface.endsWith('*')) continue
    if (!cols[2].startsWith('<Link#')) continue
    if (seen.has(iface)) continue
    seen.add(iface)

    const bytesIn = Number.parseInt(cols[6], 10)
    const bytesOut = Number.parseInt(cols[9], 10)
    if (!Number.isFinite(bytesIn) || !Number.isFinite(bytesOut)) continue
    if (bytesIn === 0 && bytesOut === 0) continue

    results.push({ name: iface, bytesIn, bytesOut })
  }

  return results
}

function interfacePid(name: string): number {
  let hash = 0
  for (const char of name) {
    hash = (hash * 31 + char.charCodeAt(0)) % 1000000
  }
  return -(hash + 1)
}

function mapNetstatEntries(
  interfaces: { name: string; bytesIn: number; bytesOut: number }[]
): RawNetworkEntry[] {
  return interfaces.map((iface) => ({
    name: iface.name,
    pid: interfacePid(iface.name),
    bytesIn: iface.bytesIn,
    bytesOut: iface.bytesOut
  }))
}

function aggregateByPid(entries: RawNetworkEntry[]): RawNetworkEntry[] {
  const pidMap = new Map<number, RawNetworkEntry>()

  for (const entry of entries) {
    const existing = pidMap.get(entry.pid)
    if (existing) {
      existing.bytesIn += entry.bytesIn
      existing.bytesOut += entry.bytesOut
    } else {
      pidMap.set(entry.pid, { ...entry })
    }
  }

  return Array.from(pidMap.values())
}

function buildSnapshot(
  processes: RawNetworkEntry[],
  connections: RawNetworkConnection[],
  timestamp: number
): Snapshot {
  return {
    processes: new Map(
      processes.map((entry) => [
        entry.pid,
        {
          bytesIn: entry.bytesIn,
          bytesOut: entry.bytesOut
        }
      ])
    ),
    connections: new Map(
      connections.map((entry) => [
        entry.id,
        {
          bytesIn: entry.bytesIn,
          bytesOut: entry.bytesOut
        }
      ])
    ),
    timestamp
  }
}

function shouldExposeConnection(connection: RawNetworkConnection): boolean {
  if (connection.scope === 'unknown') return false
  return connection.remoteAddress !== '*' && connection.state.toLowerCase() !== 'listen'
}

function buildNetworkState(
  processes: RawNetworkEntry[],
  connections: RawNetworkConnection[],
  now: number,
  sourceMode: NetworkSourceMode
): NetworkState {
  const { state, snapshot } = buildNetworkStateFromSnapshot(previousSnapshot, processes, connections, now, sourceMode)
  previousSnapshot = snapshot
  return state
}

function buildNetworkStateFromSnapshot(
  baseline: Snapshot | null,
  processes: RawNetworkEntry[],
  connections: RawNetworkConnection[],
  now: number,
  sourceMode: NetworkSourceMode
): { state: NetworkState; snapshot: Snapshot } {
  const currentSnapshot = buildSnapshot(processes, connections, now)
  const elapsedSec = baseline !== null ? (now - baseline.timestamp) / 1000 : 0

  const nextProcesses: NetworkProcess[] = processes.map((entry) => {
    let bytesInPerSec = 0
    let bytesOutPerSec = 0

    if (baseline && elapsedSec > 0) {
      const previous = baseline.processes.get(entry.pid)
      if (previous) {
        bytesInPerSec = Math.max(0, entry.bytesIn - previous.bytesIn) / elapsedSec
        bytesOutPerSec = Math.max(0, entry.bytesOut - previous.bytesOut) / elapsedSec
      }
    }

    return {
      name: entry.name,
      pid: entry.pid,
      bytesIn: entry.bytesIn,
      bytesOut: entry.bytesOut,
      bytesInPerSec,
      bytesOutPerSec
    }
  })

  const nextConnections: NetworkConnection[] = connections
    .filter(shouldExposeConnection)
    .map((entry) => {
      let bytesInPerSec = 0
      let bytesOutPerSec = 0

      if (baseline && elapsedSec > 0) {
        const previous = baseline.connections.get(entry.id)
        if (previous) {
          bytesInPerSec = Math.max(0, entry.bytesIn - previous.bytesIn) / elapsedSec
          bytesOutPerSec = Math.max(0, entry.bytesOut - previous.bytesOut) / elapsedSec
        }
      }

      return {
        ...entry,
        bytesInPerSec,
        bytesOutPerSec
      }
    })

  const totalBytesInPerSec = nextProcesses.reduce((sum, entry) => sum + entry.bytesInPerSec, 0)
  const totalBytesOutPerSec = nextProcesses.reduce((sum, entry) => sum + entry.bytesOutPerSec, 0)

  return {
    state: {
      processes: nextProcesses,
      connections: nextConnections,
      totalBytesInPerSec,
      totalBytesOutPerSec,
      timestamp: now,
      sourceMode
    },
    snapshot: currentSnapshot
  }
}

/**
 * Parse Windows `netstat -e` output to get interface-level byte totals.
 * Output format:
 *   Interface Statistics
 *                              Received            Sent
 *   Bytes                     123456789        98765432
 */
export function parseWindowsNetstatE(raw: string): { bytesIn: number; bytesOut: number } | null {
  const lines = raw.trim().split('\n')
  for (const line of lines) {
    const match = line.match(/^\s*Bytes\s+(\d+)\s+(\d+)/i)
    if (match) {
      const bytesIn = Number.parseInt(match[1], 10)
      const bytesOut = Number.parseInt(match[2], 10)
      if (Number.isFinite(bytesIn) && Number.isFinite(bytesOut)) {
        return { bytesIn, bytesOut }
      }
    }
  }
  return null
}

/**
 * Parse Windows `netstat -ano` output into connection entries.
 * Lines look like:
 *   TCP    192.168.1.5:49721    142.250.80.46:443    ESTABLISHED    12345
 */
export function parseWindowsNetstatAno(raw: string): RawNetworkConnection[] {
  const lines = raw.trim().split('\n')
  const connections: RawNetworkConnection[] = []

  for (const line of lines) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 4) continue

    const protocol = cols[0].toLowerCase()
    if (protocol !== 'tcp' && protocol !== 'udp') continue

    const localRaw = cols[1]
    const remoteRaw = cols[2]
    const state = protocol === 'tcp' ? (cols[3] || '') : ''
    const pidStr = protocol === 'tcp' ? cols[4] : cols[3]
    const pid = Number.parseInt(pidStr || '0', 10)
    if (!Number.isFinite(pid) || pid <= 0) continue

    const local = splitWindowsEndpoint(localRaw)
    const remote = splitWindowsEndpoint(remoteRaw)
    const scope = classifyNetworkScope(local.address, remote.address)

    const connection = {
      processName: `pid-${pid}`,
      pid,
      protocol,
      state,
      localAddress: local.address,
      localPort: local.port,
      remoteAddress: remote.address,
      remotePort: remote.port,
      scope,
      bytesIn: 0,
      bytesOut: 0
    }

    connections.push({
      ...connection,
      id: buildConnectionId(connection)
    })
  }

  return connections
}

/**
 * Split a Windows netstat endpoint like "192.168.1.5:443" or "[::1]:8080" or "0.0.0.0:0".
 */
function splitWindowsEndpoint(raw: string): { address: string; port: number | null } {
  const trimmed = raw.trim()
  if (!trimmed || trimmed === '*:*') {
    return { address: '*', port: null }
  }

  // IPv6 bracket notation: [::1]:port
  const ipv6Match = trimmed.match(/^\[(.+)]:(\d+)$/)
  if (ipv6Match) {
    return {
      address: ipv6Match[1],
      port: Number.parseInt(ipv6Match[2], 10)
    }
  }

  // IPv4: last colon separates address:port
  const lastColon = trimmed.lastIndexOf(':')
  if (lastColon === -1) return { address: trimmed, port: null }

  const address = trimmed.slice(0, lastColon) || '*'
  const portStr = trimmed.slice(lastColon + 1)
  const port = /^\d+$/.test(portStr) ? Number.parseInt(portStr, 10) : null
  return { address, port }
}

async function resolveWindowsPidNames(pids: Set<number>): Promise<Map<number, string>> {
  const pidMap = new Map<number, string>()
  if (pids.size === 0) return pidMap

  try {
    const { stdout } = await execAsync(
      'powershell.exe -NoProfile -Command "Get-Process | Select-Object Id,ProcessName | Format-Table -HideTableHeaders -AutoSize"',
      { timeout: 5000 }
    )
    for (const line of stdout.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/)
      if (match) {
        const pid = parseInt(match[1], 10)
        if (pids.has(pid)) pidMap.set(pid, match[2].trim())
      }
    }
  } catch {
    // fallback: names stay as pid-XXXX
  }

  return pidMap
}

async function tryWindowsNetstat(): Promise<{
  totals: RawNetworkEntry[] | null
  connections: RawNetworkConnection[]
}> {
  let totals: RawNetworkEntry[] | null = null
  let connections: RawNetworkConnection[] = []

  try {
    const { stdout } = await execAsync('netstat -e', { timeout: 5000 })
    const parsed = parseWindowsNetstatE(stdout)
    if (parsed) {
      totals = [
        {
          name: 'System (all interfaces)',
          pid: interfacePid('windows-netstat'),
          bytesIn: parsed.bytesIn,
          bytesOut: parsed.bytesOut
        }
      ]
    }
  } catch {
    // netstat -e failed
  }

  try {
    const { stdout } = await execAsync('netstat -ano', { timeout: 5000 })
    connections = parseWindowsNetstatAno(stdout)

    // Resolve PID -> process name
    const pids = new Set(connections.map((c) => c.pid))
    const nameMap = await resolveWindowsPidNames(pids)
    for (const conn of connections) {
      const name = nameMap.get(conn.pid)
      if (name) conn.processName = name
    }
  } catch {
    // netstat -ano failed
  }

  return { totals, connections }
}

async function tryNettop(): Promise<RawNettopSnapshot | null> {
  try {
    const { stdout } = await execAsync('nettop -n -x -L 1 -J state,bytes_in,bytes_out', {
      timeout: 8000
    })
    const snapshot = parseNettopSnapshot(stdout)
    if (snapshot.processes.length > 0) return snapshot
    return null
  } catch {
    return null
  }
}

async function tryNetstat(): Promise<RawNetworkEntry[] | null> {
  try {
    const { stdout } = await execAsync('netstat -ib', { timeout: 3000 })
    const ifaces = parseNetstatOutput(stdout)
    if (ifaces.length === 0) return null
    return mapNetstatEntries(ifaces)
  } catch {
    return null
  }
}

async function buildNetstatFallbackState(initialEntries: RawNetworkEntry[]): Promise<NetworkState> {
  const firstTimestamp = Date.now()
  const firstSnapshot = buildSnapshot(initialEntries, [], firstTimestamp)

  await delay(2000)

  const secondEntries = await tryNetstat()
  if (!secondEntries) {
    previousSnapshot = firstSnapshot
    return buildNetworkState(initialEntries, [], firstTimestamp, 'netstat')
  }

  const secondTimestamp = Date.now()
  const { state, snapshot } = buildNetworkStateFromSnapshot(
    firstSnapshot,
    secondEntries,
    [],
    secondTimestamp,
    'netstat'
  )
  previousSnapshot = snapshot
  return state
}

export async function getNetworkActivity(): Promise<NetworkState> {
  const now = Date.now()

  if (!isMacOS() && !isWindows()) {
    return {
      processes: [],
      connections: [],
      totalBytesInPerSec: 0,
      totalBytesOutPerSec: 0,
      timestamp: now,
      sourceMode: 'unavailable'
    }
  }

  if (isWindows()) {
    const { totals, connections } = await tryWindowsNetstat()
    if (totals) {
      return buildNetworkState(totals, connections, now, 'netstat')
    }
    return {
      processes: [],
      connections: [],
      totalBytesInPerSec: 0,
      totalBytesOutPerSec: 0,
      timestamp: now,
      sourceMode: 'unavailable',
      error: 'Network monitoring unavailable - netstat failed on Windows'
    }
  }

  let nettopSnapshot: RawNettopSnapshot | null = null
  if (!nettopFailed) {
    nettopSnapshot = await tryNettop()
  }

  let netstatEntries: RawNetworkEntry[] | null = null
  if (!nettopSnapshot || !hasUsableNettopData(nettopSnapshot.processes)) {
    nettopFailed = true
    netstatEntries = await tryNetstat()
  }

  const selected = selectNetworkSource(nettopSnapshot, netstatEntries)
  if (selected.processes) {
    if (selected.mode === 'netstat') {
      return buildNetstatFallbackState(selected.processes)
    }

    return buildNetworkState(
      selected.processes,
      selected.connections ?? [],
      now,
      selected.mode
    )
  }

  return {
    processes: [],
    connections: [],
    totalBytesInPerSec: 0,
    totalBytesOutPerSec: 0,
    timestamp: now,
    sourceMode: 'unavailable',
    error: 'Network monitoring unavailable - nettop and netstat both failed'
  }
}

export function resetNetworkState(): void {
  previousSnapshot = null
  nettopFailed = false
}

export function _computeNetworkState(rawOutput: string, timestamp: number): NetworkState {
  const snapshot = parseNettopSnapshot(rawOutput)
  const aggregated = aggregateByPid(snapshot.processes)
  return buildNetworkState(aggregated, snapshot.connections, timestamp, 'nettop')
}

export function _computeNetworkStateFromEntries(
  previousEntries: RawNetworkEntry[],
  currentEntries: RawNetworkEntry[],
  elapsedMs: number,
  now: number
): NetworkState {
  const baseline = buildSnapshot(previousEntries, [], now - elapsedMs)
  return buildNetworkStateFromSnapshot(baseline, currentEntries, [], now, 'netstat').state
}
