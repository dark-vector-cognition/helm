import { useEffect, useState } from 'react'
import {
  CONNECTOR_FRESH_MINUTES,
  CONNECTOR_SMALL_SAMPLE,
  CONNECTOR_WINDOW_HOURS,
  type ConnectorFailure,
  type ConnectorHealthRow,
  type ConnectorHealthSnapshot
} from '../../../shared/connector-health'
import { usePrivacyStore } from '../stores/privacy'
import '../assets/connectors.css'

const REFRESH_MS = 8_000
const HEALTH_LABELS = { healthy: 'Healthy', degraded: 'Degraded', unknown: 'Unknown' }
const SAFE_AGENT_NAMES = new Set(['Claude Code', 'Codex', 'Cursor', 'Gemini', 'Gemini CLI', 'Aider', 'Continue', 'Copilot', 'OpenCode'])
const SCORE_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })
let pendingSnapshot: Promise<ConnectorHealthSnapshot> | undefined

function readSnapshot(): Promise<ConnectorHealthSnapshot> {
  if (pendingSnapshot) return pendingSnapshot
  const request = Promise.resolve().then(() => window.helm.getConnectorHealth())
  pendingSnapshot = request
  const release = (): void => {
    if (pendingSnapshot === request) pendingSnapshot = undefined
  }
  void request.then(release, release)
  return request
}

function Timestamp({ value, full = false }: { value: number; full?: boolean }): JSX.Element {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return <span>Time unavailable</span>
  return <time dateTime={date.toISOString()}>{full ? date.toLocaleString() : date.toLocaleTimeString()}</time>
}

function connectorLabel(name: string, index: number, secure: boolean): string {
  if (!secure) return name
  const safeAlias = /^[A-Za-z][A-Za-z0-9 _-]{0,47}$/.test(name) && !/^(?:gh[pousr]_|github_pat_|sk-)/i.test(name)
  return safeAlias ? name : `Connector ${index + 1}`
}

function Freshness({ lastAttemptAt, checkedAt }: { lastAttemptAt: number | null; checkedAt: number }): JSX.Element {
  if (lastAttemptAt === null) return <span>No attempt recorded in {CONNECTOR_WINDOW_HOURS}h</span>
  const minutes = Math.max(0, Math.floor((checkedAt - lastAttemptAt) / 60_000))
  const fresh = minutes < CONNECTOR_FRESH_MINUTES
  return (
    <span>
      {fresh ? 'Recent attempt' : 'Older attempt'} · <Timestamp value={lastAttemptAt} full />
    </span>
  )
}

function AgentUse({ row, secure, stale }: { row: ConnectorHealthRow; secure: boolean; stale: boolean }): JSX.Element {
  return (
    <div className="connector-health-agents">
      <h4 className="connector-health-label">Linked agent processes</h4>
      {row.transport === 'http' ? (
        <p className="shell-subtle">Unassigned · shared HTTP</p>
      ) : row.agents.length === 0 ? (
        <p className="shell-subtle">No active process link</p>
      ) : (
        <ul aria-label="Agent processes linked to this connector">
          {row.agents.map((agent) => (
            <li key={agent.pid}>
              <span>{secure && !SAFE_AGENT_NAMES.has(agent.name) ? 'Agent' : agent.name}</span>
              {!secure && <span className="shell-subtle">PID {agent.pid}</span>}
              <span className="connector-health-agent-state" data-live={agent.inFlight && !stale}>
                {stale ? 'Last observed' : agent.inFlight ? 'Calling now' : 'Used in 24h'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Traceback({ failures, secure }: { failures: ConnectorFailure[]; secure: boolean }): JSX.Element | null {
  if (failures.length === 0) return null
  return (
    <details className="connector-health-trace">
      <summary className="shell-run-disclosure">Traceback · {failures.length} available</summary>
      <p className="shell-subtle">
        {secure ? 'Secure View hides tool names and exact trace references. ' : 'References point to the recorded local trace. '}
        Traceback shows metadata only. Call arguments and results are excluded.
      </p>
      <ol aria-label="Recorded failure references">
        {failures.map((failure) => (
          <li key={`${failure.sessionId}:${failure.callSequence}`}>
            <div className="connector-health-trace-heading">
              <strong>{failure.outcome === 'failed' ? 'Failed' : 'Unanswered'}</strong>
              <Timestamp value={failure.startedAt} full />
            </div>
            <dl>
              {!secure && (
                <>
                  <div><dt>Tool</dt><dd><code>{failure.tool}</code></dd></div>
                  <div><dt>Session</dt><dd><code>{failure.sessionId}</code></dd></div>
                  <div><dt>Call sequence</dt><dd>{failure.callSequence}</dd></div>
                  <div><dt>Result sequence</dt><dd>{failure.resultSequence ?? 'Unrecorded'}</dd></div>
                </>
              )}
              <div><dt>Latency</dt><dd>{failure.durationMs === undefined ? 'Unrecorded' : `${failure.durationMs} ms`}</dd></div>
              {failure.errorCode !== undefined && <div><dt>RPC code</dt><dd>{failure.errorCode}</dd></div>}
              <div><dt>Chain check</dt><dd>{failure.chainHead ? 'Hash chain valid' : 'Unavailable'}</dd></div>
              {!secure && failure.chainHead && <div><dt>Chain head</dt><dd><code>{failure.chainHead}</code></dd></div>}
            </dl>
          </li>
        ))}
      </ol>
    </details>
  )
}

function ConnectorRow({ row, index, checkedAt, secure, stale }: {
  row: ConnectorHealthRow
  index: number
  checkedAt: number
  secure: boolean
  stale: boolean
}): JSX.Element {
  const settled = row.successful + row.failed + row.unanswered
  const score = row.score === null ? null : Math.min(100, Math.max(0, row.score))

  return (
    <li className="connector-health-row" data-health={row.health}>
      <article>
        <div className="connector-health-reading">
          <header className="connector-health-identity">
            <p className="connector-health-label">MCP / {row.transport === 'stdio' ? 'stdio' : 'HTTP'}</p>
            <h3>{connectorLabel(row.name, index, secure)}</h3>
            <span className="connector-health-state">{HEALTH_LABELS[row.health]}</span>
          </header>
          <div className="connector-health-score">
            <p className="connector-health-label">Observed success</p>
            <div className="connector-health-score-value">{score === null ? 'No score' : `${SCORE_FORMAT.format(score)}%`}</div>
            {score !== null && (
              <div className="connector-health-meter" aria-hidden="true"><span style={{ width: `${score}%` }} /></div>
            )}
            <p className="shell-subtle">{settled > 0 ? `${row.successful} of ${settled} settled` : 'No settled calls'}</p>
            {settled > 0 && settled < CONNECTOR_SMALL_SAMPLE && <p className="connector-health-sample">Small sample</p>}
          </div>
          <dl className="connector-health-outcomes">
            <div><dt>Successful</dt><dd>{row.successful}</dd></div>
            <div><dt>Failed</dt><dd>{row.failed}</dd></div>
            <div><dt>Unanswered</dt><dd>{row.unanswered}</dd></div>
            <div><dt>In flight</dt><dd>{row.inFlight}</dd></div>
          </dl>
          <AgentUse row={row} secure={secure} stale={stale} />
        </div>
        <div className="connector-health-row-footer shell-subtle">
          <Freshness lastAttemptAt={row.lastAttemptAt} checkedAt={checkedAt} />
          <Traceback failures={row.failures} secure={secure} />
        </div>
      </article>
    </li>
  )
}

export function ConnectorHealthPanel(): JSX.Element {
  const secure = usePrivacyStore((state) => state.privacyMode)
  const [snapshot, setSnapshot] = useState<ConnectorHealthSnapshot>()
  const [checking, setChecking] = useState(true)
  const [failed, setFailed] = useState(false)
  const [refreshVersion, setRefreshVersion] = useState(0)

  useEffect(() => {
    let mounted = true
    let next: number | undefined

    async function refresh(): Promise<void> {
      setChecking(true)
      try {
        const updated = await readSnapshot()
        if (!mounted) return
        setSnapshot(updated)
        setFailed(false)
        next = window.setTimeout(() => void refresh(), REFRESH_MS)
      } catch {
        if (mounted) setFailed(true)
      } finally {
        if (mounted) setChecking(false)
      }
    }

    void refresh()
    return () => {
      mounted = false
      window.clearTimeout(next)
    }
  }, [refreshVersion])

  const ready = snapshot?.sourceStatus === 'ready'
  return (
    <section className="connector-health" aria-label="MCP connector health">
      <div className="connector-health-toolbar">
        <div>
          <p className="connector-health-label">Local traces / Last {CONNECTOR_WINDOW_HOURS} hours</p>
          <p className="connector-health-method shell-subtle">
            The score uses successful calls divided by settled calls. Failed and unanswered calls count as settled. In-flight calls remain separate.
          </p>
        </div>
        <div className="connector-health-refresh">
          <span className="shell-subtle">{snapshot ? <>Last checked <Timestamp value={snapshot.checkedAt} /></> : 'Awaiting first check'}</span>
          <button
            type="button"
            className="shell-run-action"
            disabled={checking}
            onClick={() => setRefreshVersion((version) => version + 1)}
          >
            {checking ? 'Checking…' : failed || snapshot?.sourceStatus === 'unavailable' ? 'Retry' : 'Refresh'}
          </button>
        </div>
      </div>
      {failed && (
        <div className="connector-health-notice" role="alert">
          <strong>Connector refresh failed.</strong> {snapshot ? 'Showing the last check. ' : ''}Select Retry to check again.
        </div>
      )}
      {!snapshot && !failed && <p className="connector-health-empty" role="status">Checking local connector traces…</p>}
      {snapshot?.sourceStatus === 'unavailable' && (
        <div className="connector-health-empty" role="status">
          <strong>Trace source unavailable</strong>
          <p>HELM could not read a supported local MCP trace source.</p>
        </div>
      )}
      {ready && (snapshot.scanLimited || snapshot.skippedSessions > 0) && (
        <div className="connector-health-notice" role="status">
          <strong>Partial trace coverage.</strong>{' '}
          {snapshot.scanLimited && 'The scan reached its read limit. '}
          {snapshot.skippedSessions > 0 && `Skipped ${snapshot.skippedSessions} ${snapshot.skippedSessions === 1 ? 'session' : 'sessions'}. `}
          Counts reflect the traces HELM could verify.
        </div>
      )}
      {ready && snapshot.rows.length === 0 && (
        <div className="connector-health-empty" role="status">
          <strong>No connector calls observed</strong>
          <p>Calls appear here when the local trace source records them.</p>
        </div>
      )}
      {ready && snapshot.rows.length > 0 && (
        <ul className="connector-health-list" aria-label="Observed connectors">
          {snapshot.rows.map((row, index) => (
            <ConnectorRow key={row.id} row={row} index={index} checkedAt={snapshot.checkedAt} secure={secure} stale={failed} />
          ))}
        </ul>
      )}
      <p className="connector-health-footnote shell-subtle">
        Coverage comes from recorded calls. Agent labels come from local stdio process ancestry. Shared HTTP and unmatched activity stay unassigned.
      </p>
    </section>
  )
}
