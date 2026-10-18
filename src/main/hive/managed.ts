import { fork, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync, unlinkSync } from 'fs'
import { isAbsolute, join } from 'path'
import type { HiveProvider, HiveSessionInfo, HiveSpawnRequest, HiveSpawnResult, HiveTaskState } from '../../shared/types'
import { buildProviderCommand, parseProviderEvent } from './providers'

const ACTIVE = new Set<HiveTaskState>(['starting', 'working', 'stopping'])
const PROVIDERS: HiveProvider[] = ['claude-code', 'cursor', 'codex']
const STATES: HiveTaskState[] = ['starting', 'working', 'stopping', 'needs-review', 'reviewed', 'failed', 'stopped', 'interrupted']

export class ManagedHive {
  private runs = new Map<string, HiveSessionInfo>()
  private workers = new Map<string, ChildProcess>()
  private finished = new Set<string>()
  private recoveredAt = 0

  constructor(
    private directory: string,
    private workerPath: string,
    private onUpdate: (runs: HiveSessionInfo[]) => void = () => {},
    private claudeBinPath = 'claude'
  ) {
    if (process.platform === 'win32') return
    this.ensureDirectory()
    for (const name of readdirSync(directory).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name)).slice(0, 500)) {
      try {
        const path = join(directory, name)
        const stat = lstatSync(path)
        if (!stat.isFile() || stat.mode & 0o077 || stat.size > 128 * 1024) continue
        const run = JSON.parse(readFileSync(path, 'utf8')) as HiveSessionInfo
        if (run.id !== name.slice(0, -5) || !PROVIDERS.includes(run.provider!) || !STATES.includes(run.taskState!) ||
          typeof run.objective !== 'string' || run.objective.length > 16000 ||
          typeof run.workingDir !== 'string' || !isAbsolute(run.workingDir) ||
          !['read-only', 'workspace-write'].includes(run.permissionMode!) || !Number.isFinite(run.startedAt) || !['default', 'opus', 'sonnet', 'haiku'].includes(run.model) ||
          typeof run.role !== 'string' || run.role.length > 80 ||
          (run.result !== undefined && (typeof run.result !== 'string' || run.result.length > 32000)) ||
          (run.error !== undefined && typeof run.error !== 'string') ||
          (run.events !== undefined && (!Array.isArray(run.events) || run.events.length > 50 || run.events.some((event) =>
            !event || !Number.isFinite(event.at) || !STATES.includes(event.state) || typeof event.message !== 'string' || event.message.length > 300)))) continue
        this.runs.set(run.id, run)
        if (ACTIVE.has(run.taskState!)) {
          this.recoveredAt = Date.now()
          this.transition(run, 'interrupted', 'Helm restarted. The previous worker must stop before an explicit retry.')
          run.finishedAt = Date.now()
          this.store(run)
        }
      } catch { /* A damaged journal does not become a runnable task. */ }
    }
  }

  private ensureDirectory(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const stat = lstatSync(this.directory)
    if (!stat.isDirectory() || stat.mode & 0o077) throw new Error('Agent run directory must be private and must not be a symlink.')
  }

  list(): HiveSessionInfo[] {
    return structuredClone([...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt))
  }

  has(id: string): boolean { return this.runs.has(id) }

  private transition(run: HiveSessionInfo, state: HiveTaskState, message: string): void {
    run.taskState = state
    run.status = ACTIVE.has(state) ? 'running' : state === 'failed' || state === 'interrupted' ? 'dead' : 'idle'
    run.lastEventAt = Date.now()
    run.events = [...(run.events ?? []), { at: run.lastEventAt, state, message: message.slice(0, 300) }].slice(-50)
  }

  private store(run: HiveSessionInfo): boolean {
    const temporary = join(this.directory, `${run.id}.${randomUUID()}.tmp`)
    try {
      this.ensureDirectory()
      writeFileSync(temporary, JSON.stringify(run), { mode: 0o600, flag: 'wx' })
      renameSync(temporary, join(this.directory, `${run.id}.json`))
      this.onUpdate(this.list())
      return true
    } catch {
      this.transition(run, 'failed', 'Cannot save the private run record. Execution stopped.')
      run.error = 'Cannot save the private run record. Check disk space and directory permissions.'
      this.workers.get(run.id)?.send({ type: 'stop' }, () => {})
      this.onUpdate(this.list())
      return false
    } finally {
      try { unlinkSync(temporary) } catch { /* Renamed or absent. */ }
    }
  }

  launch(request: HiveSpawnRequest, parentSessionId?: string): HiveSpawnResult {
    try {
      if (process.platform === 'win32') throw new Error('Managed launch currently requires macOS or Linux process groups.')
      if (!request || !PROVIDERS.includes(request.provider!)) throw new Error('Choose Claude Code, Cursor or Codex.')
      if (request.permissionMode !== undefined && !['read-only', 'workspace-write'].includes(request.permissionMode)) throw new Error('Invalid permission mode.')
      if (request.model !== undefined && !['opus', 'sonnet', 'haiku'].includes(request.model)) throw new Error('Invalid model.')
      if (typeof request.role !== 'string' || request.role.length > 80) throw new Error('Invalid role.')
      if (typeof request.objective !== 'string' || !request.objective.trim() || request.objective.length > 16000) throw new Error('Enter an objective of at most 16000 characters.')
      if (typeof request.workingDir !== 'string' || !isAbsolute(request.workingDir)) throw new Error('Choose an absolute workspace directory.')
      const cwd = realpathSync(request.workingDir)
      if (!lstatSync(cwd).isDirectory()) throw new Error('Workspace is not a directory.')
      const seconds = request.timeoutSeconds ?? 120
      if (!Number.isInteger(seconds) || seconds < 10 || seconds > 600) throw new Error('Time limit must be 10 to 600 seconds.')
      if (this.workers.size >= 3) throw new Error('Three agents already run. Stop or wait before another launch.')
      const command = buildProviderCommand(request, this.claudeBinPath)
      const run: HiveSessionInfo = {
        id: randomUUID(), provider: request.provider, role: request.role, model: request.model ?? 'default',
        tmuxSession: '', tmuxWindow: '', workingDir: cwd, startedAt: Date.now(), status: 'running',
        taskState: 'starting', objective: request.objective.trim(), permissionMode: request.permissionMode ?? 'read-only',
        timeoutSeconds: seconds, parentSessionId
      }
      this.transition(run, 'starting', 'Launch requested. Provider has not acknowledged the task.')
      this.runs.set(run.id, run)
      if (!this.store(run)) return { success: false, error: run.error }
      const worker = fork(this.workerPath, [], {
        execPath: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc']
      })
      this.workers.set(run.id, worker)
      worker.on('message', (message) => this.receive(run, message))
      worker.once('error', () => {
        this.transition(run, 'failed', 'Supervisor could not start.')
        run.error = 'Supervisor could not start.'
        this.store(run)
      })
      worker.once('exit', () => {
        this.workers.delete(run.id)
        if (ACTIVE.has(run.taskState!)) {
          this.transition(run, 'interrupted', 'Supervisor disconnected before a terminal report.')
          run.error = 'Supervisor disconnected. Inspect workspace changes before retry.'
          run.finishedAt = Date.now()
          this.store(run)
        }
      })
      worker.send({ type: 'start', ...command, cwd, input: `Role: ${run.role}\nObjective:\n${run.objective}`, timeoutSeconds: seconds }, () => {})
      return { success: true, session: structuredClone(run) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Launch failed.' }
    }
  }

  private receive(run: HiveSessionInfo, raw: unknown): void {
    if (!raw || typeof raw !== 'object') return
    const message = raw as { type?: string; pid?: number; event?: unknown; error?: string; code?: number; stopped?: boolean }
    if (message.type === 'spawn' && Number.isInteger(message.pid)) run.pid = message.pid
    if (message.type === 'event') {
      const event = parseProviderEvent(run.provider!, message.event)
      if (!event || !ACTIVE.has(run.taskState!) || run.taskState === 'stopping') return
      if (event.accepted) {
        run.acceptedAt ??= Date.now()
        this.transition(run, 'working', event.activity ?? 'Provider acknowledged the task.')
      } else if (event.activity) this.transition(run, run.taskState!, event.activity)
      if (event.result) run.result = event.result.slice(0, 32000)
      if (event.error) run.error = event.error.slice(0, 1000)
      if (event.finished) this.finished.add(run.id)
    }
    if (message.type === 'error') run.error = message.error
    if (message.type === 'exit') {
      run.finishedAt = Date.now()
      if (run.taskState === 'failed') { /* Preserve journal or protocol failures. */ }
      else if (message.stopped) {
        const operatorStop = message.error === 'Stopped by operator'
        this.transition(run, operatorStop ? 'stopped' : 'failed', message.error ?? 'Agent stopped.')
        if (!operatorStop) run.error = message.error
      } else if (message.code === 0 && this.finished.has(run.id) && run.result && !run.error) {
        this.transition(run, 'needs-review', 'Provider returned a result. Operator review is required.')
      } else {
        this.transition(run, 'failed', 'Provider did not return a successful terminal result.')
        run.error ??= `Provider exited (${message.code ?? 'signal'}). Check sign-in, permissions and provider limits.`
      }
      this.finished.delete(run.id)
    }
    this.store(run)
  }

  stop(id: string): { success: boolean; error?: string } {
    const run = this.runs.get(id)
    const worker = this.workers.get(id)
    if (!run || !worker || !ACTIVE.has(run.taskState!)) return { success: false, error: 'No active managed agent for this run.' }
    this.transition(run, 'stopping', 'Stop requested. Wait for process exit confirmation.')
    this.store(run)
    worker.send({ type: 'stop' }, () => {})
    return { success: true }
  }

  retry(id: string): HiveSpawnResult {
    const run = this.runs.get(id)
    if (!run || !['failed', 'stopped', 'interrupted'].includes(run.taskState!)) return { success: false, error: 'Only failed, stopped or interrupted runs can be retried.' }
    if (this.workers.has(id) || Date.now() - this.recoveredAt < 5000) return { success: false, error: 'Previous worker is shutting down. Retry shortly.' }
    return this.launch({ provider: run.provider, permissionMode: run.permissionMode, workingDir: run.workingDir,
      role: run.role, model: run.model === 'default' ? undefined : run.model, objective: run.objective, timeoutSeconds: run.timeoutSeconds }, id)
  }

  review(id: string): { success: boolean; error?: string } {
    const run = this.runs.get(id)
    if (!run || run.taskState !== 'needs-review') return { success: false, error: 'No result awaits review.' }
    this.transition(run, 'reviewed', 'Operator marked the result reviewed.')
    return { success: this.store(run), error: run.error }
  }

  shutdown(): void {
    for (const [id] of this.workers) this.stop(id)
  }
}
