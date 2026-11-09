import { useEffect, useRef, useState, type FormEvent } from 'react'
import type {
  HiveReviewDecision,
  HiveReviewEvidence,
  HiveReviewEvidenceSummary,
  HiveReviewRequest
} from '../../../shared/types'

interface HiveReviewCardProps {
  runId: string
  evidence: HiveReviewEvidenceSummary
  decision?: HiveReviewDecision
  secure: boolean
  canReview: boolean
  onDecision: (decision: HiveReviewRequest) => Promise<boolean>
}

const CAPTURE_LABEL = {
  captured: 'Reported command events captured',
  partial: 'Command capture is partial',
  unavailable: 'Command capture unavailable'
}

export function HiveReviewCard({
  runId,
  evidence,
  decision,
  secure,
  canReview,
  onDecision
}: HiveReviewCardProps): JSX.Element {
  const [followUp, setFollowUp] = useState(false)
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const { git, commandCount, testExits } = evidence
  const { zero, nonzero, unknown } = testExits

  async function save(outcome: HiveReviewRequest['outcome']): Promise<void> {
    const trimmed = reason.trim()
    if (saving || (outcome === 'follow-up-requested' && !trimmed)) return

    setSaving(true)
    setSaveFailed(false)
    try {
      const saved = await onDecision({
        evidenceId: evidence.id,
        outcome,
        ...(outcome === 'follow-up-requested' ? { reason: trimmed } : {})
      })
      setSaveFailed(!saved)
      if (saved) {
        setFollowUp(false)
        setReason('')
      }
    } catch {
      setSaveFailed(true)
    } finally {
      setSaving(false)
    }
  }

  function submitFollowUp(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    void save('follow-up-requested')
  }

  return (
    <section aria-label="Run evidence" className="shell-run-evidence space-y-3">
      <div>
        <h4 className="shell-run-label">Run evidence</h4>
        <p className="mt-1 text-xs shell-subtle">
          Review the captured workspace and provider events before you decide.
        </p>
      </div>
      <dl className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="font-semibold">Git snapshot</dt>
          {git.status === 'captured' ? (
            <dd className="shell-subtle">
              <p>
                Baseline <code className="break-all">{git.baseCommit}</code>
              </p>
              <p>
                {git.hasPatch
                  ? 'Tracked diff captured'
                  : 'No tracked changes in the captured patch'}{' '}
                · {git.untrackedCount} new untracked
              </p>
            </dd>
          ) : (
            <dd className="shell-subtle">Git evidence unavailable</dd>
          )}
        </div>
        <div className="min-w-0">
          <dt className="font-semibold">Provider-reported commands</dt>
          <dd className="shell-subtle">
            <p>
              {evidence.commandCapture === 'captured' && commandCount === 0
                ? 'No completed command events reported'
                : `${CAPTURE_LABEL[evidence.commandCapture]} · ${commandCount} recorded`}
            </p>
            <p>
              {zero + nonzero + unknown === 0
                ? 'No test commands reported'
                : `Test command exits · ${zero} zero · ${nonzero} nonzero · ${unknown} unknown`}
            </p>
          </dd>
        </div>
      </dl>
      <p className="text-xs shell-subtle">
        Git shows the workspace at capture, which can include other edits. Untracked file contents
        are excluded. Test counts use reported exit codes and have no independent verification.
        Commands can be missing. Command output is unavailable.
      </p>
      {secure ? (
        <p className="text-xs shell-subtle">
          Secure View hides raw diffs, file names, commands, and capture details. Turn it off to
          inspect them.
        </p>
      ) : (
        <RawEvidence key={evidence.id} runId={runId} evidence={evidence} />
      )}
      {decision && (
        <div role="status" className="border-t border-[color:var(--helm-border-soft)] pt-3 text-xs">
          <p className="font-semibold">
            {decision.outcome === 'accepted' ? 'Accepted' : 'Follow-up requested'} ·{' '}
            <time dateTime={new Date(decision.at).toISOString()}>
              {new Date(decision.at).toLocaleString()}
            </time>
          </p>
          {decision.reason && (
            <p className="mt-1 whitespace-pre-wrap break-words shell-subtle">
              {secure ? 'Review reason hidden in Secure View.' : decision.reason}
            </p>
          )}
        </div>
      )}
      {canReview && !decision && (
        <div className="space-y-2 border-t border-[color:var(--helm-border-soft)] pt-3">
          <p className="text-xs shell-subtle">
            The decision applies to this evidence. It records your review locally without taking
            another action.
          </p>
          {followUp ? (
            <form className="space-y-2" onSubmit={submitFollowUp}>
              <label className="block text-xs">
                Follow-up reason
                <textarea
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  className="shell-run-field resize-y"
                  rows={2}
                  maxLength={500}
                  required
                />
              </label>
              {secure && (
                <p className="text-xs shell-subtle">
                  The reason is visible while you edit and saved locally.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <button
                  type="submit"
                  className="shell-primary-button"
                  disabled={saving || !reason.trim()}
                >
                  {saving ? 'Saving...' : 'Save follow-up request'}
                </button>
                <button
                  type="button"
                  className="shell-run-action"
                  disabled={saving}
                  onClick={() => setFollowUp(false)}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="shell-primary-button"
                disabled={saving}
                onClick={() => void save('accepted')}
              >
                {saving ? 'Saving...' : 'Accept'}
              </button>
              <button
                type="button"
                className="shell-run-action"
                disabled={saving}
                onClick={() => setFollowUp(true)}
              >
                Request follow-up
              </button>
            </div>
          )}
          {saveFailed && (
            <p role="alert" className="text-xs text-red-300">
              Review decision could not be saved. Try again.
            </p>
          )}
        </div>
      )}
    </section>
  )
}

type RawEvidenceState =
  | { status: 'idle' | 'loading' | 'failed' }
  | { status: 'loaded'; value: HiveReviewEvidence }

function RawEvidence({
  runId,
  evidence
}: Pick<HiveReviewCardProps, 'runId' | 'evidence'>): JSX.Element {
  const [state, setState] = useState<RawEvidenceState>({ status: 'idle' })
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const requested = useRef(false)
  const mounted = useRef(false)
  const { id, git, commandCount } = evidence

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  async function load(): Promise<void> {
    if (requested.current) return
    requested.current = true
    setState({ status: 'loading' })

    try {
      const value = await window.helm.hiveReadReviewEvidence(runId, id)
      if (!mounted.current) return
      if (value?.id === id) {
        setState({ status: 'loaded', value })
        return
      }
    } catch {
      if (!mounted.current) return
    }

    requested.current = false
    setState({ status: 'failed' })
  }

  const raw = state.status === 'loaded' ? state.value : undefined
  const rawGit = raw?.git.status === 'captured' ? raw.git : undefined
  const sections = [
    {
      label: 'Inspect Git diff',
      available: git.status === 'captured' && git.hasPatch,
      content: rawGit && <pre className="shell-run-evidence-text">{rawGit.patch}</pre>
    },
    {
      label: 'Inspect untracked file names',
      available: git.status === 'captured' && git.untrackedCount > 0,
      content: rawGit && (
        <pre className="shell-run-evidence-text">{rawGit.untracked.join('\n')}</pre>
      )
    },
    {
      label: 'Inspect recorded commands',
      available: commandCount > 0,
      content: raw && (
        <ol className="shell-run-evidence-text space-y-2">
          {raw.commands.map((command, index) => (
            <li key={index} className="min-w-0">
              <code>{command.command}</code>
              <p className="shell-subtle">
                {command.isTest ? 'Test command · ' : ''}
                {command.exitCode === null ? 'Exit status unknown' : `Exit ${command.exitCode}`}
              </p>
            </li>
          ))}
        </ol>
      )
    }
  ]

  return (
    <>
      <p className="text-xs shell-subtle">
        Secure View is off. These details may contain private source or command text.
      </p>
      {git.status === 'unavailable' && (
        <p className="break-words text-xs shell-subtle">{git.reason}</p>
      )}
      {sections
        .filter((section) => section.available)
        .map(({ label, content }) => (
          <details
            key={label}
            onToggle={(event) => {
              const expanded = event.currentTarget.open
              setOpen((current) => ({ ...current, [label]: expanded }))
              if (expanded) void load()
            }}
          >
            <summary className="shell-run-disclosure">{label}</summary>
            {open[label] && (
              <>
                {state.status === 'loading' && (
                  <p role="status" className="mt-2 text-xs shell-subtle">
                    Loading evidence…
                  </p>
                )}
                {state.status === 'failed' && (
                  <div className="mt-2 space-y-2">
                    <p role="alert" className="text-xs text-red-300">
                      Could not load this evidence.
                    </p>
                    <button type="button" className="shell-run-action" onClick={() => void load()}>
                      Retry evidence
                    </button>
                  </div>
                )}
                {state.status === 'loaded' && content}
              </>
            )}
          </details>
        ))}
    </>
  )
}
