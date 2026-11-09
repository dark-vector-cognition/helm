import { fork, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync, unlinkSync } from 'fs'
import { isAbsolute, join, sep } from 'path'
import type {
  AgentInfo, HiveCommandEvidence, HiveProvider, HiveReviewEvidence, HiveReviewRequest,
  HiveSessionInfo, HiveSessionSummary, HiveSpawnRequest, HiveSpawnResult, HiveTaskState
} from '../../shared/types'
import { COMMAND_LENGTH_LIMIT, COMMAND_LIMIT } from './evidence-safety'
import { buildProviderCommand, parseProviderEvent } from './providers'

const ACTIVE = new Set<HiveTaskState>(['starting', 'working', 'stopping'])
const PROVIDERS: HiveProvider[] = ['claude-code', 'cursor', 'codex']
const STATES: HiveTaskState[] = ['starting', 'working', 'stopping', 'needs-review', 'reviewed', 'failed', 'stopped', 'interrupted']
const HISTORY_LIMIT = 500
const JOURNAL_LIMIT = 128 * 1024
const REVIEW_RESERVE = 4 * 1024
const REASON_LIMIT = 500
type CommandTrace = { commands: Map<string, HiveCommandEvidence | null>; partial: boolean }

function workspacesOverlap(first: string, second: string): boolean {
  const prefix = (directory: string) => directory.endsWith(sep) ? directory : directory + sep
  return first === second || first.startsWith(prefix(second)) || second.startsWith(prefix(first))
}

function gitUnavailable(reason: string): HiveReviewEvidence['git'] {
  return { status: 'unavailable', reason }
}

function validGitEvidence(value: unknown): value is HiveReviewEvidence['git'] {
  const git = value as HiveReviewEvidence['git'] | undefined
  if (!git) return false
  if (git.status === 'unavailable') return typeof git.reason === 'string' && git.reason.length <= 300
  return git.status === 'captured' && typeof git.baseCommit === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(git.baseCommit) &&
    typeof git.patch === 'string' && Buffer.byteLength(git.patch) <= 24 * 1024 && Array.isArray(git.untracked) &&
    git.untracked.every((path) => typeof path === 'string' && !!path) && Buffer.byteLength(JSON.stringify(git.untracked)) <= 16 * 1024
}

function validReviewReason(reason: unknown): boolean {
  return reason === undefined || (typeof reason === 'string' && reason.length <= REASON_LIMIT && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(reason))
}

function validReviewData(run: HiveSessionInfo): boolean {
  const { evidence, decision } = run
  if (evidence === undefined) return decision === undefined
  if (!evidence || typeof evidence.id !== 'string' || !/^[a-f0-9-]{36}$/.test(evidence.id) || !validGitEvidence(evidence.git) ||
    !['captured', 'partial', 'unavailable'].includes(evidence.commandCapture) || !Array.isArray(evidence.commands) ||
    evidence.commands.length > COMMAND_LIMIT || evidence.commands.some((item) => !item || typeof item.command !== 'string' ||
      !item.command || item.command.length > COMMAND_LENGTH_LIMIT || typeof item.isTest !== 'boolean' ||
      (item.exitCode !== null && !Number.isSafeInteger(item.exitCode)))) return false
  return decision === undefined || (!!decision && run.taskState === 'reviewed' && decision.evidenceId === evidence.id &&
    Number.isFinite(decision.at) && Number.isFinite(new Date(decision.at).getTime()) && validReviewReason(decision.reason) &&
    (decision.outcome === 'accepted' || (decision.outcome === 'follow-up-requested' && !!decision.reason?.trim())))
}

export class ManagedHive {
  private runs = new Map<string, HiveSessionInfo>()
  private workers = new Map<string, ChildProcess>()
  private finished = new Set<string>()
  private commandTraces = new Map<string, CommandTrace>()
  private overlappingRuns = new Set<string>()
  private recoveredAt = 0

  constructor(
    private directory: string,
    private workerPath: string,
    private onUpdate: () => void = () => {},
    private claudeBinPath = 'claude'
  ) {
    if (process.platform === 'win32') return
    this.ensureDirectory()
    const candidates: { name: string; modifiedAt: number }[] = []
    for (const name of readdirSync(directory).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))) {
      try {
        const stat = lstatSync(join(directory, name))
        if (stat.isFile() && !(stat.mode & 0o077) && stat.size <= JOURNAL_LIMIT) candidates.push({ name, modifiedAt: stat.mtimeMs })
      } catch { /* A journal can disappear before recovery. */ }
    }
    for (const { name } of candidates.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, HISTORY_LIMIT)) {
      try {
        const path = join(directory, name)
        const stat = lstatSync(path)
        if (!stat.isFile() || stat.mode & 0o077 || stat.size > JOURNAL_LIMIT) continue
        const run = JSON.parse(readFileSync(path, 'utf8')) as HiveSessionInfo
        if (run.id !== name.slice(0, -5) || !PROVIDERS.includes(run.provider!) || !STATES.includes(run.taskState!) ||
          typeof run.objective !== 'string' || run.objective.length > 16000 ||
          typeof run.workingDir !== 'string' || !isAbsolute(run.workingDir) ||
          !['read-only', 'workspace-write'].includes(run.permissionMode!) || !Number.isFinite(run.startedAt) || !['default', 'opus', 'sonnet', 'haiku'].includes(run.model) ||
          typeof run.role !== 'string' || run.role.length > 80 ||
          (run.result !== undefined && (typeof run.result !== 'string' || run.result.length > 32000)) ||
          (run.error !== undefined && typeof run.error !== 'string') || !validReviewData(run) ||
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

  listSummaries(): HiveSessionSummary[] {
    const summaries: HiveSessionSummary[] = [...this.runs.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(({ evidence, ...run }) => {
        if (!evidence) return run
        const { git, commands } = evidence
        const testExits = { zero: 0, nonzero: 0, unknown: 0 }
        for (const command of commands) {
          if (!command.isTest) continue
          if (command.exitCode === null) testExits.unknown++
          else if (command.exitCode === 0) testExits.zero++
          else testExits.nonzero++
        }
        return {
          ...run,
          evidence: {
            id: evidence.id,
            commandCapture: evidence.commandCapture,
            commandCount: commands.length,
            testExits,
            git: git.status === 'captured'
              ? { status: git.status, baseCommit: git.baseCommit, hasPatch: !!git.patch, untrackedCount: git.untracked.length }
              : { status: git.status, reason: git.reason }
          }
        }
      })
    return structuredClone(summaries)
  }

  reviewEvidence(runId: string, evidenceId: string): HiveReviewEvidence | undefined {
    const evidence = this.runs.get(runId)?.evidence
    return evidence && evidence.id === evidenceId ? structuredClone(evidence) : undefined
  }

  agents(): AgentInfo[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt).map((run) => ({
      id: `hive:${run.id}`, name: `${run.provider} ${run.role}`, type: run.provider!, source: 'state-file',
      status: run.taskState === 'working' ? 'active' : run.taskState === 'needs-review' ? 'waiting' : run.taskState === 'reviewed' ? 'idle' : 'unknown',
      pid: run.status === 'running' ? run.pid : undefined, workingDir: run.workingDir,
      agentId: run.id, hiveSessionId: run.id, hiveRole: run.role, lastHeartbeat: run.lastEventAt,
      currentAction: run.events?.at(-1)?.message
    }))
  }

  has(id: string): boolean { return this.runs.has(id) }

  private trimHistory(): void {
    const excess = this.runs.size - HISTORY_LIMIT
    if (excess <= 0) return
    const completed = [...this.runs.values()]
      .filter((run) => !ACTIVE.has(run.taskState!) && run.taskState !== 'needs-review' && !this.workers.has(run.id))
      .sort((a, b) => (a.lastEventAt ?? a.startedAt) - (b.lastEventAt ?? b.startedAt))
    for (const run of completed.slice(0, excess)) this.runs.delete(run.id)
  }

  private transition(run: HiveSessionInfo, state: HiveTaskState, message: string): void {
    run.taskState = state
    run.status = ACTIVE.has(state) ? 'running' : state === 'failed' || state === 'interrupted' ? 'dead' : 'idle'
    run.lastEventAt = Date.now()
    run.events = [...(run.events ?? []), { at: run.lastEventAt, state, message: message.slice(0, 300) }].slice(-50)
  }

  private write(run: HiveSessionInfo, serialized = JSON.stringify(run)): void {
    if (Buffer.byteLength(serialized) > JOURNAL_LIMIT) throw new Error('Run journal exceeds its size limit.')
    const temporary = join(this.directory, `${run.id}.${randomUUID()}.tmp`)
    try {
      this.ensureDirectory()
      writeFileSync(temporary, serialized, { mode: 0o600, flag: 'wx' })
      renameSync(temporary, join(this.directory, `${run.id}.json`))
    } finally {
      try { unlinkSync(temporary) } catch { /* Renamed or absent. */ }
    }
  }

  private store(run: HiveSessionInfo): boolean {
    try {
      let serialized = JSON.stringify(run)
      const budget = JOURNAL_LIMIT - (run.evidence ? REVIEW_RESERVE : 0)
      if (Buffer.byteLength(serialized) > budget && run.evidence?.git.status === 'captured') {
        run.evidence.git = gitUnavailable('The full patch and filename inventory exceed the journal size limit.')
        serialized = JSON.stringify(run)
      }
      if (Buffer.byteLength(serialized) > budget && run.evidence?.commands.length) {
        run.evidence.commands = []
        run.evidence.commandCapture = 'partial'
        serialized = JSON.stringify(run)
      }
      while (Buffer.byteLength(serialized) > budget && run.result && run.result.length > 1) {
        run.result = run.result.slice(0, Math.floor(run.result.length / 2))
        serialized = JSON.stringify(run)
      }
      if (Buffer.byteLength(serialized) > budget) throw new Error('Run journal exceeds its size limit.')
      this.write(run, serialized)
      this.trimHistory()
      this.onUpdate()
      return true
    } catch {
      this.transition(run, 'failed', 'Cannot save the private run record. Execution stopped.')
      run.error = 'Cannot save the private run record. Check disk space and directory permissions.'
      this.workers.get(run.id)?.send({ type: 'stop' }, () => {})
      this.trimHistory()
      this.onUpdate()
      return false
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
      for (const id of this.workers.keys()) {
        const other = this.runs.get(id)
        if (other && !other.evidence && workspacesOverlap(other.workingDir, cwd)) {
          this.overlappingRuns.add(id)
          this.overlappingRuns.add(run.id)
        }
      }
      if (run.provider === 'codex') this.commandTraces.set(run.id, { commands: new Map(), partial: false })
      const worker = fork(this.workerPath, [], {
        execPath: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc']
      })
      this.workers.set(run.id, worker)
      worker.on('message', (message) => this.receive(run, message))
      worker.once('error', () => {
        if (run.evidence) return
        this.transition(run, 'failed', 'Supervisor could not start.')
        run.error = 'Supervisor could not start.'
        run.finishedAt = Date.now()
        this.finishEvidence(run)
        this.store(run)
      })
      worker.once('exit', () => {
        this.workers.delete(run.id)
        this.finished.delete(run.id)
        if (ACTIVE.has(run.taskState!)) {
          this.transition(run, 'interrupted', 'Supervisor disconnected before a terminal report.')
          run.error = 'Supervisor disconnected. Inspect workspace changes before retry.'
          run.finishedAt = Date.now()
          this.finishEvidence(run)
          this.store(run)
        }
        this.commandTraces.delete(run.id)
        this.overlappingRuns.delete(run.id)
        this.trimHistory()
      })
      worker.send({ type: 'start', ...command, cwd, input: `Role: ${run.role}\nObjective:\n${run.objective}`, timeoutSeconds: seconds }, () => {})
      return { success: true, session: structuredClone(run) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Launch failed.' }
    }
  }

  private finishEvidence(run: HiveSessionInfo, git?: unknown): void {
    const trace = this.commandTraces.get(run.id)
    const commands = [...(trace?.commands.values() ?? [])].filter((command): command is HiveCommandEvidence => command !== null)
    const commandCapture = trace && run.taskState === 'needs-review' && !trace.partial
      ? 'captured' : commands.length || trace?.partial ? 'partial' : 'unavailable'
    const gitEvidence = this.overlappingRuns.has(run.id)
      ? gitUnavailable('Multiple managed runs used this Git worktree at the same time.')
      : validGitEvidence(git) ? git : gitUnavailable('HELM did not obtain a complete Git comparison.')
    run.evidence = { id: randomUUID(), git: gitEvidence, commandCapture, commands }
  }

  private receive(run: HiveSessionInfo, raw: unknown): void {
    if (run.evidence || !raw || typeof raw !== 'object') return
    const message = raw as { type?: string; pid?: number; event?: unknown; error?: string; code?: number; stopped?: boolean; git?: unknown }
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
      const trace = this.commandTraces.get(run.id)
      if (trace && event.command !== undefined) {
        if (event.command === null) trace.partial = true
        else {
          const { id, value } = event.command
          const previous = trace.commands.get(id)
          if (previous === undefined && trace.commands.size < COMMAND_LIMIT) {
            trace.commands.set(id, value)
            if (value.exitCode === null) trace.partial = true
          } else if (previous && (previous.command !== value.command || previous.exitCode !== value.exitCode)) {
            trace.commands.set(id, null)
            trace.partial = true
          } else if (previous === undefined) trace.partial = true
        }
      }
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
      this.finishEvidence(run, message.git)
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

  review(id: string, decision?: HiveReviewRequest): { success: boolean; error?: string } {
    const run = this.runs.get(id)
    if (!run || run.taskState !== 'needs-review') return { success: false, error: 'No result awaits review.' }
    const reviewed = structuredClone(run)
    let message = 'Operator marked the result reviewed.'
    if (run.evidence) {
      if (!decision || decision.evidenceId !== run.evidence.id) return { success: false, error: 'The review evidence changed. Refresh and review it again.' }
      if (!validReviewReason(decision.reason)) return { success: false, error: 'Enter a review reason of at most 500 characters.' }
      const reason = decision.reason?.trim()
      if (decision.outcome !== 'accepted' && (decision.outcome !== 'follow-up-requested' || !reason)) {
        return { success: false, error: 'Choose a decision and give a reason for requested follow-up.' }
      }
      reviewed.decision = { evidenceId: run.evidence.id, outcome: decision.outcome, at: Date.now(), ...(reason ? { reason } : {}) }
      message = decision.outcome === 'accepted' ? 'Operator accepted the reviewed evidence.' : 'Operator requested follow-up on the reviewed evidence.'
    } else if (decision !== undefined) return { success: false, error: 'This run has no recorded evidence to bind to a decision.' }
    this.transition(reviewed, 'reviewed', message)
    try { this.write(reviewed) }
    catch { return { success: false, error: 'Could not save the review decision. Check disk space and journal permissions.' } }
    this.runs.set(id, reviewed)
    this.trimHistory()
    this.onUpdate()
    return { success: true }
  }

  shutdown(): void {
    for (const [id] of this.workers) this.stop(id)
  }
}
