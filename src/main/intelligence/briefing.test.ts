import { describe, it, expect, vi } from 'vitest'
import { buildBriefingPrompt, buildNoModelBriefing, generateBriefing, parseBriefingResponse } from './briefing'
import type { LmStudioHealResult, SystemState } from '../../shared/types'
import { healLmStudioConnection } from './lmstudio'

vi.mock('./lmstudio', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lmstudio')>()),
  healLmStudioConnection: vi.fn()
}))

const mockState: SystemState = {
  timestamp: Date.now(),
  processes: [
    {
      name: 'my-app',
      type: 'project',
      processes: [
        { pid: 1234, user: 'me', cpu: 45.2, mem: 3.1, command: 'node server.js', name: 'node' }
      ],
      totalCpu: 45.2,
      totalMem: 3.1,
      ports: [3000]
    },
    {
      name: 'postgres',
      type: 'service',
      processes: [
        { pid: 5678, user: '_postgres', cpu: 2.1, mem: 1.5, command: 'postgres', name: 'postgres' }
      ],
      totalCpu: 2.1,
      totalMem: 1.5,
      ports: [5432]
    }
  ],
  ports: [
    { port: 3000, pid: 1234, process: 'node', protocol: 'TCP', state: 'LISTEN', address: '*' },
    { port: 5432, pid: 5678, process: 'postgres', protocol: 'TCP', state: 'LISTEN', address: '*' }
  ],
  agents: [
    {
      id: 'pid:9999',
      name: 'claude-code',
      type: 'claude-code',
      status: 'active',
      source: 'process',
      pid: 9999,
      workingDir: '/home/user/project'
    }
  ],
  gitRepos: [
    {
      path: '/home/user/project',
      name: 'project',
      branch: 'feature/auth',
      dirty: true,
      untracked: 2,
      modified: 3,
      ahead: 1,
      behind: 0,
      status: 'dirty'
    }
  ],
  cpu: { usage: 35.5, cores: 10 },
  memory: { total: 32000000000, used: 18000000000, free: 14000000000, usagePercent: 56.3 }
}

describe('buildBriefingPrompt', () => {
  it('should include process groups in the prompt', () => {
    const prompt = buildBriefingPrompt(mockState)
    expect(prompt).toContain('my-app')
    expect(prompt).toContain('45.2')
    expect(prompt).toContain('port 3000')
  })

  it('should include agent info', () => {
    const prompt = buildBriefingPrompt(mockState)
    expect(prompt).toContain('claude-code')
    expect(prompt).toContain('active')
  })

  it('should include git status', () => {
    const prompt = buildBriefingPrompt(mockState)
    expect(prompt).toContain('feature/auth')
    expect(prompt).toContain('dirty')
  })

  it('should include system resources', () => {
    const prompt = buildBriefingPrompt(mockState)
    expect(prompt).toContain('35.5%')
    expect(prompt).toContain('56.3%')
  })
})

describe('parseBriefingResponse', () => {
  it('should parse a well-formed JSON response', () => {
    const raw = JSON.stringify({
      summary: 'System running normally. 2 services active.',
      alerts: [{ severity: 'warning', message: 'High CPU on my-app', source: 'processes' }],
      suggestions: ['Consider committing your changes']
    })
    const result = parseBriefingResponse(raw)
    expect(result.summary).toBe('System running normally. 2 services active.')
    expect(result.alerts).toHaveLength(1)
    expect(result.alerts[0].severity).toBe('warning')
    expect(result.suggestions).toHaveLength(1)
    expect(result.timestamp).toBeGreaterThan(0)
  })

  it('should handle response with just text (no JSON)', () => {
    const raw = 'Everything looks fine. No issues detected.'
    const result = parseBriefingResponse(raw)
    expect(result.summary).toBe('Everything looks fine. No issues detected.')
    expect(result.alerts).toEqual([])
    expect(result.suggestions).toEqual([])
  })

  it('should strip ```json code fences before parsing', () => {
    const json = JSON.stringify({
      summary: 'All good.',
      alerts: [],
      suggestions: ['Do the thing']
    })
    const fenced = '```json\n' + json + '\n```'
    const result = parseBriefingResponse(fenced)
    expect(result.summary).toBe('All good.')
    expect(result.suggestions).toEqual(['Do the thing'])
  })

  it('should strip bare ``` code fences before parsing', () => {
    const json = JSON.stringify({ summary: 'OK', alerts: [], suggestions: [] })
    const fenced = '```\n' + json + '\n```'
    const result = parseBriefingResponse(fenced)
    expect(result.summary).toBe('OK')
  })

  it('should preserve raw response for debugging', () => {
    const raw = '```json\n{"summary":"test","alerts":[],"suggestions":[]}\n```'
    const result = parseBriefingResponse(raw)
    expect(result.raw).toBe(raw)
  })
})

describe('generateBriefing without a model', () => {
  const unconfigured: LmStudioHealResult = {
    success: false,
    repaired: false,
    configured: false,
    message: 'No model configured.',
    attempts: []
  }

  it('returns a quiet no-model briefing instead of a warning when nothing is configured', async () => {
    vi.mocked(healLmStudioConnection).mockResolvedValueOnce(unconfigured)

    const result = await generateBriefing(mockState)

    expect(result.summary).toContain('No model configured')
    expect(result.alerts).toEqual([])
    expect(result.suggestions.length).toBeGreaterThan(0)
    expect(result.error).toBeUndefined()
  })

  it('still warns when a configured endpoint cannot be reached', async () => {
    vi.mocked(healLmStudioConnection).mockResolvedValueOnce({
      ...unconfigured,
      configured: true,
      message: 'LM Studio is unreachable. Checked http://10.0.0.9:1234.'
    })

    const result = await generateBriefing(mockState)

    expect(result.alerts).toHaveLength(1)
    expect(result.alerts[0].severity).toBe('warning')
  })

  it('builds the no-model briefing with the given timestamp', () => {
    expect(buildNoModelBriefing(42).timestamp).toBe(42)
  })
})
