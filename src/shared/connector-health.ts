export const CONNECTOR_WINDOW_HOURS = 24
export const CONNECTOR_FRESH_MINUTES = 60
export const CONNECTOR_SMALL_SAMPLE = 5

export interface ConnectorAgent {
  name: string
  pid: number
  inFlight: boolean
}

export interface ConnectorFailure {
  sessionId: string
  callSequence: number
  resultSequence?: number
  tool: string
  startedAt: number
  durationMs?: number
  outcome: 'failed' | 'unanswered'
  errorCode?: number
  chainHead: string
}

export interface ConnectorHealthRow {
  id: string
  name: string
  transport: 'stdio' | 'http'
  health: 'healthy' | 'degraded' | 'unknown'
  score: number | null
  successful: number
  failed: number
  unanswered: number
  inFlight: number
  lastAttemptAt: number | null
  agents: ConnectorAgent[]
  failures: ConnectorFailure[]
}

export interface ConnectorHealthSnapshot {
  sourceStatus: 'ready' | 'unavailable'
  checkedAt: number
  skippedSessions: number
  scanLimited: boolean
  rows: ConnectorHealthRow[]
}
