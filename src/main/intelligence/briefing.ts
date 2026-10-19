import type { SystemState, BriefingResult } from '../../shared/types'
import { scoreSystem } from '../health'
import {
  buildAuthHeaders,
  healLmStudioConnection,
  isLmStudioConnectivityError,
  NO_MODEL_MESSAGE
} from './lmstudio'

export function buildBriefingPrompt(state: SystemState, resourcesOnly = false): string {
  const sections: string[] = []

  sections.push(
    `## System Resources\n- CPU: ${state.cpu.usage.toFixed(1)}% across ${state.cpu.cores} cores\n- Memory: ${state.memory.usagePercent.toFixed(1)}% used (${(state.memory.used / 1e9).toFixed(1)}GB / ${(state.memory.total / 1e9).toFixed(1)}GB)`
  )

  if (resourcesOnly) return sections.join('\n\n')

  if (state.processes.length > 0) {
    const procLines = state.processes.map((g) => {
      const ports = g.ports.length > 0 ? ` (port ${g.ports.join(', ')})` : ''
      return `- ${g.name} [${g.type}]: CPU ${g.totalCpu.toFixed(1)}%, MEM ${g.totalMem.toFixed(1)}%${ports}`
    })
    sections.push(`## Active Process Groups\n${procLines.join('\n')}`)
  }

  if (state.agents.length > 0) {
    const agentLines = state.agents.map(
      (a) => `- ${a.name} (${a.type}): ${a.source === 'process' ? 'task status unknown (process presence only)' : `${a.status} (agent state feed)`}${a.workingDir ? ` in ${a.workingDir}` : ''}`
    )
    sections.push(`## AI Agents\n${agentLines.join('\n')}`)
  }

  if (state.gitRepos.length > 0) {
    const repoLines = state.gitRepos.map((r) => {
      const parts = [`${r.name}: ${r.branch} (${r.status})`]
      if (r.modified > 0) parts.push(`${r.modified} modified`)
      if (r.untracked > 0) parts.push(`${r.untracked} untracked`)
      if (r.ahead > 0) parts.push(`${r.ahead} ahead`)
      if (r.behind > 0) parts.push(`${r.behind} behind`)
      return `- ${parts.join(', ')}`
    })
    sections.push(`## Git Repositories\n${repoLines.join('\n')}`)
  }

  const listeningPorts = state.ports.filter((p) => p.state === 'LISTEN')
  if (listeningPorts.length > 0) {
    const portLines = listeningPorts.map((p) => `- :${p.port} (${p.process}, ${p.protocol})`)
    sections.push(`## Listening Ports\n${portLines.join('\n')}`)
  }

  // Health scoring
  const healthResult = scoreSystem(state.processes, state.gitRepos, new Set())
  const unhealthy = healthResult.workspaces.filter((w) => w.level !== 'green')
  if (unhealthy.length > 0) {
    const healthLines = unhealthy.map(
      (w) => `- ${w.name}: ${w.level.toUpperCase()} - ${w.reasons.join(', ')}`
    )
    sections.push(`## Health Alerts\n${healthLines.join('\n')}`)
  }

  return sections.join('\n\n')
}

/**
 * Strip markdown code fences that some models wrap around JSON.
 * Handles ```json ... ```, ``` ... ```, and leading/trailing whitespace.
 */
function stripCodeFences(text: string): string {
  let cleaned = text.trim()
  // Remove ```json or ``` prefix
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '')
  // Remove trailing ```
  cleaned = cleaned.replace(/\n?```\s*$/, '')
  return cleaned.trim()
}

export function parseBriefingResponse(raw: string): BriefingResult {
  const cleaned = stripCodeFences(raw)
  try {
    const parsed = JSON.parse(cleaned)
    return {
      summary: parsed.summary || cleaned,
      alerts: Array.isArray(parsed.alerts) ? parsed.alerts : [],
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
      raw,
      timestamp: Date.now()
    }
  } catch {
    return {
      summary: raw.trim(),
      alerts: [],
      suggestions: [],
      raw,
      timestamp: Date.now()
    }
  }
}

const SYSTEM_PROMPT = `You are HELM, an AI operations officer providing concise system briefings.

Respond with ONLY a valid JSON object. No markdown, no code fences, no explanation. Just raw JSON.

Required JSON shape:
{"summary":"2-3 sentence overview","alerts":[{"severity":"info|warning|critical","message":"...","source":"processes|ports|agents|git|memory|cpu"}],"suggestions":["actionable suggestion 1"]}

Rules:
- Be concise. This is a dashboard briefing, not a report.
- Only raise alerts for things that actually need attention.
- Suggestions should be actionable (e.g. "commit changes on project X", "agent idle - consider assigning work").
- CPU > 80% = warning. CPU > 95% = critical.
- Memory > 85% = warning. Memory > 95% = critical.
- Dirty git repos with uncommitted changes for context = info suggestion.
- An agent-reported "waiting" status can need operator attention.
- Process presence or CPU use does not establish task status, progress or completion. Unknown task status is not idle or waiting.`

/** The model is optional. With no endpoint configured this is a normal, quiet state, not a failure. */
export function buildNoModelBriefing(timestamp = Date.now()): BriefingResult {
  return {
    summary: NO_MODEL_MESSAGE,
    alerts: [],
    suggestions: [
      'Optional: run any OpenAI-compatible server (LM Studio, Ollama, llama.cpp) and set LM_STUDIO_URL to its address'
    ],
    timestamp
  }
}

export async function generateBriefing(state: SystemState): Promise<BriefingResult> {
  const connection = await healLmStudioConnection({ persist: true })

  if (!connection.success || !connection.url) {
    if (!connection.configured) return buildNoModelBriefing()

    return {
      summary: connection.message,
      alerts: [
        {
          severity: 'warning',
          message: connection.message,
          source: 'briefing'
        }
      ],
      suggestions: ['Start LM Studio local server or repair the configured endpoint'],
      timestamp: Date.now()
    }
  }

  try {
    const hosted = ['openrouter.ai', 'api.deepseek.com'].includes(new URL(connection.url).hostname)
    const prompt = buildBriefingPrompt(state, hosted)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 120000)

    const response = await fetch(`${connection.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildAuthHeaders(connection.url) },
      body: JSON.stringify({
        model: connection.model || 'local-model',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt }
        ],
        max_tokens: 512,
        temperature: 0.3
      }),
      signal: controller.signal
    })

    clearTimeout(timeout)

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`LM Studio returned ${response.status}: ${body}`)
    }

    const data = await response.json()
    const text = data.choices?.[0]?.message?.content
    if (typeof text !== 'string' || !text.trim()) throw new Error('The model returned no briefing text. Retry the request.')
    const result = parseBriefingResponse(text)
    result.model = typeof data.model === 'string' ? data.model : connection.model

    if (connection.repaired && connection.previousUrl) {
      result.alerts = [
        {
          severity: 'info',
          message: `LM Studio endpoint auto-repaired to ${connection.url}`,
          source: 'briefing'
        },
        ...result.alerts
      ]
      result.suggestions = [
        `HELM switched from ${connection.previousUrl} to ${connection.url}.`,
        ...result.suggestions
      ]
    }

    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    const isOffline = isLmStudioConnectivityError(message)

    return {
      summary: isOffline
        ? `LM Studio offline - unable to reach ${connection.url}`
        : `Briefing failed: ${message}`,
      alerts: [
        {
          severity: 'warning',
          message: isOffline
            ? 'LM Studio is not reachable. Start the local server or repair the endpoint.'
            : `LM Studio error: ${message}`,
          source: 'briefing'
        }
      ],
      suggestions: isOffline
        ? ['Retry after LM Studio is serving the OpenAI-compatible API']
        : ['Check LM Studio server logs'],
      timestamp: Date.now()
    }
  }
}
