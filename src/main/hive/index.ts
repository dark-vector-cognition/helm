import { app, ipcMain, type BrowserWindow } from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import { IPC_CHANNELS } from '../../shared/types'
import type {
  HiveConfig,
  HiveRoleTemplate,
  HiveSpawnRequest,
  HiveSessionInfo
} from '../../shared/types'
import { resolveMainAssetPath } from '../app-paths'
import {
  killHiveSession,
  listHiveSessions,
  sendToHiveAgent,
  attachToHiveSession,
  getSessionRegistry
} from './spawner'
import { readSharedContext, writeSharedContext } from './context'
import { ManagedHive } from './managed'
import type { AgentInfo } from '../../shared/types'

let managed: ManagedHive | undefined
let managedError = ''
let notifyManaged: () => void = () => {}

const BUILT_IN_ROLES: HiveRoleTemplate[] = [
  {
    name: 'architect',
    displayName: 'Architect',
    model: 'opus',
    claudeMdPath: resolveMainAssetPath('hive', 'roles', 'architect.md'),
    description: 'System design, planning, and architectural decisions'
  },
  {
    name: 'builder',
    displayName: 'Builder',
    model: 'sonnet',
    claudeMdPath: resolveMainAssetPath('hive', 'roles', 'builder.md'),
    description: 'Implementation, code, tests, and prototypes'
  },
  {
    name: 'analyst',
    displayName: 'Analyst',
    model: 'sonnet',
    claudeMdPath: resolveMainAssetPath('hive', 'roles', 'analyst.md'),
    description: 'Research, data analysis, and investigation'
  },
  {
    name: 'ops',
    displayName: 'Ops',
    model: 'sonnet',
    claudeMdPath: resolveMainAssetPath('hive', 'roles', 'ops.md'),
    description: 'Infrastructure, automation, CI/CD, and reliability'
  }
]

export function getDefaultHiveConfig(): HiveConfig {
  return {
    enabled: false,
    roles: BUILT_IN_ROLES,
    defaultModel: 'sonnet',
    sharedContextPath: join(homedir(), '.config', 'helm', 'hive', 'shared', 'context.md'),
    tmuxSessionPrefix: 'helm-hive',
    claudeBinPath: 'claude',
    idleReclaimMinutes: 30
  }
}

export function resolveHiveConfig(userConfig?: Partial<HiveConfig>): HiveConfig {
  const defaults = getDefaultHiveConfig()
  if (!userConfig) return defaults
  return {
    ...defaults,
    ...userConfig,
    roles: userConfig.roles ?? defaults.roles
  }
}

export function setupHiveIPC(mainWindow: BrowserWindow, hiveConfig: HiveConfig): void {
  notifyManaged = () => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(IPC_CHANNELS.HIVE_SESSION_UPDATE, managed?.list() ?? [])
  }
  try {
    managed ??= new ManagedHive(join(app.getPath('userData'), 'hive-runs'), join(__dirname, 'hive-worker.js'), () => notifyManaged(), hiveConfig.claudeBinPath)
  } catch (error) { managedError = error instanceof Error ? error.message : 'Run journal unavailable.' }
  ipcMain.handle(IPC_CHANNELS.HIVE_LAUNCH_STATE, () => ({
    enabled: hiveConfig.enabled && process.platform !== 'win32',
    reason: process.platform === 'win32'
      ? 'Managed agent launch is not available on Windows in this build. Monitoring remains available.'
      : !hiveConfig.enabled ? 'Agent launch is disabled in this installation. Monitoring remains available.' : undefined
  }))
  ipcMain.handle(IPC_CHANNELS.HIVE_RETRY, (_event, id: string) => {
    if (!hiveConfig.enabled) return { success: false, error: 'HIVE is disabled' }
    return managed?.retry(id) ?? { success: false, error: managedError }
  })
  ipcMain.handle(IPC_CHANNELS.HIVE_REVIEW, (_event, id: string) => managed?.review(id) ?? { success: false, error: managedError })
  ipcMain.handle(IPC_CHANNELS.HIVE_SPAWN, async (_event, request: HiveSpawnRequest) => {
    if (!hiveConfig.enabled) return { success: false, error: 'HIVE is disabled' }
    if (request?.provider) return managed?.launch(request) ?? { success: false, error: managedError }
    return { success: false, error: 'Choose a provider in the V6 launcher. Legacy terminal launch is disabled.' }
  })

  ipcMain.handle(IPC_CHANNELS.HIVE_KILL_SESSION, async (_event, sessionId: string) => {
    if (managed?.has(sessionId)) return managed.stop(sessionId)
    const result = await killHiveSession(sessionId)
    if (result.success && !mainWindow.isDestroyed()) {
      const sessions = await listHiveSessions(hiveConfig.tmuxSessionPrefix)
      mainWindow.webContents.send(IPC_CHANNELS.HIVE_SESSION_UPDATE, sessions)
    }
    return result
  })

  ipcMain.handle(IPC_CHANNELS.HIVE_LIST_SESSIONS, async () => {
    return [...(managed?.list() ?? []), ...await listHiveSessions(hiveConfig.tmuxSessionPrefix)]
  })

  ipcMain.handle(IPC_CHANNELS.HIVE_SEND_MESSAGE, async (_event, sessionId: string, message: string) => {
    if (managed?.has(sessionId)) return { success: false, error: 'Managed objectives are fixed. Launch a new task after review.' }
    return sendToHiveAgent(sessionId, message)
  })

  ipcMain.handle(IPC_CHANNELS.HIVE_UPDATE_CONTEXT, async (_event, objective: string, sections?: Record<string, string>) => {
    writeSharedContext(hiveConfig.sharedContextPath, objective, sections)
    return { success: true }
  })

  ipcMain.handle(IPC_CHANNELS.HIVE_GET_CONTEXT, async () => {
    return readSharedContext(hiveConfig.sharedContextPath)
  })

  ipcMain.handle(IPC_CHANNELS.HIVE_ATTACH, async (_event, sessionId: string) => {
    const session = getSessionRegistry().get(sessionId)
    if (!session) return { success: false, error: 'Session not found' }
    return attachToHiveSession(session.tmuxSession, session.tmuxWindow)
  })
}

export function teardownHive(): void {
  managed?.shutdown()
  notifyManaged = () => {}
  ipcMain.removeHandler(IPC_CHANNELS.HIVE_LAUNCH_STATE)
  ipcMain.removeHandler(IPC_CHANNELS.HIVE_RETRY)
  ipcMain.removeHandler(IPC_CHANNELS.HIVE_REVIEW)
  ipcMain.removeHandler(IPC_CHANNELS.HIVE_SPAWN)
  ipcMain.removeHandler(IPC_CHANNELS.HIVE_KILL_SESSION)
  ipcMain.removeHandler(IPC_CHANNELS.HIVE_LIST_SESSIONS)
  ipcMain.removeHandler(IPC_CHANNELS.HIVE_SEND_MESSAGE)
  ipcMain.removeHandler(IPC_CHANNELS.HIVE_UPDATE_CONTEXT)
  ipcMain.removeHandler(IPC_CHANNELS.HIVE_GET_CONTEXT)
  ipcMain.removeHandler(IPC_CHANNELS.HIVE_ATTACH)
}

/**
 * Cross-reference detected agents with active HIVE sessions.
 * Call this during monitor cycle to decorate AgentInfo entries.
 */
export function decorateAgentsWithHive(
  agents: { pid?: number; tmuxSession?: string; hiveSessionId?: string; hiveRole?: string }[],
  hivePrefix: string
): void {
  const registry = getSessionRegistry()
  if (registry.size === 0) return

  const sessionsByPid = new Map<number, HiveSessionInfo>()
  const sessionsByTmux = new Map<string, HiveSessionInfo>()

  for (const session of registry.values()) {
    if (session.pid) sessionsByPid.set(session.pid, session)
    sessionsByTmux.set(`${session.tmuxSession}:${session.tmuxWindow}`, session)
  }

  for (const agent of agents) {
    // Match by PID
    if (agent.pid && sessionsByPid.has(agent.pid)) {
      const session = sessionsByPid.get(agent.pid)!
      agent.hiveSessionId = session.id
      agent.hiveRole = session.role
      continue
    }
    // Match by tmux session name
    if (agent.tmuxSession) {
      for (const [, session] of sessionsByTmux) {
        if (agent.tmuxSession === session.tmuxSession || agent.tmuxSession.includes(hivePrefix)) {
          agent.hiveSessionId = session.id
          agent.hiveRole = session.role
          break
        }
      }
    }
  }
}

export function getManagedAgents(): AgentInfo[] {
  return (managed?.list() ?? []).map((run) => ({
    id: `hive:${run.id}`, name: `${run.provider} ${run.role}`, type: run.provider!, source: 'state-file',
    status: run.taskState === 'working' ? 'active' : run.taskState === 'needs-review' ? 'waiting' : run.taskState === 'reviewed' ? 'idle' : 'unknown',
    pid: run.status === 'running' ? run.pid : undefined, workingDir: run.workingDir,
    agentId: run.id, hiveSessionId: run.id, hiveRole: run.role, lastHeartbeat: run.lastEventAt,
    currentAction: run.events?.at(-1)?.message
  }))
}
