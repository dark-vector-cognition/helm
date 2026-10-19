import { afterEach, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '../shared/types'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  appEvents: new Map<string, () => void>(),
  windows: [] as { events: Map<string, () => void>; webContents: { send: ReturnType<typeof vi.fn> } }[],
  hiveEnabled: false,
  spawn: vi.fn(async () => ({ success: true })),
  killSession: vi.fn(),
  managedShutdown: vi.fn(),
  managedUpdate: undefined as (() => void) | undefined,
  startMonitoring: vi.fn(),
  stopMonitoring: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => '/isolated-test-profile',
    commandLine: { appendSwitch: vi.fn() },
    whenReady: () => Promise.resolve(),
    on: (event: string, callback: () => void) => mocks.appEvents.set(event, callback)
  },
  BrowserWindow: class {
    events = new Map<string, () => void>()
    webContents = {
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn()
    }
    constructor() {
      mocks.windows.push(this)
    }
    on(event: string, callback: () => void) {
      this.events.set(event, callback)
    }
    loadFile = vi.fn()
    isDestroyed = () => false
    static getAllWindows() {
      return []
    }
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => any) => {
      if (mocks.handlers.has(channel)) throw new Error(`Duplicate IPC handler: ${channel}`)
      mocks.handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => mocks.handlers.delete(channel)
  },
  Menu: { buildFromTemplate: vi.fn() },
  Tray: class {
    setToolTip = vi.fn()
    setContextMenu = vi.fn()
    on = vi.fn()
  },
  nativeImage: { createFromBuffer: vi.fn() },
  screen: {},
  shell: {},
  globalShortcut: { register: vi.fn(), unregisterAll: vi.fn() },
  dialog: {}
}))
vi.mock('@electron-toolkit/utils', () => ({
  electronApp: { setAppUserModelId: vi.fn() },
  optimizer: { watchWindowShortcuts: vi.fn() },
  is: { dev: false }
}))
vi.mock('./monitors/index', () => ({
  startMonitoring: mocks.startMonitoring,
  stopMonitoring: mocks.stopMonitoring,
  onStateUpdate: vi.fn(),
  getLatestState: () => null
}))
vi.mock('./hive/spawner', () => ({
  spawnHiveAgent: mocks.spawn,
  killHiveSession: mocks.killSession,
  listHiveSessions: vi.fn(async () => []),
  sendToHiveAgent: vi.fn(),
  attachToHiveSession: vi.fn(),
  getSessionRegistry: () => new Map()
}))
vi.mock('./hive/managed', () => ({ ManagedHive: class {
  constructor(_directory: string, _worker: string, onUpdate: () => void) { mocks.managedUpdate = onUpdate }
  launch = mocks.spawn
  shutdown = mocks.managedShutdown
  list = () => []
  agents = () => []
  has = () => false
} }))
vi.mock('./hive/context', () => ({ readSharedContext: vi.fn(), writeSharedContext: vi.fn() }))
vi.mock('./sentinel/notify', () => ({ dispatchAlert: vi.fn() }))
vi.mock('fs', () => ({
  existsSync: () => true,
  readFileSync: () =>
    JSON.stringify({
      enabled: true,
      pollIntervalMs: 30000,
      channels: {},
      rules: {}
    })
}))
vi.mock('./app-paths', () => ({
  loadEnvironment: vi.fn(),
  resolveMainAssetPath: (...parts: string[]) => parts.join('/'),
  resolvePathSetting: (value: string) => value
}))
vi.mock('./config', () => ({
  loadConfig: () => ({ hive: { enabled: mocks.hiveEnabled } }),
  getRedactedConfig: vi.fn(),
  saveConfig: vi.fn(),
  clearStoredApiKey: vi.fn()
}))
vi.mock('./db/index', () => ({ getDb: vi.fn(), closeDb: vi.fn() }))
vi.mock('./db/queries', () => ({
  getRecentSnapshots: vi.fn(),
  getAlertHistory: vi.fn(),
  getRecentBriefings: vi.fn(),
  getNotifications: vi.fn(),
  getRecentLogLines: vi.fn(),
  clearLogLines: vi.fn()
}))
vi.mock('./monitors/git', () => ({ getRepoCommitHistory: vi.fn() }))
vi.mock('./registry', () => ({
  getAgentRegistry: vi.fn(),
  getAgentById: vi.fn(),
  updateAgentEntry: vi.fn(),
  getTopAgents: vi.fn()
}))
vi.mock('./radio-relay', () => ({ getRadioRelayUrl: vi.fn(), stopRadioRelayServer: vi.fn() }))
vi.mock('./skills', () => ({ getSkillFeed: vi.fn() }))
vi.mock('./vault-client', () => ({ VaultClient: class {} }))

afterEach(() => {
  mocks.appEvents.get('before-quit')?.()
  vi.useRealTimers()
})

it('cleans up window services before reopening and respects the HIVE enable switch', async () => {
  vi.useFakeTimers()
  await import('./index')
  expect(mocks.windows).toHaveLength(1)
  expect(vi.getTimerCount()).toBe(1)

  const request = { provider: 'claude-code', role: 'builder', workingDir: '/project', objective: 'Review example' }
  const disabledResult = await mocks.handlers.get(IPC_CHANNELS.HIVE_SPAWN)!(null, request)
  expect(disabledResult).toEqual({ success: false, error: 'HIVE is disabled' })
  expect(mocks.spawn).not.toHaveBeenCalled()

  mocks.windows[0].events.get('closed')!()
  expect(mocks.stopMonitoring).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
  expect(mocks.handlers.has(IPC_CHANNELS.HIVE_SPAWN)).toBe(false)
  expect(mocks.killSession).not.toHaveBeenCalled()
  expect(mocks.managedShutdown).not.toHaveBeenCalled()
  mocks.managedUpdate!()
  expect(mocks.windows[0].webContents.send).not.toHaveBeenCalled()

  mocks.hiveEnabled = true
  expect(() => mocks.appEvents.get('activate')!()).not.toThrow()
  expect(mocks.windows).toHaveLength(2)
  expect(mocks.startMonitoring).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(1)
  expect(await mocks.handlers.get(IPC_CHANNELS.HIVE_SPAWN)!(null, request)).toEqual({
    success: true
  })
  expect(mocks.spawn).toHaveBeenCalledWith(request)
  mocks.managedUpdate!()
  expect(mocks.windows[1].webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.HIVE_SESSION_UPDATE, [])
  expect(mocks.windows[0].webContents.send).not.toHaveBeenCalled()

  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    expect(mocks.handlers.get(IPC_CHANNELS.HIVE_LAUNCH_STATE)!()).toEqual({
      enabled: false,
      reason: 'Managed agent launch is not available on Windows in this build. Monitoring remains available.'
    })
  } finally { Object.defineProperty(process, 'platform', platform) }

  mocks.windows[1].events.get('closed')!()
  expect(vi.getTimerCount()).toBe(0)
  expect(mocks.handlers.has(IPC_CHANNELS.HIVE_SPAWN)).toBe(false)
  expect(mocks.managedShutdown).not.toHaveBeenCalled()
  mocks.appEvents.get('before-quit')!()
  expect(mocks.managedShutdown).toHaveBeenCalledTimes(1)
})
