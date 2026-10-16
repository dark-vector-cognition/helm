import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { HelmConfig } from '../shared/types'
import type { HiveConfig } from '../shared/types'
import {
  loadEnvironment,
  resolveCommandOrPathSetting,
  resolvePathSetting
} from './app-paths'

const CONFIG_DIR = join(homedir(), '.config', 'helm')
const LEGACY_CONFIG_DIR = join(homedir(), '.config', 'hydra')
const CONFIG_FILE = 'config.json'

const DEFAULT_CONFIG: HelmConfig = {
  gitRepoPaths: [],
  monitorInterval: 2000,
  snapshotInterval: 30000,
  vaultRagEndpoint: 'http://127.0.0.1:8742',
  vaultPath: join(homedir(), 'Documents', 'ai', 'obsidian-vault'),
  vaultRagLocation: 'local',
  vaultRagRemoteHost: '',
  vaultRagAutoCheck: true
}

export function getConfigPath(): string {
  return join(CONFIG_DIR, CONFIG_FILE)
}

export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true })
  }
}

function migrateFromLegacy(): void {
  const legacyPath = join(LEGACY_CONFIG_DIR, CONFIG_FILE)
  const newPath = join(CONFIG_DIR, CONFIG_FILE)
  if (existsSync(legacyPath) && !existsSync(newPath)) {
    ensureConfigDir()
    copyFileSync(legacyPath, newPath)
    console.log('Migrated config from ~/.config/hydra to ~/.config/helm')
  }
}

function parseListEnv(name: string): string[] | undefined {
  const rawValue = process.env[name]?.trim()
  if (!rawValue) return undefined

  const parsed = rawValue
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => resolvePathSetting(value))

  return parsed.length > 0 ? parsed : undefined
}

function parseBooleanEnv(name: string): boolean | undefined {
  const rawValue = process.env[name]?.trim().toLowerCase()
  if (!rawValue) return undefined

  if (['1', 'true', 'yes', 'on'].includes(rawValue)) return true
  if (['0', 'false', 'no', 'off'].includes(rawValue)) return false
  return undefined
}

function parsePositiveIntEnv(name: string): number | undefined {
  const rawValue = process.env[name]?.trim()
  if (!rawValue) return undefined

  const parsed = Number.parseInt(rawValue, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return parsed
}

function parsePathEnv(name: string): string | undefined {
  const rawValue = process.env[name]?.trim()
  if (!rawValue) return undefined
  return resolvePathSetting(rawValue)
}

function parseCommandOrPathEnv(name: string): string | undefined {
  const rawValue = process.env[name]?.trim()
  if (!rawValue) return undefined
  return resolveCommandOrPathSetting(rawValue)
}

function applyEnvOverrides(config: HelmConfig): HelmConfig {
  const envLmStudioUrl = process.env.LM_STUDIO_URL?.trim()
  const envGitRepoPaths = parseListEnv('HELM_GIT_REPO_PATHS')
  const envAgentFeedPaths = parseListEnv('HELM_AGENT_FEED_PATHS')
  const envLogFilePaths = parseListEnv('HELM_LOG_FILE_PATHS')
  const envStaffBinPath = parseCommandOrPathEnv('HELM_STAFF_BIN_PATH')
  const envNetworkTarget = process.env.HELM_NETWORK_TARGET?.trim()
  const envMonitorInterval = parsePositiveIntEnv('HELM_MONITOR_INTERVAL_MS')
  const envSnapshotInterval = parsePositiveIntEnv('HELM_SNAPSHOT_INTERVAL_MS')
  const envHiveEnabled = parseBooleanEnv('HELM_HIVE_ENABLED')
  const envHiveSharedContextPath = parsePathEnv('HELM_HIVE_SHARED_CONTEXT_PATH')
  const envHiveSessionPrefix = process.env.HELM_HIVE_SESSION_PREFIX?.trim()
  const envHiveClaudeBinPath = parseCommandOrPathEnv('HELM_HIVE_CLAUDE_BIN_PATH')
  const envHiveIdleReclaimMinutes = parsePositiveIntEnv('HELM_HIVE_IDLE_RECLAIM_MINUTES')

  const nextConfig: HelmConfig = { ...config }

  if (envLmStudioUrl) nextConfig.lmStudioUrl = envLmStudioUrl
  if (envGitRepoPaths) nextConfig.gitRepoPaths = envGitRepoPaths
  if (envAgentFeedPaths) nextConfig.agentFeedPaths = envAgentFeedPaths
  if (envLogFilePaths) nextConfig.logFilePaths = envLogFilePaths
  if (envStaffBinPath) nextConfig.staffBinPath = envStaffBinPath
  if (envNetworkTarget) nextConfig.networkTarget = envNetworkTarget
  if (envMonitorInterval) nextConfig.monitorInterval = envMonitorInterval
  if (envSnapshotInterval) nextConfig.snapshotInterval = envSnapshotInterval

  if (
    envHiveEnabled !== undefined ||
    envHiveSharedContextPath ||
    envHiveSessionPrefix ||
    envHiveClaudeBinPath ||
    envHiveIdleReclaimMinutes
  ) {
    const hiveConfig: Partial<HiveConfig> = { ...(nextConfig.hive ?? {}) }
    if (envHiveEnabled !== undefined) hiveConfig.enabled = envHiveEnabled
    if (envHiveSharedContextPath) hiveConfig.sharedContextPath = envHiveSharedContextPath
    if (envHiveSessionPrefix) hiveConfig.tmuxSessionPrefix = envHiveSessionPrefix
    if (envHiveClaudeBinPath) hiveConfig.claudeBinPath = envHiveClaudeBinPath
    if (envHiveIdleReclaimMinutes) {
      hiveConfig.idleReclaimMinutes = envHiveIdleReclaimMinutes
    }
    nextConfig.hive = hiveConfig
  }

  return nextConfig
}

export function loadConfig(): HelmConfig {
  loadEnvironment()
  migrateFromLegacy()
  let config: HelmConfig
  try {
    const configPath = getConfigPath()
    if (!existsSync(configPath)) {
      config = { ...DEFAULT_CONFIG }
    } else {
      const raw = readFileSync(configPath, 'utf-8')
      const parsed = JSON.parse(raw)
      config = { ...DEFAULT_CONFIG, ...parsed }
    }
  } catch {
    config = { ...DEFAULT_CONFIG }
  }

  return applyEnvOverrides(config)
}

/** The config file as stored on disk, without env overrides or defaults. Empty when missing or unreadable. */
function readStoredConfig(): Partial<HelmConfig> {
  try {
    const configPath = getConfigPath()
    if (!existsSync(configPath)) return {}
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function cleanApiKey(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function writeConfigFile(config: Partial<HelmConfig>): void {
  ensureConfigDir()
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), 'utf-8')
}

/**
 * The config as the renderer may see it. The raw API key never leaves the main process:
 * `apiKey` is always an empty string, and `hasApiKey` says whether a key is in effect
 * (stored in the config file or set as LLM_API_KEY).
 */
export function getRedactedConfig(): HelmConfig {
  const config = loadConfig()
  const hasApiKey = Boolean(cleanApiKey(config.apiKey) || process.env.LLM_API_KEY?.trim())
  return { ...config, apiKey: '', hasApiKey }
}

/**
 * Save the full config. The stored API key is kept when the incoming `apiKey` is empty or
 * missing, so a renderer that round-trips the redacted config cannot erase it. It is replaced
 * only by a new non-empty key. Use clearStoredApiKey to remove it.
 */
export function saveConfig(config: HelmConfig): void {
  // hasApiKey is derived for the renderer and is never written to disk.
  const { hasApiKey: _hasApiKey, ...rest } = config
  const next: Partial<HelmConfig> = { ...rest }

  const incoming = cleanApiKey(config.apiKey)
  const stored = cleanApiKey(readStoredConfig().apiKey)
  const key = incoming || stored
  if (key) next.apiKey = key
  else delete next.apiKey

  writeConfigFile(next)
}

/** Explicit clear: removes the stored API key. An LLM_API_KEY set in the environment is unaffected. */
export function clearStoredApiKey(): void {
  const stored = readStoredConfig()
  if (!('apiKey' in stored)) return
  delete stored.apiKey
  writeConfigFile(stored)
}
