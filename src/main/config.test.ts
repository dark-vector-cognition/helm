import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// We test config logic by importing the module and overriding the config path
// via a helper that writes/reads from tmp directories.
import type { HelmConfig } from '../shared/types'

const TEST_VAULT_DEFAULTS = {
  vaultRagEndpoint: 'http://127.0.0.1:8742',
  vaultPath: '/home/test/Documents/ai/obsidian-vault',
  vaultRagLocation: 'local' as const,
  vaultRagRemoteHost: '',
  vaultRagAutoCheck: true
}

// Since config.ts uses hardcoded paths based on os.homedir(), we test the
// core logic by directly exercising JSON serialization and default merging.
// For the file I/O functions, we test with the real module against tmp dirs.

describe('config defaults', () => {
  it('default config has expected shape', () => {
    const defaults: HelmConfig = {
      gitRepoPaths: [],
      monitorInterval: 2000,
      snapshotInterval: 30000,
      ...TEST_VAULT_DEFAULTS
    }
    expect(defaults.monitorInterval).toBe(2000)
    expect(defaults.snapshotInterval).toBe(30000)
    expect(defaults.gitRepoPaths).toEqual([])
    expect(defaults.apiKey).toBeUndefined()
    expect(defaults.lmStudioUrl).toBeUndefined()
  })

  it('merging partial config with defaults fills in missing fields', () => {
    const defaults: HelmConfig = {
      gitRepoPaths: [],
      monitorInterval: 2000,
      snapshotInterval: 30000,
      ...TEST_VAULT_DEFAULTS
    }
    const partial = { apiKey: 'sk-test-123', monitorInterval: 5000 }
    const merged = { ...defaults, ...partial }
    expect(merged.apiKey).toBe('sk-test-123')
    expect(merged.monitorInterval).toBe(5000)
    expect(merged.snapshotInterval).toBe(30000)
    expect(merged.gitRepoPaths).toEqual([])
  })
})

describe('config JSON serialization', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'helm-config-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes and reads config as JSON', () => {
    const config: HelmConfig = {
      apiKey: 'sk-test',
      gitRepoPaths: ['/home/test/repo1'],
      monitorInterval: 3000,
      snapshotInterval: 60000,
      radioHomeLocation: {
        label: 'Home base',
        latitude: 29.7,
        longitude: -98.4
      },
      ...TEST_VAULT_DEFAULTS
    }

    const configPath = join(tmpDir, 'config.json')
    const { writeFileSync } = require('fs')
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')

    const raw = readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(raw)
    expect(parsed.apiKey).toBe('sk-test')
    expect(parsed.gitRepoPaths).toEqual(['/home/test/repo1'])
    expect(parsed.monitorInterval).toBe(3000)
    expect(parsed.snapshotInterval).toBe(60000)
    expect(parsed.radioHomeLocation).toEqual({
      label: 'Home base',
      latitude: 29.7,
      longitude: -98.4
    })
  })

  it('handles missing config file by using defaults', () => {
    const configPath = join(tmpDir, 'nonexistent.json')
    expect(existsSync(configPath)).toBe(false)

    const defaults: HelmConfig = {
      gitRepoPaths: [],
      monitorInterval: 2000,
      snapshotInterval: 30000,
      ...TEST_VAULT_DEFAULTS
    }
    // Simulate loadConfig behavior
    let result: HelmConfig
    try {
      const raw = readFileSync(configPath, 'utf-8')
      result = { ...defaults, ...JSON.parse(raw) }
    } catch {
      result = { ...defaults }
    }
    expect(result).toEqual(defaults)
  })

  it('handles malformed JSON by falling back to defaults', () => {
    const configPath = join(tmpDir, 'bad.json')
    const { writeFileSync } = require('fs')
    writeFileSync(configPath, 'not valid json {{{', 'utf-8')

    const defaults: HelmConfig = {
      gitRepoPaths: [],
      monitorInterval: 2000,
      snapshotInterval: 30000,
      ...TEST_VAULT_DEFAULTS
    }
    let result: HelmConfig
    try {
      const raw = readFileSync(configPath, 'utf-8')
      result = { ...defaults, ...JSON.parse(raw) }
    } catch {
      result = { ...defaults }
    }
    expect(result).toEqual(defaults)
  })
})

describe('ensureConfigDir', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'helm-config-dir-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates nested directories with recursive mkdir', () => {
    const { mkdirSync } = require('fs')
    const nested = join(tmpDir, 'a', 'b', 'c')
    expect(existsSync(nested)).toBe(false)
    mkdirSync(nested, { recursive: true })
    expect(existsSync(nested)).toBe(true)
  })

  it('does not throw when directory already exists', () => {
    const { mkdirSync } = require('fs')
    const nested = join(tmpDir, 'existing')
    mkdirSync(nested, { recursive: true })
    expect(() => mkdirSync(nested, { recursive: true })).not.toThrow()
  })
})

describe('loadConfig env overrides', () => {
  let tmpHome: string
  const ENV_KEYS = [
    'HOME',
    'HELM_ENV_PATH',
    'LM_STUDIO_URL',
    'HELM_GIT_REPO_PATHS',
    'HELM_AGENT_FEED_PATHS',
    'HELM_LOG_FILE_PATHS',
    'HELM_HIVE_ENABLED',
    'HELM_HIVE_SHARED_CONTEXT_PATH',
    'HELM_HIVE_CLAUDE_BIN_PATH',
    'HELM_HIVE_IDLE_RECLAIM_MINUTES'
  ] as const
  const originalEnv = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]])
  ) as Record<(typeof ENV_KEYS)[number], string | undefined>

  beforeEach(() => {
    vi.resetModules()
    tmpHome = mkdtempSync(join(tmpdir(), 'helm-config-home-'))
    process.env.HOME = tmpHome
    process.env.HELM_ENV_PATH = join(tmpHome, 'missing.env')
    delete process.env.LM_STUDIO_URL
    delete process.env.HELM_GIT_REPO_PATHS
    delete process.env.HELM_AGENT_FEED_PATHS
    delete process.env.HELM_LOG_FILE_PATHS
    delete process.env.HELM_HIVE_ENABLED
    delete process.env.HELM_HIVE_SHARED_CONTEXT_PATH
    delete process.env.HELM_HIVE_CLAUDE_BIN_PATH
    delete process.env.HELM_HIVE_IDLE_RECLAIM_MINUTES
  })

  afterEach(() => {
    vi.resetModules()
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = originalEnv[key]
      }
    }

    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('prefers LM_STUDIO_URL over persisted config', async () => {
    const configDir = join(tmpHome, '.config', 'helm')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({ lmStudioUrl: 'http://localhost:1234' }, null, 2),
      'utf-8'
    )
    process.env.LM_STUDIO_URL = 'http://10.55.0.10:1234'

    const { loadConfig } = await import('./config')

    expect(loadConfig().lmStudioUrl).toBe('http://10.55.0.10:1234')
  })

  it('ignores blank LM_STUDIO_URL values', async () => {
    const configDir = join(tmpHome, '.config', 'helm')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({ lmStudioUrl: 'http://localhost:1234' }, null, 2),
      'utf-8'
    )
    process.env.LM_STUDIO_URL = '   '

    const { loadConfig } = await import('./config')

    expect(loadConfig().lmStudioUrl).toBe('http://localhost:1234')
  })

  it('loads a persisted radio home location', async () => {
    const configDir = join(tmpHome, '.config', 'helm')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify(
        {
          radioHomeLocation: {
            label: 'Operator base',
            latitude: 30.1234,
            longitude: -97.9876
          }
        },
        null,
        2
      ),
      'utf-8'
    )

    const { loadConfig } = await import('./config')

    expect(loadConfig().radioHomeLocation).toEqual({
      label: 'Operator base',
      latitude: 30.1234,
      longitude: -97.9876
    })
  })

  it('parses repo-relative env overrides for paths and HIVE settings', async () => {
    process.env.HELM_GIT_REPO_PATHS = '.,./docs'
    process.env.HELM_AGENT_FEED_PATHS = './fixtures/agents,./fixtures/agents-alt'
    process.env.HELM_LOG_FILE_PATHS = './logs/*.log'
    process.env.HELM_HIVE_ENABLED = 'true'
    process.env.HELM_HIVE_SHARED_CONTEXT_PATH = './.helm/hive/shared/context.md'
    process.env.HELM_HIVE_CLAUDE_BIN_PATH = './bin/claude'
    process.env.HELM_HIVE_IDLE_RECLAIM_MINUTES = '45'

    const { loadConfig } = await import('./config')
    const config = loadConfig()

    expect(config.gitRepoPaths).toEqual([process.cwd(), join(process.cwd(), 'docs')])
    expect(config.agentFeedPaths).toEqual([
      join(process.cwd(), 'fixtures', 'agents'),
      join(process.cwd(), 'fixtures', 'agents-alt')
    ])
    expect(config.logFilePaths).toEqual([join(process.cwd(), 'logs', '*.log')])
    expect(config.hive).toMatchObject({
      enabled: true,
      sharedContextPath: join(process.cwd(), '.helm', 'hive', 'shared', 'context.md'),
      claudeBinPath: join(process.cwd(), 'bin', 'claude'),
      idleReclaimMinutes: 45
    })
  })
})

describe('API key handling across IPC', () => {
  let tmpHome: string
  const ENV_KEYS = ['HOME', 'HELM_ENV_PATH', 'LM_STUDIO_URL', 'LLM_API_KEY'] as const
  const originalEnv = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]])
  ) as Record<(typeof ENV_KEYS)[number], string | undefined>
  const STORED_KEY = 'stored-secret-key-123'

  const configFile = (): string => join(tmpHome, '.config', 'helm', 'config.json')
  const writeStored = (data: Record<string, unknown>): void => {
    mkdirSync(join(tmpHome, '.config', 'helm'), { recursive: true })
    writeFileSync(configFile(), JSON.stringify(data, null, 2), 'utf-8')
  }
  const readStored = (): Record<string, unknown> => JSON.parse(readFileSync(configFile(), 'utf-8'))

  beforeEach(() => {
    vi.resetModules()
    tmpHome = mkdtempSync(join(tmpdir(), 'helm-config-key-'))
    process.env.HOME = tmpHome
    process.env.HELM_ENV_PATH = join(tmpHome, 'missing.env')
    delete process.env.LM_STUDIO_URL
    delete process.env.LLM_API_KEY
  })

  afterEach(() => {
    vi.resetModules()
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key]
      else process.env[key] = originalEnv[key]
    }
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('getRedactedConfig never returns the stored key and reports that one exists', async () => {
    writeStored({ lmStudioUrl: 'https://api.example.com/v1', apiKey: STORED_KEY })
    const { getRedactedConfig, loadConfig } = await import('./config')

    const redacted = getRedactedConfig()

    expect(redacted.apiKey).toBe('')
    expect(redacted.hasApiKey).toBe(true)
    expect(redacted.lmStudioUrl).toBe('https://api.example.com/v1')
    expect(JSON.stringify(redacted)).not.toContain(STORED_KEY)
    // The main process still sees the raw key for outgoing requests.
    expect(loadConfig().apiKey).toBe(STORED_KEY)
  })

  it('getRedactedConfig never returns an environment key either', async () => {
    process.env.LLM_API_KEY = 'env-secret-key-456'
    process.env.LM_STUDIO_URL = 'https://api.example.com/v1'
    const { getRedactedConfig } = await import('./config')

    const redacted = getRedactedConfig()

    expect(redacted.apiKey).toBe('')
    expect(redacted.hasApiKey).toBe(true)
    expect(JSON.stringify(redacted)).not.toContain('env-secret-key-456')
  })

  it('does not count an environment key that has no LM_STUDIO_URL next to it', async () => {
    // The key would be ignored by the model client, so the UI must not claim a key is in effect.
    process.env.LLM_API_KEY = 'env-secret-key-456'
    writeStored({ lmStudioUrl: 'https://api.example.com/v1' })
    const { getRedactedConfig } = await import('./config')

    const redacted = getRedactedConfig()

    expect(redacted.hasApiKey).toBe(false)
    expect(redacted.apiKey).toBe('')
    expect(JSON.stringify(redacted)).not.toContain('env-secret-key-456')
  })

  it('still counts a stored key when an unpaired environment key is also set', async () => {
    process.env.LLM_API_KEY = 'env-secret-key-456'
    writeStored({ lmStudioUrl: 'https://api.example.com/v1', apiKey: STORED_KEY })
    const { getRedactedConfig } = await import('./config')

    expect(getRedactedConfig().hasApiKey).toBe(true)
  })

  it('reports no key and an empty string when none is set', async () => {
    const { getRedactedConfig } = await import('./config')

    const redacted = getRedactedConfig()

    expect(redacted.apiKey).toBe('')
    expect(redacted.hasApiKey).toBe(false)
  })

  it('keeps the stored key when the renderer round-trips the redacted config', async () => {
    writeStored({ lmStudioUrl: 'https://api.example.com/v1', apiKey: STORED_KEY })
    const { getRedactedConfig, saveConfig } = await import('./config')

    // Same shape as the radio panel: read the config, change one field, save the whole thing.
    const current = getRedactedConfig()
    saveConfig({ ...current, radioHomeLocation: { label: 'Base', latitude: 1, longitude: 2 } })

    const stored = readStored()
    expect(stored.apiKey).toBe(STORED_KEY)
    expect(stored.radioHomeLocation).toEqual({ label: 'Base', latitude: 1, longitude: 2 })
    expect(stored).not.toHaveProperty('hasApiKey')
  })

  it('keeps the stored key when the incoming key is empty, blank or missing', async () => {
    writeStored({ apiKey: STORED_KEY })
    const { getRedactedConfig, saveConfig } = await import('./config')
    const base = getRedactedConfig()

    saveConfig({ ...base, apiKey: '' })
    expect(readStored().apiKey).toBe(STORED_KEY)

    saveConfig({ ...base, apiKey: '   ' })
    expect(readStored().apiKey).toBe(STORED_KEY)

    const { apiKey: _omitted, ...withoutKey } = base
    saveConfig(withoutKey)
    expect(readStored().apiKey).toBe(STORED_KEY)
  })

  it('replaces the stored key only when a new non-empty key is sent', async () => {
    writeStored({ apiKey: STORED_KEY })
    const { getRedactedConfig, saveConfig, loadConfig } = await import('./config')

    saveConfig({ ...getRedactedConfig(), apiKey: '  new-key-789  ' })

    expect(readStored().apiKey).toBe('new-key-789')
    expect(loadConfig().apiKey).toBe('new-key-789')
    expect(JSON.stringify(getRedactedConfig())).not.toContain('new-key-789')
  })

  it('stores a first key when none was stored', async () => {
    const { getRedactedConfig, saveConfig } = await import('./config')

    saveConfig({ ...getRedactedConfig(), apiKey: 'first-key' })

    expect(readStored().apiKey).toBe('first-key')
    expect(getRedactedConfig().hasApiKey).toBe(true)
  })

  it('clearStoredApiKey removes the key, and later saves do not bring it back', async () => {
    writeStored({ lmStudioUrl: 'https://api.example.com/v1', apiKey: STORED_KEY })
    const { getRedactedConfig, saveConfig, clearStoredApiKey, loadConfig } = await import('./config')

    clearStoredApiKey()

    const stored = readStored()
    expect(stored).not.toHaveProperty('apiKey')
    expect(stored.lmStudioUrl).toBe('https://api.example.com/v1')
    expect(loadConfig().apiKey).toBeUndefined()
    expect(getRedactedConfig().hasApiKey).toBe(false)

    saveConfig({ ...getRedactedConfig(), monitorInterval: 5000 })
    expect(readStored()).not.toHaveProperty('apiKey')
    expect(readStored().monitorInterval).toBe(5000)
  })

  it('clearStoredApiKey does nothing when no config file exists', async () => {
    const { clearStoredApiKey } = await import('./config')

    expect(() => clearStoredApiKey()).not.toThrow()
    expect(existsSync(configFile())).toBe(false)
  })

  it('never writes an environment key to the config file', async () => {
    process.env.LLM_API_KEY = 'env-secret-key-456'
    process.env.LM_STUDIO_URL = 'https://api.example.com/v1'
    const { getRedactedConfig, saveConfig, clearStoredApiKey } = await import('./config')

    saveConfig(getRedactedConfig())
    expect(readFileSync(configFile(), 'utf-8')).not.toContain('env-secret-key-456')
    expect(readStored()).not.toHaveProperty('apiKey')

    // Clearing the stored key does not touch the environment key.
    clearStoredApiKey()
    expect(getRedactedConfig().hasApiKey).toBe(true)
  })
})

describe('API key is bound to its endpoint', () => {
  let tmpHome: string
  const ENV_KEYS = ['HOME', 'HELM_ENV_PATH', 'LM_STUDIO_URL', 'LLM_API_KEY'] as const
  const originalEnv = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]])
  ) as Record<(typeof ENV_KEYS)[number], string | undefined>
  const HOST_A = 'https://api.example.com/v1'
  const HOST_B = 'https://other.example.net/v1'

  const configFile = (): string => join(tmpHome, '.config', 'helm', 'config.json')
  const writeStored = (data: Record<string, unknown>): void => {
    mkdirSync(join(tmpHome, '.config', 'helm'), { recursive: true })
    writeFileSync(configFile(), JSON.stringify(data, null, 2), 'utf-8')
  }
  const readStored = (): Record<string, unknown> => JSON.parse(readFileSync(configFile(), 'utf-8'))

  beforeEach(() => {
    vi.resetModules()
    tmpHome = mkdtempSync(join(tmpdir(), 'helm-config-bind-'))
    process.env.HOME = tmpHome
    process.env.HELM_ENV_PATH = join(tmpHome, 'missing.env')
    delete process.env.LM_STUDIO_URL
    delete process.env.LLM_API_KEY
  })

  afterEach(() => {
    vi.resetModules()
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key]
      else process.env[key] = originalEnv[key]
    }
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('drops the stored key when a save changes the URL and carries no new key', async () => {
    writeStored({ lmStudioUrl: HOST_A, apiKey: 'key-for-a' })
    const { getRedactedConfig, saveConfig } = await import('./config')

    saveConfig({ ...getRedactedConfig(), lmStudioUrl: HOST_B })

    const stored = readStored()
    expect(stored.lmStudioUrl).toBe(HOST_B)
    expect(stored).not.toHaveProperty('apiKey')
    expect(JSON.stringify(stored)).not.toContain('key-for-a')
  })

  it('drops the key for blank and missing keys alike, and when the URL is cleared', async () => {
    const { getRedactedConfig, saveConfig } = await import('./config')

    writeStored({ lmStudioUrl: HOST_A, apiKey: 'key-for-a' })
    saveConfig({ ...getRedactedConfig(), lmStudioUrl: HOST_B, apiKey: '   ' })
    expect(readStored()).not.toHaveProperty('apiKey')

    writeStored({ lmStudioUrl: HOST_A, apiKey: 'key-for-a' })
    const { apiKey: _omitted, ...withoutKey } = getRedactedConfig()
    saveConfig({ ...withoutKey, lmStudioUrl: HOST_B })
    expect(readStored()).not.toHaveProperty('apiKey')

    writeStored({ lmStudioUrl: HOST_A, apiKey: 'key-for-a' })
    saveConfig({ ...getRedactedConfig(), lmStudioUrl: undefined })
    expect(readStored()).not.toHaveProperty('apiKey')
  })

  it('keeps a new key that arrives together with the new URL', async () => {
    writeStored({ lmStudioUrl: HOST_A, apiKey: 'key-for-a' })
    const { getRedactedConfig, saveConfig } = await import('./config')

    saveConfig({ ...getRedactedConfig(), lmStudioUrl: HOST_B, apiKey: 'key-for-b' })

    expect(readStored()).toMatchObject({ lmStudioUrl: HOST_B, apiKey: 'key-for-b' })
  })

  it('drops the old key when main-process code resends it with a different URL', async () => {
    writeStored({ lmStudioUrl: HOST_A, apiKey: 'key-for-a' })
    const { loadConfig, saveConfig } = await import('./config')

    // Same shape as the endpoint auto-repair: the raw config with a new URL.
    saveConfig({ ...loadConfig(), lmStudioUrl: HOST_B })

    expect(readStored()).not.toHaveProperty('apiKey')
  })

  it('keeps the key when the URL is unchanged, however it is spelled', async () => {
    writeStored({ lmStudioUrl: HOST_A, apiKey: 'key-for-a' })
    const { getRedactedConfig, saveConfig } = await import('./config')

    for (const spelling of [HOST_A, 'https://api.example.com', 'https://API.example.com/v1/', ' https://api.example.com/v1 ']) {
      saveConfig({ ...getRedactedConfig(), lmStudioUrl: spelling, monitorInterval: 4000 })
      expect(readStored().apiKey).toBe('key-for-a')
    }
  })

  it('keeps the key on an unrelated save when the URL comes from LM_STUDIO_URL', async () => {
    // The key is in the config file and the URL is in .env. The renderer is shown the .env URL
    // and sends it back on every full-config save, which must not erase the key.
    writeStored({ apiKey: 'key-for-a' })
    process.env.LM_STUDIO_URL = HOST_A
    const { getRedactedConfig, saveConfig } = await import('./config')

    saveConfig({ ...getRedactedConfig(), monitorInterval: 4000 })

    expect(readStored().apiKey).toBe('key-for-a')
  })

  it('does not touch a key set only through the environment', async () => {
    writeStored({ lmStudioUrl: HOST_A })
    process.env.LLM_API_KEY = 'env-key'
    process.env.LM_STUDIO_URL = HOST_A
    const { getRedactedConfig, saveConfig } = await import('./config')

    saveConfig({ ...getRedactedConfig(), lmStudioUrl: HOST_B })

    expect(readStored()).not.toHaveProperty('apiKey')
    expect(getRedactedConfig().hasApiKey).toBe(true)
  })
})
