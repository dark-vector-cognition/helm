import { EventEmitter } from 'node:events'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ManagedHive } from './managed'
import type { HiveSessionInfo, HiveSpawnRequest } from '../../shared/types'

const { mockFork } = vi.hoisted(() => ({ mockFork: vi.fn() }))
vi.mock('child_process', () => ({ fork: mockFork }))

class Worker extends EventEmitter {
  send = vi.fn((_message: unknown, callback?: () => void) => callback?.())
}

let root: string
let workspace: string
let directory: string
let workers: Worker[]

function request(overrides: Partial<HiveSpawnRequest> = {}): HiveSpawnRequest {
  return { provider: 'codex', role: 'analyst', workingDir: workspace, objective: 'Inspect sample.txt', ...overrides }
}

function start(hive: ManagedHive, overrides: Partial<HiveSpawnRequest> = {}): { id: string; worker: Worker } {
  const result = hive.launch(request(overrides))
  expect(result.success).toBe(true)
  return { id: result.session!.id, worker: workers.at(-1)! }
}

function event(worker: Worker, value: unknown): void {
  worker.emit('message', { type: 'event', event: value })
}

function complete(worker: Worker): void {
  event(worker, { type: 'item.completed', item: { type: 'agent_message', text: 'sample.txt verified' } })
  event(worker, { type: 'turn.completed', usage: { input_tokens: 4, output_tokens: 3 } })
  worker.emit('message', { type: 'exit', code: 0 })
  worker.emit('exit', 0)
}

function journals(count: number, state: 'reviewed' | 'needs-review' = 'reviewed'): string[] {
  mkdirSync(directory, { mode: 0o700 })
  return Array.from({ length: count }, (_, index) => {
    const id = `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`
    const run: HiveSessionInfo = {
      id, provider: 'codex', role: 'analyst', model: 'default', tmuxSession: '', tmuxWindow: '',
      workingDir: workspace, objective: 'Saved objective', permissionMode: 'read-only',
      startedAt: count - index, lastEventAt: index + 1000, status: 'idle', taskState: state, result: 'Saved result'
    }
    const file = join(directory, `${id}.json`)
    writeFileSync(file, JSON.stringify(run), { mode: 0o600 })
    utimesSync(file, index + 1000, index + 1000)
    return id
  })
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'helm-managed-test-')))
  workspace = join(root, 'workspace')
  directory = join(root, 'runs')
  mkdirSync(workspace)
  workers = []
  mockFork.mockReset().mockImplementation(() => {
    const worker = new Worker()
    workers.push(worker)
    return worker
  })
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

describe('managed agent lifecycle', () => {
  it('requires task acknowledgement, strong completion, zero exit, and explicit operator review', () => {
    const updates = vi.fn()
    const hive = new ManagedHive(directory, '/worker.js', updates)
    const { id, worker } = start(hive)
    const message = worker.send.mock.calls[0][0] as Record<string, unknown>
    expect(message).toMatchObject({ type: 'start', command: 'codex', cwd: workspace, input: expect.stringContaining('Inspect sample.txt'), timeoutSeconds: 120 })
    expect(message.args).not.toContain('Inspect sample.txt')
    expect(hive.list()[0]).toMatchObject({ id, taskState: 'starting', permissionMode: 'read-only', model: 'default' })
    worker.emit('message', { type: 'spawn', pid: 1234 })
    event(worker, { type: 'thread.started', thread_id: 'example' })
    expect(hive.list()[0]).toMatchObject({ pid: 1234, taskState: 'starting' })
    expect(hive.list()[0].acceptedAt).toBeUndefined()
    event(worker, { type: 'turn.started' })
    expect(hive.list()[0].taskState).toBe('working')
    expect(hive.list()[0].acceptedAt).toBeTypeOf('number')
    event(worker, { type: 'item.completed', item: { type: 'agent_message', text: 'sample.txt verified' } })
    expect(hive.list()[0].taskState).toBe('working')
    event(worker, { type: 'turn.completed', usage: {} })
    expect(hive.list()[0].taskState).toBe('working')
    worker.emit('message', { type: 'exit', code: 0 })
    worker.emit('exit', 0)
    expect(hive.list()[0]).toMatchObject({ taskState: 'needs-review', result: 'sample.txt verified' })
    expect(hive.review(id).success).toBe(true)
    expect(hive.list()[0].taskState).toBe('reviewed')
    expect(updates).toHaveBeenCalled()
    expect(lstatSync(directory).mode & 0o077).toBe(0)
    expect(lstatSync(join(directory, `${id}.json`)).mode & 0o077).toBe(0)
    expect(JSON.parse(readFileSync(join(directory, `${id}.json`), 'utf8')).taskState).toBe('reviewed')
  })

  it.each(['no-result', 'nonzero', 'provider-error'] as const)('fails closed for %s', (failure) => {
    const hive = new ManagedHive(directory, '/worker.js')
    const { worker } = start(hive)
    event(worker, { type: 'turn.started' })
    if (failure !== 'no-result') event(worker, { type: 'item.completed', item: { type: 'agent_message', text: 'Looks good' } })
    if (failure === 'provider-error') event(worker, { type: 'turn.failed', error: { message: 'Provider denied this request' } })
    else event(worker, { type: 'turn.completed', usage: {} })
    worker.emit('message', { type: 'exit', code: failure === 'nonzero' ? 1 : 0 })
    expect(hive.list()[0].taskState).toBe('failed')
    expect(hive.list()[0].error).toBeTypeOf('string')
    expect(hive.review(hive.list()[0].id).success).toBe(false)
  })

  it('keeps stop pending until provider exit and ignores subsequent success events', () => {
    const hive = new ManagedHive(directory, '/worker.js')
    const { id, worker } = start(hive)
    expect(hive.stop(id).success).toBe(true)
    expect(hive.list()[0].taskState).toBe('stopping')
    expect(worker.send).toHaveBeenCalledWith({ type: 'stop' }, expect.any(Function))
    event(worker, { type: 'item.completed', item: { type: 'agent_message', text: 'Too late' } })
    event(worker, { type: 'turn.completed', usage: {} })
    expect(hive.list()[0].result).toBeUndefined()
    worker.emit('message', { type: 'exit', stopped: true, error: 'Stopped by operator', code: null })
    expect(hive.list()[0].taskState).toBe('stopped')
    expect(hive.retry(id).success).toBe(false)
    worker.emit('exit', 0)
    expect(hive.stop(id).success).toBe(false)
  })

  it('creates a fresh retry with the original workspace, permission and lineage', () => {
    const hive = new ManagedHive(directory, '/worker.js')
    const { id, worker } = start(hive, { provider: 'claude-code', permissionMode: 'workspace-write', model: 'haiku', timeoutSeconds: 30 })
    expect(hive.retry(id).success).toBe(false)
    worker.emit('message', { type: 'exit', code: 1 })
    worker.emit('exit', 0)
    const retried = hive.retry(id)
    expect(retried.success).toBe(true)
    expect(retried.session).toMatchObject({ provider: 'claude-code', model: 'haiku', parentSessionId: id, permissionMode: 'workspace-write', workingDir: workspace, timeoutSeconds: 30 })
    expect(retried.session!.id).not.toBe(id)
  })

  it('marks an unexpected supervisor disconnect interrupted and a missing executable failed', () => {
    const hive = new ManagedHive(directory, '/worker.js')
    const first = start(hive)
    first.worker.emit('exit', 1)
    expect(hive.list().find((run) => run.id === first.id)?.taskState).toBe('interrupted')
    const second = start(hive)
    second.worker.emit('message', { type: 'error', error: 'Provider could not start. Check its executable and sign-in.' })
    second.worker.emit('message', { type: 'exit', code: -2 })
    expect(hive.list().find((run) => run.id === second.id)).toMatchObject({ taskState: 'failed', error: 'Provider could not start. Check its executable and sign-in.' })
  })

  it('limits concurrent workers and releases capacity only after worker exit', () => {
    const hive = new ManagedHive(directory, '/worker.js')
    const first = start(hive)
    start(hive)
    start(hive)
    expect(hive.launch(request()).success).toBe(false)
    complete(first.worker)
    expect(hive.launch(request()).success).toBe(true)
  })

  it('returns detached snapshots that callers cannot mutate', () => {
    const hive = new ManagedHive(directory, '/worker.js')
    const { id } = start(hive)
    const snapshot = hive.list()[0]
    snapshot.objective = 'tampered'
    snapshot.events![0].message = 'tampered'
    expect(hive.list()[0].objective).toBe('Inspect sample.txt')
    expect(hive.list()[0].events![0].message).not.toBe('tampered')
    expect(hive.has(id)).toBe(true)
    expect(hive.has('absent')).toBe(false)
  })

  it('projects telemetry and announces updates without cloning full run history', () => {
    const updates = vi.fn()
    const hive = new ManagedHive(directory, '/worker.js', updates)
    const { id, worker } = start(hive)
    const clone = vi.spyOn(globalThis, 'structuredClone')
    try {
      worker.emit('message', { type: 'spawn', pid: 1234 })
      event(worker, { type: 'turn.started' })
      const agent = hive.agents()[0]
      expect(agent).toMatchObject({ id: `hive:${id}`, status: 'active', pid: 1234, workingDir: workspace })
      expect(agent).not.toHaveProperty('objective')
      expect(agent).not.toHaveProperty('result')
      expect(agent).not.toHaveProperty('events')
      expect(updates).toHaveBeenLastCalledWith()
      expect(clone).not.toHaveBeenCalled()
      agent.currentAction = 'tampered'
      expect(hive.agents()[0].currentAction).not.toBe('tampered')
    } finally { clone.mockRestore() }
    expect(hive.list()[0].objective).toBe('Inspect sample.txt')
  })
})

describe('managed launch and journal boundaries', () => {
  it('reports unavailable managed launch on Windows before touching journals or forking', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const hive = new ManagedHive(directory, '/worker.js')
      expect(hive.launch(request())).toEqual({ success: false, error: 'Managed launch currently requires macOS or Linux process groups.' })
      expect(hive.list()).toEqual([])
      expect(mockFork).not.toHaveBeenCalled()
      expect(readdirSync(root)).toEqual(['workspace'])
    } finally { Object.defineProperty(process, 'platform', platform) }
  })

  it('recovers the newest 500 safe journals by modification time without deleting older files', () => {
    const ids = journals(501)
    const hive = new ManagedHive(directory, '/worker.js')
    expect(hive.list()).toHaveLength(500)
    expect(hive.has(ids[0])).toBe(false)
    expect(hive.has(ids.at(-1)!)).toBe(true)
    expect(readdirSync(directory)).toHaveLength(501)
  })

  it('bounds completed history in memory while retaining active and pending-review runs', () => {
    const ids = journals(500)
    const pendingFile = join(directory, `${ids[0]}.json`)
    const pending = JSON.parse(readFileSync(pendingFile, 'utf8'))
    writeFileSync(pendingFile, JSON.stringify({ ...pending, taskState: 'needs-review' }))
    const hive = new ManagedHive(directory, '/worker.js')
    const first = start(hive)
    const second = start(hive)
    expect(hive.list()).toHaveLength(500)
    expect(hive.has(ids[0])).toBe(true)
    expect(hive.has(ids[1])).toBe(false)
    expect(hive.has(ids[2])).toBe(false)
    expect(hive.has(first.id)).toBe(true)
    expect(hive.has(second.id)).toBe(true)
    expect(readdirSync(directory)).toHaveLength(502)
  })

  it('preserves pending review above the history limit until the operator reviews a result', () => {
    const ids = journals(500, 'needs-review')
    const hive = new ManagedHive(directory, '/worker.js')
    const active = start(hive)
    expect(hive.list()).toHaveLength(501)
    expect(hive.has(ids[0])).toBe(true)
    expect(hive.has(active.id)).toBe(true)
    expect(hive.review(ids[0]).success).toBe(true)
    expect(hive.list()).toHaveLength(500)
    expect(readdirSync(directory)).toHaveLength(501)
    expect(JSON.parse(readFileSync(join(directory, `${ids[0]}.json`), 'utf8')).taskState).toBe('reviewed')
  })

  it.each([
    { objective: '' }, { objective: ' '.repeat(10) }, { objective: 'x'.repeat(16001) },
    { provider: 'unknown' }, { permissionMode: 'unsafe' }, { workingDir: 'relative' },
    { workingDir: '/does-not-exist-helm-test' }, { timeoutSeconds: 9 }, { timeoutSeconds: 601 },
    { timeoutSeconds: NaN }, { timeoutSeconds: 10.5 }, { role: 'x'.repeat(81) }, { provider: 'claude-code', model: 'untrusted' }
  ])('rejects malformed input before forking: %j', (invalid) => {
    const hive = new ManagedHive(directory, '/worker.js')
    expect(hive.launch(request(invalid as Partial<HiveSpawnRequest>)).success).toBe(false)
    expect(mockFork).not.toHaveBeenCalled()
    expect(hive.list()).toHaveLength(0)
  })

  it('rejects an unsafe run directory and a symlink instead of using them', () => {
    mkdirSync(directory, { mode: 0o755 })
    expect(() => new ManagedHive(directory, '/worker.js')).toThrow('private')
    rmSync(directory, { recursive: true })
    const target = join(root, 'target')
    mkdirSync(target, { mode: 0o700 })
    symlinkSync(target, directory)
    expect(() => new ManagedHive(directory, '/worker.js')).toThrow('symlink')
  })

  it('reclassifies a saved active run as interrupted and requires a retry delay', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-18T18:00:00Z'))
    const hive = new ManagedHive(directory, '/worker.js')
    const { id } = start(hive)
    mockFork.mockClear()
    const restored = new ManagedHive(directory, '/worker.js')
    expect(restored.list()[0]).toMatchObject({ id, taskState: 'interrupted', status: 'dead' })
    expect(restored.list()[0].finishedAt).toBeTypeOf('number')
    expect(restored.retry(id).success).toBe(false)
    expect(mockFork).not.toHaveBeenCalled()
    vi.advanceTimersByTime(5000)
    expect(restored.retry(id).success).toBe(true)
  })

  it('ignores corrupt, public and symlinked run files', () => {
    const hive = new ManagedHive(directory, '/worker.js')
    const { id } = start(hive)
    const path = join(directory, `${id}.json`)
    const original = readFileSync(path, 'utf8')
    chmodSync(path, 0o644)
    expect(new ManagedHive(directory, '/worker.js').list()).toHaveLength(0)
    chmodSync(path, 0o600)
    writeFileSync(path, '{broken')
    expect(new ManagedHive(directory, '/worker.js').list()).toHaveLength(0)
    rmSync(path)
    const target = join(root, 'saved.json')
    writeFileSync(target, original, { mode: 0o600 })
    symlinkSync(target, path)
    expect(new ManagedHive(directory, '/worker.js').list()).toHaveLength(0)
  })

  it('does not launch when the initial private record cannot be persisted', () => {
    const hive = new ManagedHive(directory, '/worker.js')
    chmodSync(directory, 0o755)
    expect(hive.launch(request()).success).toBe(false)
    expect(mockFork).not.toHaveBeenCalled()
    expect(hive.list()[0].taskState).toBe('failed')
    expect(readdirSync(directory)).toEqual([])
  })

  it('stops execution when a later journal write fails', () => {
    const hive = new ManagedHive(directory, '/worker.js')
    const { worker } = start(hive)
    chmodSync(directory, 0o755)
    event(worker, { type: 'turn.started' })
    expect(hive.list()[0].taskState).toBe('failed')
    expect(hive.list()[0].error).toContain('Cannot save')
    expect(worker.send).toHaveBeenCalledWith({ type: 'stop' }, expect.any(Function))
    worker.emit('message', { type: 'exit', code: 0 })
    expect(hive.list()[0].taskState).toBe('failed')
  })
})
