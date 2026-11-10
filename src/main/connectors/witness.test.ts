import { createHash } from 'node:crypto'
import { mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readConnectorHealth } from './witness'

const NOW = Date.parse('2026-11-10T14:00:00.000Z')
const HASH = 'a'.repeat(64)
const SERVER = { name: 'filesystem', cmd_sha256: HASH }
const HTTP_SERVER = { name: 'calendar', transport: 'http', upstream_sha256: HASH }
const SESSION = 's_01234567'
type Event = { event: string; [key: string]: unknown }

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => [key, ordered(item)])
  )
}

function journal(id: string, events: Event[], start = NOW - 10_000): string {
  let prev = 'GENESIS'
  return events
    .map((event, seq) => {
      const body = {
        v: '0.1',
        seq,
        ts: new Date(start + seq * 1000).toISOString(),
        session: id,
        ...event,
        prev
      }
      const hash = createHash('sha256')
        .update(JSON.stringify(ordered(body)) + prev)
        .digest('hex')
      prev = hash
      return JSON.stringify({ ...body, hash }) + '\n'
    })
    .join('')
}

function start(server: typeof SERVER | typeof HTTP_SERVER = SERVER): Event {
  return { event: 'session_start', server, pid: 345, principal: { as: 'person@example.invalid' } }
}

function call(id: string | number, server: typeof SERVER | typeof HTTP_SERVER = SERVER): Event {
  return {
    event: 'tool_call',
    rpc_id: id,
    tool: 'read_file',
    server,
    args_sha256: HASH,
    args_bytes: 19,
    args_summary: { message: 'private fixture payload' }
  }
}

function result(id: string | number, seq: number, code?: number): Event {
  return {
    event: 'tool_result',
    rpc_id: id,
    call_seq: seq,
    tool: 'read_file',
    outcome: {
      status: code === undefined ? 'ok' : 'error',
      ms: 20,
      result_sha256: HASH,
      result_bytes: 19,
      code
    }
  }
}

function end(successful: number, failed = 0, unanswered = 0): Event {
  return {
    event: 'session_end',
    counts: { calls: successful + failed + unanswered, ok: successful, error: failed },
    unresolved: unanswered
  }
}

describe('Witness connector health', () => {
  let directory: string
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'helm-witness-test-'))
  })
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  function put(contents: string, id = SESSION) {
    return writeFile(join(directory, id + '.jsonl'), contents, { mode: 0o600 })
  }

  it('scores settled calls and returns an exact, safe failure reference', async () => {
    const contents = journal(SESSION, [
      start(),
      call(1),
      result(1, 1),
      call(1),
      result(1, 3, -32001),
      end(1, 1)
    ])
    await put(contents)
    const snapshot = await readConnectorHealth(directory, NOW)
    expect(snapshot).toMatchObject({
      sourceStatus: 'ready',
      skippedSessions: 0,
      scanLimited: false,
      rows: [
        {
          name: 'filesystem',
          transport: 'stdio',
          health: 'degraded',
          score: 50,
          successful: 1,
          failed: 1,
          unanswered: 0,
          inFlight: 0,
          lastAttemptAt: NOW - 7000,
          agents: [],
          failures: [
            {
              sessionId: SESSION,
              callSequence: 3,
              resultSequence: 4,
              tool: 'read_file',
              startedAt: NOW - 7000,
              durationMs: 20,
              outcome: 'failed',
              errorCode: -32001,
              chainHead: JSON.parse(contents.trimEnd().split('\n').at(-1)!).hash
            }
          ]
        }
      ]
    })
    expect(JSON.stringify(snapshot)).not.toMatch(
      /person@example|private fixture payload|args_summary/
    )
  })

  it('separates transport and fingerprints and masks endpoint or credential-shaped aliases', async () => {
    const http = { ...HTTP_SERVER, name: 'https://private.example.invalid/oauth' }
    const second = { ...SERVER, cmd_sha256: 'b'.repeat(64) }
    const secret = { ...SERVER, name: 'sk-fixtureKey0123456789' }
    const fixtures = [
      { id: SESSION, server: SERVER },
      { id: 's_01234568', server: second },
      { id: 's_01234569', server: http },
      { id: 's_01234560', server: secret }
    ]
    await Promise.all(
      fixtures.map(({ id, server }) =>
        put(journal(id, [start(server), call(1, server), result(1, 1), end(1)]), id)
      )
    )
    const { rows } = await readConnectorHealth(directory, NOW)
    expect(rows).toHaveLength(4)
    expect(new Set(rows.map((row) => row.id)).size).toBe(4)
    expect(rows.filter((row) => row.name === 'Private connector')).toHaveLength(2)
    expect(rows.every((row) => row.health === 'healthy' && row.score === 100)).toBe(true)
    expect(JSON.stringify(rows)).not.toMatch(/private\.example|fixtureKey/)
  })

  it('rejects tampered and malformed sessions, including overlapping RPC ID types', async () => {
    const valid = journal(SESSION, [start(), call(1), result(1, 1), end(1)])
    await put(valid.replace('read_file', 'read_other'))
    const invalidEvents = [
      [start(), call(1), call('1'), result('1', 2), end(2)],
      [start(), call(1), result('1', 1), end(1)],
      [start(), call(1), result(1, 3), end(1)],
      [start(), call(1), result(1, 1), end(0)],
      [start(), call(1), result(1, 1), end(1), call(2)],
      [start(), call(1), { ...result(1, 1), signer: {} }, end(1)]
    ]
    for (const [index, events] of invalidEvents.entries()) {
      const id = 's_012345' + String(70 + index)
      await put(journal(id, events), id)
    }
    const snapshot = await readConnectorHealth(directory, NOW)
    expect(snapshot.rows).toEqual([])
    expect(snapshot.skippedSessions).toBe(1 + invalidEvents.length)
  })

  it('recognizes the shutdown string ID Witness emits for a numeric unanswered call', async () => {
    await put(
      journal(SESSION, [
        start(),
        call(2),
        {
          event: 'tool_result',
          rpc_id: '2',
          call_seq: 1,
          tool: 'read_file',
          outcome: { status: 'unknown', reason: 'server exited before responding', ms: 41 }
        },
        end(0, 0, 1)
      ])
    )
    const agent = vi.fn()
    const snapshot = await readConnectorHealth(directory, NOW, agent)
    expect(agent).not.toHaveBeenCalled()
    expect(snapshot.rows[0]).toMatchObject({
      unanswered: 1,
      inFlight: 0,
      health: 'degraded',
      score: 0,
      failures: [{ callSequence: 1, resultSequence: 2, durationMs: 41, outcome: 'unanswered' }]
    })
  })

  it('only attributes open stdio activity, with a short grace for pending calls without a match', async () => {
    await put(journal(SESSION, [start(), call(1)]))
    const http = 's_01234568'
    await put(journal(http, [start(HTTP_SERVER), call(2, HTTP_SERVER)]), http)
    const findAgent = vi.fn(() => ({ name: 'Codex agent', pid: 342 }))
    const observed = await readConnectorHealth(directory, NOW, findAgent)
    expect(findAgent).toHaveBeenCalledExactlyOnceWith(345, NOW - 10_000)
    expect(observed.rows.find((row) => row.transport === 'stdio')).toMatchObject({
      inFlight: 1,
      score: null,
      health: 'unknown',
      agents: [{ name: 'Codex agent', pid: 342, inFlight: true }]
    })
    expect(observed.rows.find((row) => row.transport === 'http')).toMatchObject({
      inFlight: 1,
      agents: []
    })
    const later = await readConnectorHealth(directory, NOW + 60_000)
    expect(later.rows.every((row) => row.inFlight === 0 && row.unanswered === 1)).toBe(true)
  })

  it('expires an attributed pending call and replaces the estimate when its reply arrives', async () => {
    const findAgent = () => ({ name: 'Codex', pid: 342 })
    await put(journal(SESSION, [start(), call(1)]))
    const before = await readConnectorHealth(directory, NOW + 590_000, findAgent)
    expect(before.rows[0]).toMatchObject({ inFlight: 1, unanswered: 0 })

    const after = await readConnectorHealth(directory, NOW + 592_000, findAgent)
    expect(after.rows[0]).toMatchObject({
      inFlight: 0,
      unanswered: 1,
      score: 0,
      agents: [{ pid: 342, inFlight: false }],
      failures: [{ callSequence: 1, outcome: 'unanswered' }]
    })
    expect(after.rows[0].failures[0].resultSequence).toBeUndefined()

    const replyAt = NOW + 593_000
    await put(
      journal(SESSION, [start(), call(1), { ...result(1, 1), ts: new Date(replyAt).toISOString() }])
    )
    const replied = await readConnectorHealth(directory, replyAt, findAgent)
    expect(replied.rows[0]).toMatchObject({
      inFlight: 0,
      unanswered: 0,
      successful: 1,
      score: 100,
      failures: []
    })
  })

  it('keeps stale observations unknown and omits non-MCP wrapper inventory', async () => {
    await put(journal(SESSION, [start(), call(1), result(1, 1), end(1)], NOW - 3_700_000))
    const idle = 's_01234568'
    await put(
      journal(idle, [
        start({ ...SERVER, name: 'idle_connector' }),
        { event: 'session_client', actor: { client: 'Synthetic', protocol: '2025-03-26' } }
      ]),
      idle
    )
    const wrapper = 's_01234569'
    await put(journal(wrapper, [start({ ...SERVER, name: 'gh' }), end(0)]), wrapper)
    const findAgent = vi.fn()
    const snapshot = await readConnectorHealth(directory, NOW, findAgent)
    expect(findAgent).not.toHaveBeenCalled()
    expect(snapshot.rows).toMatchObject([
      { name: 'filesystem', health: 'unknown', score: null, successful: 1 },
      { name: 'idle_connector', health: 'unknown', score: null, lastAttemptAt: null }
    ])
  })

  it('uses settled samples for freshness and ignores future sessions', async () => {
    await put(journal(SESSION, [start(), call(1), result(1, 1), end(1)], NOW - 3_700_000))
    const pending = 's_01234568'
    await put(journal(pending, [start(), call(2)]), pending)
    const future = 's_01234569'
    await put(journal(future, [start(HTTP_SERVER), call(1, HTTP_SERVER)], NOW + 10_000), future)
    const { rows } = await readConnectorHealth(directory, NOW)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      health: 'unknown',
      score: null,
      successful: 1,
      inFlight: 1,
      lastAttemptAt: NOW - 9000
    })
  })

  it('uses a verified complete prefix during an append and rejects extra bytes after a seal', async () => {
    const prefix = journal(SESSION, [start(), call(1), result(1, 1)])
    await put(prefix + '{"v":"0.1","seq":')
    const first = await readConnectorHealth(directory, NOW)
    expect(first).toMatchObject({
      skippedSessions: 0,
      scanLimited: true,
      rows: [{ successful: 1 }]
    })
    await put(journal(SESSION, [start(), call(1), result(1, 1), end(1)]) + '{"v":"0.1"')
    const second = await readConnectorHealth(directory, NOW)
    expect(second).toMatchObject({ skippedSessions: 1, rows: [] })
  })

  it('finds recent evidence beyond the first 512 directory entries', async () => {
    const oldTime = new Date(NOW - 48 * 60 * 60 * 1000)
    for (let i = 0; i < 520; i++) {
      const path = join(directory, `s_${i.toString(16).padStart(8, '0')}.jsonl`)
      await writeFile(path, 'old records outside the window', { mode: 0o600 })
      await utimes(path, oldTime, oldTime)
    }
    await put(journal(SESSION, [start(), call(1), result(1, 1), end(1)]))
    expect(await readConnectorHealth(directory, NOW)).toMatchObject({
      skippedSessions: 0,
      scanLimited: false,
      rows: [{ successful: 1 }]
    })
  })

  it('ignores other Witness-compatible formats and rejects symlinks and oversized records', async () => {
    const contents = journal(SESSION, [start(), call(1), result(1, 1), end(1)])
    await put(contents)
    await symlink(join(directory, SESSION + '.jsonl'), join(directory, 's_01234568.jsonl'))
    await put('a'.repeat(300_000), 's_01234569')
    await put('not a proxy log', 'op_01234567')
    const snapshot = await readConnectorHealth(directory, NOW)
    expect(snapshot).toMatchObject({
      sourceStatus: 'ready',
      skippedSessions: 2,
      scanLimited: true,
      rows: [{ successful: 1 }]
    })
  })
})
