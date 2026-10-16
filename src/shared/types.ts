// Shared types between main and renderer processes

export interface ProcessInfo {
  pid: number
  user: string
  cpu: number
  mem: number
  command: string
  name: string
  cwd?: string
}

export interface ProcessGroup {
  name: string
  type: 'project' | 'agent' | 'service' | 'other'
  processes: ProcessInfo[]
  totalCpu: number
  totalMem: number
  ports: number[]
}

export interface PortInfo {
  port: number
  pid: number
  process: string
  protocol: 'TCP' | 'UDP'
  state: 'LISTEN' | 'ESTABLISHED' | 'CLOSE_WAIT' | 'OTHER'
  address: string
}

export type AgentStatus = 'active' | 'busy' | 'idle' | 'waiting' | 'unknown'
export type AgentType =
  | 'claude-code'
  | 'codex'
  | 'gemini'
  | 'cursor'
  | 'aider'
  | 'continue'
  | 'copilot'
  | 'other'

export interface AgentGoal {
  name: string
  progress: number
  priority: number
}

export interface AgentInfo {
  id: string
  name: string
  type: AgentType
  status: AgentStatus
  source: 'process' | 'state-file'
  pid?: number
  workingDir?: string
  tmuxSession?: string
  uptime?: number
  agentId?: string
  sessionId?: string
  currentTick?: number
  totalTicks?: number
  totalActions?: number
  memoryCount?: number
  currentAction?: string
  lastHeartbeat?: number
  goals?: AgentGoal[]
  // HIVE integration
  hiveSessionId?: string
  hiveRole?: HiveRoleName
}

// ── HIVE Types ──────────────────────────────────────────────

export type HiveRoleName = 'architect' | 'builder' | 'analyst' | 'ops' | string
export type HiveModel = 'opus' | 'sonnet' | 'haiku'

export interface HiveRoleTemplate {
  name: HiveRoleName
  displayName: string
  model: HiveModel
  claudeMdPath: string
  description: string
}

export interface HiveSessionInfo {
  id: string
  role: HiveRoleName
  model: HiveModel
  tmuxSession: string
  tmuxWindow: string
  pid?: number
  workingDir: string
  startedAt: number
  status: 'running' | 'idle' | 'dead'
}

export interface HiveSpawnRequest {
  role: HiveRoleName
  model?: HiveModel
  workingDir: string
  claudeMdOverride?: string
  objective?: string
}

export interface HiveSpawnResult {
  success: boolean
  session?: HiveSessionInfo
  error?: string
}

export interface HiveConfig {
  enabled: boolean
  roles: HiveRoleTemplate[]
  defaultModel: HiveModel
  sharedContextPath: string
  tmuxSessionPrefix: string
  claudeBinPath: string
  idleReclaimMinutes: number
}

export interface GitRepoInfo {
  path: string
  name: string
  branch: string
  dirty: boolean
  untracked: number
  modified: number
  ahead: number
  behind: number
  status: 'clean' | 'dirty' | 'diverged' | 'ahead' | 'behind' | 'error'
}

export interface NetworkProcess {
  name: string
  pid: number
  bytesIn: number
  bytesOut: number
  bytesInPerSec: number
  bytesOutPerSec: number
}

export type NetworkScope = 'loopback' | 'lan' | 'internet' | 'unknown'
export type NetworkSourceMode = 'nettop' | 'netstat' | 'unavailable'

export interface NetworkConnection {
  id: string
  processName: string
  pid: number
  protocol: string
  state: string
  localAddress: string
  localPort: number | null
  remoteAddress: string
  remotePort: number | null
  resolvedHost?: string
  scope: NetworkScope
  bytesIn: number
  bytesOut: number
  bytesInPerSec: number
  bytesOutPerSec: number
}

export interface NetworkState {
  processes: NetworkProcess[]
  connections: NetworkConnection[]
  totalBytesInPerSec: number
  totalBytesOutPerSec: number
  timestamp: number
  sourceMode: NetworkSourceMode
  error?: string
}

export interface FirewallRule {
  path: string
  name: string
  action: 'allow' | 'block'
  type: 'user' | 'system'
}

export interface FirewallState {
  rules: FirewallRule[]
  totalAllowed: number
  totalBlocked: number
  lastUpdated: number
}

export interface DiskMount {
  filesystem: string
  mount: string
  totalBytes: number
  usedBytes: number
  availableBytes: number
  usagePercent: number
}

export interface DiskState {
  mounts: DiskMount[]
  maxUsagePercent: number
  timestamp: number
}

export interface BatteryState {
  hasBattery: boolean
  percent: number
  charging: boolean
  source: 'battery' | 'ac' | 'unknown'
  timestamp: number
}

export interface SystemState {
  timestamp: number
  processes: ProcessGroup[]
  ports: PortInfo[]
  agents: AgentInfo[]
  gitRepos: GitRepoInfo[]
  cpu: {
    usage: number
    cores: number
  }
  memory: {
    total: number
    used: number
    free: number
    usagePercent: number
  }
  network?: NetworkState
  firewall?: FirewallState
  disk?: DiskState
  battery?: BatteryState
  isLateNight?: boolean
}

export interface LogLine {
  timestamp: number
  source: string // filename/label
  text: string
  level: 'info' | 'warn' | 'error' | 'debug'
}

export interface DBSnapshot {
  id: number
  timestamp: number
  data: SystemState
}

export interface BriefingResult {
  summary: string
  alerts: BriefingAlert[]
  suggestions: string[]
  raw?: string
  timestamp: number
  error?: string
}

export interface BriefingAlert {
  severity: 'info' | 'warning' | 'critical'
  message: string
  source: string
}

export interface CCDailyEntry {
  date: string
  messages: number
  sessions: number
  toolCalls: number
  tokens: number
}

export type CCUsageSource = 'stats-cache' | 'hybrid' | 'live-log'

export interface CCUsageState {
  available: boolean
  totalSessions: number
  totalMessages: number
  totalCostUSD: number
  todayMessages: number
  todaySessions: number
  todayToolCalls: number
  todayTokens: number
  monthMessages: number
  monthSessions: number
  monthTokens: number
  last7Days: CCDailyEntry[]
  modelBreakdown: {
    model: string
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    costUSD: number
  }[]
  lastUpdated: string
  timestamp: number
  source: CCUsageSource
  cacheStale: boolean
  cacheUpdated: string
  liveLastActivity: string
  liveDeltaCostUSD: number
}

export type AutoHealAction = 'restart_process' | 'notify_only'

export interface LmStudioProbeAttempt {
  url: string
  ok: boolean
  model?: string
  error?: string
}

export interface LmStudioHealResult {
  success: boolean
  repaired: boolean
  /** False when no model endpoint is configured. The model is optional. */
  configured: boolean
  message: string
  url?: string
  model?: string
  previousUrl?: string
  attempts: LmStudioProbeAttempt[]
}

export interface AutoHealEvent {
  timestamp: number
  rule: string
  action: AutoHealAction
  target: string
  success: boolean
  message: string
}

export interface HelmNotification {
  id: string
  title: string
  body: string
  level: 'info' | 'warning' | 'critical'
  timestamp: number
  dismissed: boolean
}

export type ProcessSignalType = 'SIGTERM' | 'SIGKILL' | 'SIGSTOP' | 'SIGCONT'

export type TimelineEventType =
  | 'process_start'
  | 'process_stop'
  | 'user_action'
  | 'auto_heal'
  | 'system'
  | 'agent_action'
  | 'agent_update'
  | 'agent_error'

export interface TimelineEventRecord {
  id?: number
  timestamp: number
  type: TimelineEventType
  source: string
  message: string
  metadata?: string
}

export interface ProcessActionResult {
  success: boolean
  pid: number
  signal: ProcessSignalType
  error?: string
}

export interface GroupActionResult {
  results: ProcessActionResult[]
  groupName: string
  totalKilled: number
  totalFailed: number
}

export const IPC_CHANNELS = {
  SYSTEM_STATE_UPDATE: 'system:state-update',
  REQUEST_REFRESH: 'system:request-refresh',
  GET_INITIAL_STATE: 'system:get-initial-state',
  LOG_LINES: 'logs:lines',
  LOG_SOURCES: 'logs:sources',
  BRIEFING_REQUEST: 'intelligence:briefing-request',
  BRIEFING_RESULT: 'intelligence:briefing-result',
  LM_STUDIO_HEAL: 'intelligence:lm-studio-heal',
  AUTO_HEAL_EVENT: 'intelligence:auto-heal-event',
  NOTIFICATION: 'intelligence:notification',
  DISMISS_NOTIFICATION: 'intelligence:dismiss-notification',
  GET_HEAL_HISTORY: 'intelligence:get-heal-history',
  NETWORK_STATE: 'network:state',
  FIREWALL_STATE: 'firewall:state',
  GET_FIREWALL_RULES: 'firewall:get-rules',
  DB_QUERY_SNAPSHOTS: 'db:query-snapshots',
  DB_QUERY_ALERTS: 'db:query-alerts',
  DB_QUERY_BRIEFINGS: 'db:query-briefings',
  DB_QUERY_NOTIFICATIONS: 'db:query-notifications',
  DB_QUERY_LOGS: 'db:query-logs',
  DB_CLEAR_LOGS: 'db:clear-logs',
  CONFIG_GET: 'config:get',
  CONFIG_SAVE: 'config:save',
  CONFIG_CLEAR_API_KEY: 'config:clear-api-key',
  GIT_COMMIT_HISTORY: 'git:commit-history',
  GIT_ACTION: 'git:action',
  PROCESS_KILL: 'process:kill',
  PROCESS_SIGNAL: 'process:signal',
  PROCESS_KILL_GROUP: 'process:kill-group',
  TIMELINE_EVENTS: 'timeline:events',
  SESSION_DELTA: 'session:delta',
  CCUSAGE_STATE: 'ccusage:state',
  CCUSAGE_REFRESH: 'ccusage:refresh',
  SKILLS_FEED: 'skills:feed',
  REGISTRY_GET_ALL: 'registry:get-all',
  REGISTRY_GET_BY_ID: 'registry:get-by-id',
  REGISTRY_UPDATE: 'registry:update',
  REGISTRY_GET_TOP: 'registry:get-top',
  SENTINEL_STATUS: 'sentinel:status',
  SENTINEL_ALERTS: 'sentinel:alerts',
  VAULT_HEALTH: 'vault:health',
  VAULT_SEARCH: 'vault:search',
  VAULT_OPEN_CHUNK: 'vault:open-chunk',
  VAULT_REINDEX: 'vault:reindex',
  VAULT_PUSH_NOTE: 'vault:push-note',
  VAULT_PULL_SYNC: 'vault:pull-sync',
  // HIVE channels
  HIVE_SPAWN: 'hive:spawn',
  HIVE_KILL_SESSION: 'hive:kill-session',
  HIVE_LIST_SESSIONS: 'hive:list-sessions',
  HIVE_SEND_MESSAGE: 'hive:send-message',
  HIVE_UPDATE_CONTEXT: 'hive:update-context',
  HIVE_GET_CONTEXT: 'hive:get-context',
  HIVE_ATTACH: 'hive:attach',
  HIVE_SESSION_UPDATE: 'hive:session-update'
} as const

// Sentinel types
export type SentinelSeverity = 'info' | 'warning' | 'critical'

export interface SentinelAlert {
  ruleId: string
  severity: SentinelSeverity
  title: string
  body: string
  suggestedAction?: string
  timestamp: number
}

export interface SentinelStatus {
  enabled: boolean
  activeAlerts: SentinelAlert[]
  lastPoll: number
  rulesEnabled: number
}

export interface GitActionResult {
  success: boolean
  output: string
}

export interface GitCommit {
  hash: string
  shortHash: string
  author: string
  email: string
  timestamp: number
  message: string
  isAiAuthored: boolean
  aiAgent?: string
  repoName: string
}

export interface SkillUpdate {
  name: string
  title: string
  path: string
  updatedAt: number
  scope: 'user' | 'system'
}

export interface SkillFeed {
  totalSkills: number
  recent: SkillUpdate[]
}

// Agent Registry (historical record of all agents ever built)
export type RegistryAgentType =
  | 'voice-assistant'
  | 'cli-tool'
  | 'dashboard'
  | 'mcp-server'
  | 'workflow-agent'
  | 'multiplexer'
  | 'rag-server'
  | 'bot'
  | 'simulator'
  | 'other'

export type RegistryAgentStatus = 'active' | 'retired' | 'stalled' | 'dead' | 'evolved'

export interface AgentRegistryEntry {
  id: string
  name: string
  codename?: string
  type: RegistryAgentType
  status: RegistryAgentStatus
  era: { start: string; end?: string }
  stack: string[]
  repo?: string
  deployedTo?: string
  description: string
  keyOutputs: string[]
  impactScore: number
  lessonsLearned?: string
  parentAgent?: string
  tags: string[]
}

export interface RadioHomeLocation {
  label: string
  latitude: number
  longitude: number
}

export interface VaultSearchResult {
  chunk_id: string
  snippet: string
  source_path: string
  heading_path: string | null
  client: string | null
  doc_type: string | null
  fused_score: number
  matched_in: 'dense' | 'sparse' | 'both'
  dense_score: number | null
  sparse_score: number | null
}

export interface VaultSearchResponse {
  error?: string
  results: VaultSearchResult[]
  query: string
  result_count: number
}

export interface VaultChunk {
  chunk_id: string
  text: string
  source_path: string
  heading_path: string | null
  client: string | null
  doc_type: string | null
  tags: string[]
  entity_refs: string[]
  identifiers: string[]
  updated_at: string | null
  word_count: number | null
}

export interface VaultHealthStatus {
  online: boolean
  endpoint: string
  qdrant_ok: boolean
  last_check: number
  last_reindex: string | null
  total_chunks: number | null
  error: string | null
}

export interface VaultPushResult {
  success: boolean
  file_path: string | null
  error: string | null
}

export interface VaultReindexResult {
  success: boolean
  files_processed: number | null
  duration_ms: number | null
  error: string | null
}

export interface HelmConfig {
  /**
   * Optional API key for hosted OpenAI-compatible endpoints. LLM_API_KEY in the environment
   * overrides it. The raw key never crosses IPC: the renderer always receives an empty string
   * here, and a save with an empty value keeps the stored key.
   */
  apiKey?: string
  /** Set by the main process on config sent to the renderer: true when a key is in effect. Never saved. */
  hasApiKey?: boolean
  gitRepoPaths: string[]
  monitorInterval: number
  snapshotInterval: number
  lmStudioUrl?: string
  agentPatterns?: { type: string; displayName: string; patterns: string[] }[]
  agentFeedPaths?: string[]
  logFilePaths?: string[]
  radioHomeLocation?: RadioHomeLocation
  vaultRagEndpoint: string
  vaultPath: string
  vaultRagLocation: 'local' | 'remote'
  vaultRagRemoteHost: string
  vaultRagAutoCheck: boolean
  hive?: Partial<HiveConfig>
}
