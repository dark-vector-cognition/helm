import { useEffect, useState } from 'react'
import { useHiveStore } from '../stores/hive'
import { useSystemStore } from '../stores/system'
import { redactSensitiveText, usePrivacyStore } from '../stores/privacy'
import { getRunStages } from '../stores/run-stages'
import type {
  HiveRoleName,
  HiveModel,
  HiveProvider,
  HivePermissionMode
} from '../../../shared/types'

const ROLES: HiveRoleName[] = ['architect', 'builder', 'analyst', 'ops']
const PROVIDERS: { id: HiveProvider; name: string }[] = [
  { id: 'claude-code', name: 'Claude Code' },
  { id: 'cursor', name: 'Cursor' },
  { id: 'codex', name: 'Codex' }
]
const ACTIVE = new Set(['starting', 'working', 'stopping'])
const RETRYABLE = new Set(['failed', 'stopped', 'interrupted'])

export function HiveLauncher(): JSX.Element {
  const sessions = useHiveStore((s) => s.sessions)
  const enabled = useHiveStore((s) => s.enabled)
  const disabledReason = useHiveStore((s) => s.disabledReason)
  const loading = useHiveStore((s) => s.loading)
  const error = useHiveStore((s) => s.error)
  const spawn = useHiveStore((s) => s.spawn)
  const retry = useHiveStore((s) => s.retry)
  const review = useHiveStore((s) => s.review)
  const killSession = useHiveStore((s) => s.killSession)
  const attach = useHiveStore((s) => s.attach)
  const refresh = useHiveStore((s) => s.refresh)
  const initialize = useHiveStore((s) => s.initialize)
  const updateContext = useHiveStore((s) => s.updateContext)
  const getContext = useHiveStore((s) => s.getContext)
  const state = useSystemStore((s) => s.state)
  const privacyMode = usePrivacyStore((s) => s.privacyMode)
  const display = (value: string): string => (privacyMode ? redactSensitiveText(value) : value)

  const [provider, setProvider] = useState<HiveProvider>('claude-code')
  const [role, setRole] = useState<HiveRoleName>('architect')
  const [model, setModel] = useState<HiveModel | ''>('')
  const [permissionMode, setPermissionMode] = useState<HivePermissionMode>('read-only')
  const [workingDir, setWorkingDir] = useState('')
  const [objective, setObjective] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [contextText, setContextText] = useState('')
  const [contextExpanded, setContextExpanded] = useState(false)
  const [confirmKill, setConfirmKill] = useState<string | null>(null)
  const [confirmRetry, setConfirmRetry] = useState<string | null>(null)

  useEffect(() => initialize(), [initialize])

  const repoPaths = state?.gitRepos.map((r) => r.path) ?? []
  const activeCount = sessions.filter((s) =>
    s.taskState ? ACTIVE.has(s.taskState) : s.status === 'running'
  ).length
  const canLaunch = enabled && !loading && confirmed && !!workingDir.trim() && !!objective.trim()
  const fieldClass = 'shell-run-field'
  const actionClass = 'shell-run-action'

  async function handleLaunch(): Promise<void> {
    if (!canLaunch) return
    const result = await spawn({
      provider,
      role,
      permissionMode,
      workingDir: workingDir.trim(),
      objective: objective.trim(),
      timeoutSeconds: 120,
      ...(provider === 'claude-code' && model ? { model } : {})
    })
    if (result.success) {
      setObjective('')
      setConfirmed(false)
    }
  }

  return (
    <div className="space-y-4 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <div>
          <span className="shell-run-label">Agent control</span>
          <span className="ml-2 text-[10px] text-gray-400">
            {activeCount} running · {sessions.length} recorded
          </span>
        </div>
        <button
          type="button"
          onClick={() => {
            void refresh()
          }}
          className={actionClass}
        >
          Refresh
        </button>
      </div>

      {!enabled && (
        <p role="status" className="rounded border border-amber-700/40 p-2 text-xs text-amber-300">
          {disabledReason ??
            'Agent launch is disabled in this installation. Monitoring remains available.'}
        </p>
      )}
      {error && (
        <p role="alert" className="break-words text-xs text-red-300">
          {display(error)}
        </p>
      )}

      <div className="shell-run-layout">
        <div className="shell-run-form space-y-4" id="hive-launch-form">
          <div>
            <p className="shell-run-label">A clear objective. A defined scope.</p>
            <h3 className="mt-2 text-lg font-medium">Put an agent to work.</h3>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className="text-xs text-gray-400">
              Provider
              <select
                aria-label="Agent provider"
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value as HiveProvider)
                  setConfirmed(false)
                }}
                className={fieldClass}
              >
                {PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-gray-400">
              Role
              <select
                aria-label="Agent role"
                value={role}
                onChange={(e) => {
                  setRole(e.target.value)
                  setConfirmed(false)
                }}
                className={fieldClass}
              >
                {ROLES.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            {provider === 'claude-code' && (
              <label className="text-xs text-gray-400">
                Model
                <select
                  aria-label="Agent model"
                  value={model}
                  onChange={(e) => {
                    setModel(e.target.value as HiveModel | '')
                    setConfirmed(false)
                  }}
                  className={fieldClass}
                >
                  <option value="">Provider default</option>
                  {(['opus', 'sonnet', 'haiku'] as const).map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="text-xs text-gray-400">
              Permissions
              <select
                aria-label="Agent permissions"
                value={permissionMode}
                onChange={(e) => {
                  setPermissionMode(e.target.value as HivePermissionMode)
                  setConfirmed(false)
                }}
                className={fieldClass}
              >
                <option value="read-only">Read only</option>
                <option value="workspace-write">Workspace write</option>
              </select>
            </label>
          </div>
          <label className="block text-xs text-gray-400">
            Working directory
            <input
              aria-label="Agent working directory"
              type={privacyMode ? 'password' : 'text'}
              autoComplete="off"
              value={workingDir}
              onChange={(e) => {
                setWorkingDir(e.target.value)
                setConfirmed(false)
              }}
              placeholder="Absolute workspace path"
              className={fieldClass}
              list={privacyMode ? undefined : 'hive-repo-paths'}
            />
            {!privacyMode && (
              <datalist id="hive-repo-paths">
                {repoPaths.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            )}
          </label>
          <label className="block text-xs text-gray-400">
            Objective
            <textarea
              aria-label="Agent objective"
              value={objective}
              onChange={(e) => {
                setObjective(e.target.value)
                setConfirmed(false)
              }}
              rows={3}
              placeholder="Describe the task and the result you need"
              className={`${fieldClass} resize-y`}
            />
          </label>
          <p className="text-[11px] text-gray-400">
            Runs stop after 120 seconds. Permissions use each provider's controls. They do not
            guarantee operating system isolation. Your objective is visible here while you edit.
          </p>
          <label className="flex items-start gap-2 text-xs text-gray-300">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-0.5 shrink-0"
            />
            <span>
              I approve sending this objective to {PROVIDERS.find((p) => p.id === provider)?.name},
              the selected permissions, and saving the run and its result locally.
            </span>
          </label>
          <button
            type="button"
            onClick={() => {
              void handleLaunch()
            }}
            disabled={!canLaunch}
            className="shell-primary-button w-full"
          >
            {loading ? 'Launching...' : 'Launch agent'}
          </button>
        </div>

        <section aria-label="Agent runs" className="space-y-3 min-w-0">
          <h3 className="shell-run-label">Run journal</h3>
          {sessions.length === 0 && <p className="text-xs text-gray-500">No runs recorded yet.</p>}
          {sessions.map((session) => {
            const managed = !!session.taskState
            const active = managed ? ACTIVE.has(session.taskState!) : session.status === 'running'
            return (
              <article
                key={session.id}
                className="shell-run-card space-y-3 min-w-0"
                data-state={session.taskState ?? 'unknown'}
              >
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-semibold text-gray-200">
                    {PROVIDERS.find((p) => p.id === session.provider)?.name ?? 'Claude Code'} ·{' '}
                    {session.role}
                  </span>
                  <span className="shell-run-status" data-state={session.taskState ?? 'unknown'}>
                    {managed
                      ? session.taskState!.replaceAll('-', ' ')
                      : `Legacy terminal · ${session.status}`}
                  </span>
                </div>
                <p className="text-[11px] text-gray-400 break-all">{display(session.workingDir)}</p>
                {managed && (
                  <>
                    <p className="shell-run-objective">{display(session.objective ?? '')}</p>
                    <div className="shell-run-stage" aria-label={`Run state: ${session.taskState}`}>
                      {getRunStages(session).map((stage) => (
                        <div key={stage.label}>
                          <span
                            className={stage.done ? 'is-done' : stage.current ? 'is-current' : ''}
                          />
                          <small>{stage.label}</small>
                        </div>
                      ))}
                    </div>
                    <p className="text-[11px] text-gray-400">
                      {session.permissionMode} ·{' '}
                      {session.acceptedAt
                        ? `Accepted ${new Date(session.acceptedAt).toLocaleTimeString()}`
                        : 'Awaiting provider acknowledgement'}
                    </p>
                    <p className="text-[11px] text-gray-500">
                      {session.lastEventAt
                        ? `Last event ${new Date(session.lastEventAt).toLocaleTimeString()}`
                        : 'No provider event yet'}
                      {session.finishedAt
                        ? ` · Finished ${new Date(session.finishedAt).toLocaleTimeString()}`
                        : ''}
                    </p>
                    {session.parentSessionId && (
                      <p className="text-[11px] text-gray-500">
                        Retry of {display(session.parentSessionId)}
                      </p>
                    )}
                  </>
                )}
                {session.error && (
                  <p role="alert" className="text-xs text-red-300 whitespace-pre-wrap break-words">
                    {display(session.error)}
                  </p>
                )}
                {session.taskState === 'needs-review' && (
                  <p className="text-xs text-amber-300">
                    The provider returned a result. Inspect it before you mark it reviewed; a result
                    does not prove the objective is complete.
                  </p>
                )}
                {session.events && session.events.length > 0 && (
                  <details>
                    <summary className="text-xs text-gray-400 cursor-pointer">
                      Inspect run history
                    </summary>
                    <ol className="mt-2 space-y-1 text-[11px] text-gray-400">
                      {session.events.map((event, index) => (
                        <li key={index} className="break-words">
                          {new Date(event.at).toLocaleTimeString()} · {event.state} ·{' '}
                          {display(event.message)}
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
                {session.result && (
                  <details>
                    <summary className="text-xs text-cyan-300 cursor-pointer">
                      Inspect result
                    </summary>
                    <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs text-gray-300">
                      {display(session.result)}
                    </pre>
                  </details>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  {!managed && active && (
                    <button
                      type="button"
                      onClick={() => {
                        void attach(session.id)
                      }}
                      className={actionClass}
                    >
                      Attach legacy terminal
                    </button>
                  )}
                  {active &&
                    session.taskState !== 'stopping' &&
                    (confirmKill === session.id ? (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            void killSession(session.id)
                            setConfirmKill(null)
                          }}
                          className={actionClass}
                        >
                          Confirm stop
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmKill(null)}
                          className={actionClass}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmKill(session.id)}
                        className={actionClass}
                      >
                        Stop
                      </button>
                    ))}
                  {managed &&
                    RETRYABLE.has(session.taskState!) &&
                    (confirmRetry === session.id ? (
                      <>
                        <p className="text-[11px] text-gray-400 w-full">
                          Retry sends this objective again with the same provider, workspace and
                          permissions.
                        </p>
                        <button
                          type="button"
                          disabled={!enabled || loading}
                          onClick={() => {
                            void retry(session.id)
                            setConfirmRetry(null)
                          }}
                          className={actionClass}
                        >
                          Confirm retry
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmRetry(null)}
                          className={actionClass}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        disabled={!enabled || loading}
                        onClick={() => setConfirmRetry(session.id)}
                        className={actionClass}
                      >
                        Retry
                      </button>
                    ))}
                  {session.taskState === 'needs-review' && (
                    <button
                      type="button"
                      onClick={() => {
                        void review(session.id)
                      }}
                      className={actionClass}
                    >
                      Mark reviewed
                    </button>
                  )}
                </div>
              </article>
            )
          })}
        </section>
      </div>

      {sessions.some((s) => !s.taskState) && (
        <div className="rounded border border-white/10 bg-black/20 p-2">
          <button
            type="button"
            aria-expanded={contextExpanded}
            onClick={() => {
              if (contextExpanded) setContextExpanded(false)
              else
                void getContext().then((text) => {
                  setContextText(text)
                  setContextExpanded(true)
                })
            }}
            className="text-xs text-gray-400"
          >
            Legacy shared context
          </button>
          {contextExpanded && (
            <div className="mt-2 space-y-2">
              <textarea
                aria-label="Legacy shared context"
                value={contextText}
                onChange={(e) => setContextText(e.target.value)}
                rows={6}
                className={fieldClass}
              />
              <button
                type="button"
                onClick={() => {
                  if (contextText.trim()) void updateContext(contextText.trim())
                }}
                className={actionClass}
              >
                Push context
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
