import { basename } from 'node:path'
import type { AgentInfo } from '../../shared/types'
import { runFile } from '../monitors/shell-run'

const CLIENTS: Partial<Record<AgentInfo['type'], { name: string; executables: string[] }>> = {
  'claude-code': { name: 'Claude Code', executables: ['claude'] },
  codex: { name: 'Codex', executables: ['codex'] },
  cursor: { name: 'Cursor', executables: ['cursor', 'cursor-agent'] },
  gemini: { name: 'Gemini', executables: ['gemini'] },
  aider: { name: 'Aider', executables: ['aider'] }
}

const LAUNCHERS = new Set(['node', 'nodejs', 'npm', 'npx', 'sh', 'bash', 'env'])

interface ProcessIdentity {
  parent: number
  startedAt: number
  executable: string
}

export function connectorAgentMatcher(sample: string, agents: AgentInfo[], uid: number) {
  const processes = new Map<number, ProcessIdentity>()
  for (const line of sample.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3} \w{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.+?)\s*$/)
    if (!match || Number(match[3]) !== uid) continue
    const startedAt = Date.parse(match[4])
    if (!Number.isFinite(startedAt)) continue
    processes.set(Number(match[1]), {
      parent: Number(match[2]), startedAt, executable: basename(match[5]).toLowerCase()
    })
  }

  const known = new Map<number, string>()
  for (const agent of agents) {
    if (!agent.pid) continue
    const client = CLIENTS[agent.type]
    const identity = processes.get(agent.pid)
    if (client && identity && client.executables.includes(identity.executable)) {
      known.set(agent.pid, client.name)
    }
  }

  return (serverPid: number, sessionStartedAt: number): { name: string; pid: number } | undefined => {
    const server = processes.get(serverPid)
    if (!server || Math.abs(server.startedAt - sessionStartedAt) > 2000) return
    let pid = server.parent
    let latestStart = server.startedAt
    // Only follow live, same-user launcher processes. A matching client label alone is insufficient.
    for (let level = 0; level < 8 && pid > 1; level++) {
      const parent = processes.get(pid)
      if (!parent || parent.startedAt > latestStart) return
      if (level === 0 && !['node', 'nodejs'].includes(parent.executable)) return
      const name = known.get(pid)
      if (name) return { name, pid }
      if (!LAUNCHERS.has(parent.executable) || parent.parent === pid) return
      latestStart = parent.startedAt
      pid = parent.parent
    }
    return
  }
}

export async function sampleConnectorAgents(agents: AgentInfo[]) {
  if (!agents.some((agent) => agent.pid && CLIENTS[agent.type]) ||
      (process.platform !== 'darwin' && process.platform !== 'linux')) return undefined
  try {
    const sample = await runFile('/usr/bin/env', [
      'LC_ALL=C', '/bin/ps', '-axo', 'pid=,ppid=,uid=,lstart=,comm='
    ], { timeout: 1500 })
    return connectorAgentMatcher(sample, agents, process.getuid!())
  } catch {
    return undefined
  }
}
