import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, open, opendir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CONNECTOR_FRESH_MINUTES,
  CONNECTOR_WINDOW_HOURS,
  type ConnectorFailure,
  type ConnectorHealthRow,
  type ConnectorHealthSnapshot
} from '../../shared/connector-health'
import { resemblesCredential } from '../hive/evidence-safety'

const HOUR = 60 * 60 * 1000
const WINDOW = CONNECTOR_WINDOW_HOURS * HOUR
const FRESH = CONNECTOR_FRESH_MINUTES * 60 * 1000
const PENDING_GRACE = 30_000
const ATTRIBUTED_PENDING_LIMIT = 10 * 60_000
const MAX_DIRECTORY_ENTRIES = 100_000
const METADATA_BATCH = 64
const MAX_SESSIONS = 1024
const MAX_SCAN_BYTES = 16 * 1024 * 1024
const MAX_SESSION_BYTES = 256 * 1024
const MAX_RECORD_BYTES = 16 * 1024
const MAX_RECORDS = 4096
const MAX_ROWS = 32
const MAX_FAILURES = 5
const SESSION_FILE = /^(s_[a-f0-9]{8})\.jsonl$/
const DIGEST = /^[a-f0-9]{64}$/
const ALIAS = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/
const AGENT_LABEL = /^[A-Za-z][A-Za-z0-9 _-]{0,47}$/
const KNOWN_OTHER_EVENTS = new Set(['notification', 'raw', 'error', 'vote', 'grant', 'refusal'])

type RecordData = Record<string, unknown>
type Transport = ConnectorHealthRow['transport']
type RpcId = string | number
type AgentLookup = (
  serverPid: number,
  sessionStartedAt: number
) => { name: string; pid: number } | undefined
type Result = {
  sequence: number
  at: number
  status: 'ok' | 'error' | 'unknown'
  durationMs: number
  errorCode?: number
}
type Call = {
  sequence: number
  id: RpcId | null
  tool: string
  at: number
  result?: Result
}
type Session = {
  id: string
  connectorId: string
  name: string
  transport: Transport
  serverPid?: number
  startedAt: number
  closedAt?: number
  closing: boolean
  initializedAt?: number
  chainHead: string
  calls: Call[]
}

function object(value: unknown): RecordData {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as RecordData
}

function ensure(condition: unknown): asserts condition {
  if (!condition) throw new Error('Invalid Witness record')
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value)
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function canonical(value: unknown, depth = 0): string {
  ensure(depth <= 24)
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, depth + 1)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const fields = object(value)
    return `{${Object.keys(fields)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(fields[key], depth + 1)}`)
      .join(',')}}`
  }
  if (typeof value === 'number') ensure(Number.isFinite(value))
  return JSON.stringify(value)
}

function timestamp(value: unknown): number {
  ensure(typeof value === 'string' && value.length === 24)
  const time = Date.parse(value)
  ensure(Number.isFinite(time) && new Date(time).toISOString() === value)
  return time
}

function rpcId(value: unknown): RpcId | null {
  ensure(
    value === null ||
      (typeof value === 'string' && value.length <= 128) ||
      (typeof value === 'number' && Number.isSafeInteger(value))
  )
  return value
}

function safeAlias(value: string, fallback: string, pattern = ALIAS): string {
  return pattern.test(value) &&
    !resemblesCredential(value) &&
    !/^(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-|hf_)/i.test(value)
    ? value
    : fallback
}

function server(value: unknown): { name: string; transport: Transport; fingerprint: string } {
  const fields = object(value)
  const { name, transport, upstream_sha256: upstream, cmd_sha256: command } = fields
  ensure(typeof name === 'string' && name.length > 0 && name.length <= 256)
  if (transport === 'http') {
    ensure(isDigest(upstream) && command === undefined)
    return { name, transport, fingerprint: upstream }
  }
  ensure(
    (transport === undefined || transport === 'stdio') &&
      isDigest(command) &&
      upstream === undefined
  )
  return { name, transport: 'stdio', fingerprint: command }
}

function parseSession(id: string, text: string): Session {
  const lines = text.split('\n')
  ensure(lines.pop() === '' && lines.length > 0 && lines.length <= MAX_RECORDS)
  let previous = 'GENESIS'
  let previousAt = 0
  let identity: ReturnType<typeof server> | undefined
  let session: Session | undefined
  const pending = new Map<string, Call>()
  let successful = 0
  let failed = 0
  let unanswered = 0

  for (const [sequence, line] of lines.entries()) {
    ensure(Buffer.byteLength(line) <= MAX_RECORD_BYTES)
    const record = object(JSON.parse(line) as unknown)
    const { hash, ...body } = record
    ensure(
      isDigest(hash) &&
        record.v === '0.1' &&
        record.seq === sequence &&
        record.session === id &&
        record.prev === previous &&
        !Object.hasOwn(record, 'signer')
    )
    // Witness writes each complete line with JSON.stringify. Reject ambiguous duplicate keys.
    ensure(digest(canonical(body) + previous) === hash && JSON.stringify(record) === line)
    previous = hash
    const at = timestamp(record.ts)
    ensure(at >= previousAt && session?.closedAt === undefined)
    previousAt = at

    if (sequence === 0) {
      ensure(record.event === 'session_start')
      identity = server(record.server)
      session = {
        id,
        connectorId: digest(
          JSON.stringify([identity.name, identity.transport, identity.fingerprint])
        ),
        name: safeAlias(identity.name, 'Private connector'),
        transport: identity.transport,
        serverPid:
          identity.transport === 'stdio' && nonnegativeInteger(record.pid) && record.pid > 0
            ? record.pid
            : undefined,
        startedAt: at,
        closing: false,
        chainHead: hash,
        calls: []
      }
      continue
    }
    ensure(session && identity)
    if (record.event === 'tool_call') {
      ensure(
        !session.closing &&
          typeof record.tool === 'string' &&
          record.tool.length > 0 &&
          record.tool.length <= 256 &&
          isDigest(record.args_sha256) &&
          nonnegativeInteger(record.args_bytes)
      )
      const declaredServer = server(record.server)
      ensure(
        declaredServer.name === identity.name &&
          declaredServer.transport === identity.transport &&
          declaredServer.fingerprint === identity.fingerprint
      )
      const id = rpcId(record.rpc_id)
      const call = { sequence, id, tool: record.tool, at }
      if (id !== null) {
        // Witness uses String(id) for pending calls. Reject overlapping IDs it could have conflated.
        const key = String(id)
        ensure(!pending.has(key))
        pending.set(key, call)
      }
      session.calls.push(call)
    } else if (record.event === 'tool_result') {
      const resultId = rpcId(record.rpc_id)
      ensure(resultId !== null)
      const key = String(resultId)
      const call = pending.get(key)
      const outcome = object(record.outcome)
      ensure(
        call &&
          record.call_seq === call.sequence &&
          record.tool === call.tool &&
          nonnegativeInteger(outcome.ms)
      )
      const status = outcome.status
      const code = outcome.code
      if (status === 'unknown') {
        const reason =
          session.transport === 'http'
            ? 'proxy stopped before a response arrived'
            : 'server exited before responding'
        // Shutdown records contain the string key from Witness's map, even for a numeric request.
        ensure(resultId === key && outcome.reason === reason && code === undefined)
        session.closing = true
        unanswered += 1
      } else {
        ensure(
          !session.closing &&
            (status === 'ok' || status === 'error') &&
            resultId === call.id &&
            isDigest(outcome.result_sha256) &&
            nonnegativeInteger(outcome.result_bytes)
        )
        ensure(
          code === null || code === undefined || (status === 'error' && Number.isSafeInteger(code))
        )
        if (status === 'ok') successful += 1
        else failed += 1
      }
      call.result = {
        sequence,
        at,
        status,
        durationMs: outcome.ms,
        ...(typeof code === 'number' ? { errorCode: code } : {})
      }
      pending.delete(key)
    } else if (record.event === 'session_end') {
      const counts = object(record.counts)
      ensure(
        pending.size === 0 &&
          counts.calls === session.calls.length &&
          counts.ok === successful &&
          counts.error === failed &&
          record.unresolved === unanswered
      )
      session.closedAt = at
    } else if (record.event === 'session_client') {
      ensure(!session.closing)
      const { protocol } = object(record.actor)
      if (typeof protocol === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(protocol)) {
        session.initializedAt ??= at
      }
    } else {
      ensure(
        !session.closing && typeof record.event === 'string' && KNOWN_OTHER_EVENTS.has(record.event)
      )
    }
  }

  ensure(session)
  session.chainHead = previous
  return session
}

function privateOwner(stats: Stats): boolean {
  return (
    (stats.mode & 0o022) === 0 && (process.getuid === undefined || stats.uid === process.getuid())
  )
}

async function readSessionFile(
  path: string,
  expected: Stats,
  id: string
): Promise<{ session: Session; incomplete: boolean }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    ensure(
      before.isFile() &&
        before.nlink === 1 &&
        privateOwner(before) &&
        before.dev === expected.dev &&
        before.ino === expected.ino &&
        before.size >= expected.size
    )
    const bytes = Buffer.alloc(expected.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
      ensure(bytesRead > 0)
      offset += bytesRead
    }
    const after = await file.stat()
    ensure(
      after.size >= before.size && (after.size > before.size || after.mtimeMs === before.mtimeMs)
    )
    const end = bytes.lastIndexOf(10) + 1
    const incomplete = end < bytes.length || after.size > bytes.length
    ensure(end > 0)
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(0, end)
    )
    const session = parseSession(id, text)
    ensure(!incomplete || session.closedAt === undefined)
    return { session, incomplete }
  } finally {
    await file.close()
  }
}

function emptyRow(session: Session): ConnectorHealthRow {
  return {
    id: session.connectorId,
    name: session.name,
    transport: session.transport,
    health: 'unknown',
    score: null,
    successful: 0,
    failed: 0,
    unanswered: 0,
    inFlight: 0,
    lastAttemptAt: null,
    agents: [],
    failures: []
  }
}

type ConnectorSamples = { row: ConnectorHealthRow; lastSettledAt: number | null }

function addSession(
  samples: ConnectorSamples,
  session: Session,
  now: number,
  findAgent?: AgentLookup
): void {
  const { row } = samples
  const closed = session.closedAt !== undefined && session.closedAt <= now
  const observed = session.calls.filter((call) => call.at <= now && now - call.at <= WINDOW)
  const agent =
    !closed && !session.closing && observed.length > 0 && session.serverPid !== undefined
      ? findAgent?.(session.serverPid, session.startedAt)
      : undefined
  let inFlight = false
  // A live agent can outlast a canceled request.
  const pendingLimit = agent ? ATTRIBUTED_PENDING_LIMIT : PENDING_GRACE

  for (const call of observed) {
    row.lastAttemptAt = Math.max(row.lastAttemptAt ?? call.at, call.at)
    const result = call.result && call.result.at <= now ? call.result : undefined
    if (!result && !closed && now - call.at <= pendingLimit) {
      row.inFlight += 1
      inFlight = true
      continue
    }
    const settledAt = result?.at ?? (closed ? session.closedAt! : call.at)
    samples.lastSettledAt = Math.max(samples.lastSettledAt ?? settledAt, settledAt)
    if (result?.status === 'ok') {
      row.successful += 1
      continue
    }
    const outcome: ConnectorFailure['outcome'] =
      result?.status === 'error' ? 'failed' : 'unanswered'
    row[outcome] += 1
    row.failures.push({
      sessionId: session.id,
      callSequence: call.sequence,
      tool: safeAlias(call.tool, 'Private tool'),
      startedAt: call.at,
      outcome,
      chainHead: session.chainHead,
      ...(result ? { resultSequence: result.sequence, durationMs: result.durationMs } : {}),
      ...(result?.errorCode !== undefined ? { errorCode: result.errorCode } : {})
    })
    row.failures.sort((a, b) => b.startedAt - a.startedAt)
    if (row.failures.length > MAX_FAILURES) row.failures.pop()
  }

  if (agent && Number.isSafeInteger(agent.pid) && agent.pid > 0) {
    const existing = row.agents.find((entry) => entry.pid === agent.pid)
    if (existing) existing.inFlight ||= inFlight
    else
      row.agents.push({
        pid: agent.pid,
        name: safeAlias(agent.name, 'Local agent', AGENT_LABEL),
        inFlight
      })
  }
}

export async function readConnectorHealth(
  directory: string,
  now = Date.now(),
  findAgent?: AgentLookup
): Promise<ConnectorHealthSnapshot> {
  const snapshot: ConnectorHealthSnapshot = {
    sourceStatus: 'unavailable',
    checkedAt: now,
    skippedSessions: 0,
    scanLimited: false,
    rows: []
  }
  const candidates: { id: string; path: string; stats: Stats }[] = []
  try {
    const root = await lstat(directory)
    if (!root.isDirectory() || !privateOwner(root)) return snapshot
    const batch: { id: string; path: string }[] = []
    async function collect(): Promise<void> {
      await Promise.all(
        batch.splice(0).map(async ({ id, path }) => {
          const stats = await lstat(path).catch(() => undefined)
          if (stats && stats.mtimeMs < now - WINDOW) return
          if (!stats || !stats.isFile() || stats.nlink !== 1 || !privateOwner(stats)) {
            snapshot.skippedSessions += 1
          } else if (stats.size > MAX_SESSION_BYTES) {
            snapshot.skippedSessions += 1
            snapshot.scanLimited = true
          } else {
            candidates.push({ id, path, stats })
          }
        })
      )
    }
    let seen = 0
    for await (const entry of await opendir(directory, { bufferSize: 256 })) {
      if (seen++ === MAX_DIRECTORY_ENTRIES) {
        snapshot.scanLimited = true
        break
      }
      const match = SESSION_FILE.exec(entry.name)
      if (!match) continue
      batch.push({ id: match[1], path: join(directory, entry.name) })
      if (batch.length === METADATA_BATCH) await collect()
    }
    await collect()
    const after = await lstat(directory)
    if (!after.isDirectory() || after.dev !== root.dev || after.ino !== root.ino) return snapshot
    snapshot.sourceStatus = 'ready'
  } catch {
    return snapshot
  }

  candidates.sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs || a.id.localeCompare(b.id))
  if (candidates.length > MAX_SESSIONS) {
    snapshot.scanLimited = true
    snapshot.skippedSessions += candidates.length - MAX_SESSIONS
  }
  const connectors = new Map<string, ConnectorSamples>()
  let remainingBytes = MAX_SCAN_BYTES
  for (const { id, path, stats } of candidates.slice(0, MAX_SESSIONS)) {
    if (remainingBytes < stats.size) {
      snapshot.scanLimited = true
      break
    }
    remainingBytes -= stats.size
    try {
      const { session, incomplete } = await readSessionFile(path, stats, id)
      if (incomplete) snapshot.scanLimited = true
      if (
        session.startedAt > now ||
        ((session.initializedAt ?? Infinity) > now && !session.calls.some((call) => call.at <= now))
      )
        continue
      const samples = connectors.get(session.connectorId) ?? {
        row: emptyRow(session),
        lastSettledAt: null
      }
      addSession(samples, session, now, findAgent)
      connectors.set(samples.row.id, samples)
    } catch {
      snapshot.skippedSessions += 1
    }
  }

  for (const { row, lastSettledAt } of connectors.values()) {
    const settled = row.successful + row.failed + row.unanswered
    if (settled && lastSettledAt !== null && now - lastSettledAt <= FRESH) {
      row.score = Math.round((100 * row.successful) / settled)
      row.health = row.failed || row.unanswered ? 'degraded' : 'healthy'
    }
  }
  snapshot.scanLimited ||= connectors.size > MAX_ROWS
  snapshot.rows = [...connectors.values()]
    .map(({ row }) => row)
    .sort(
      (a, b) =>
        (b.lastAttemptAt ?? -1) - (a.lastAttemptAt ?? -1) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id)
    )
    .slice(0, MAX_ROWS)
  return snapshot
}
