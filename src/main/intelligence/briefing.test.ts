import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { buildBriefingPrompt, buildNoModelBriefing, generateBriefing, parseBriefingResponse } from './briefing'
import type { LmStudioHealResult, SystemState } from '../../shared/types'
import { healLmStudioConnection } from './lmstudio'

const { loadConfigMock } = vi.hoisted(() => ({ loadConfigMock: vi.fn() }))

vi.mock('../config', () => ({ loadConfig: loadConfigMock, saveConfig: vi.fn() }))

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
    expect(prompt).toContain('task status unknown (process presence only)')
  })

  it('keeps reported feed state distinct from process evidence', () => {
    const prompt = buildBriefingPrompt({ ...mockState, agents: [
      { ...mockState.agents[0], source: 'state-file', status: 'waiting' }
    ] })
    expect(prompt).toContain('waiting (agent state feed)')
    expect(prompt).not.toContain('process presence only')
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

describe('generateBriefing API key header', () => {
  const savedEnvKey = process.env.LLM_API_KEY
  const savedEnvUrl = process.env.LM_STUDIO_URL
  const fetchMock = vi.fn()

  const connected: LmStudioHealResult = {
    success: true,
    repaired: false,
    configured: true,
    message: 'reachable',
    url: 'https://api.example.com',
    model: 'hosted-model',
    attempts: []
  }

  const sentHeaders = (): Record<string, string> =>
    (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.LLM_API_KEY
    delete process.env.LM_STUDIO_URL
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"summary":"ok","alerts":[],"suggestions":[]}' } }]
      })
    })
    vi.mocked(healLmStudioConnection).mockResolvedValue(connected)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (savedEnvKey === undefined) delete process.env.LLM_API_KEY
    else process.env.LLM_API_KEY = savedEnvKey
    if (savedEnvUrl === undefined) delete process.env.LM_STUDIO_URL
    else process.env.LM_STUDIO_URL = savedEnvUrl
  })

  it('sends the configured key as a bearer token', async () => {
    loadConfigMock.mockReturnValue({ lmStudioUrl: 'https://api.example.com/v1', apiKey: 'cfg-key' })

    await generateBriefing(mockState)

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/chat/completions')
    expect(sentHeaders()).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer cfg-key'
    })
  })

  it('sends no Authorization header when no key is set', async () => {
    loadConfigMock.mockReturnValue({ lmStudioUrl: 'https://api.example.com/v1' })

    await generateBriefing(mockState)

    expect(sentHeaders()).toEqual({ 'Content-Type': 'application/json' })
    expect(sentHeaders()).not.toHaveProperty('Authorization')
  })

  it('prefers LLM_API_KEY over the config key when LM_STUDIO_URL names the endpoint', async () => {
    loadConfigMock.mockReturnValue({ lmStudioUrl: 'https://api.example.com/v1', apiKey: 'cfg-key' })
    process.env.LLM_API_KEY = 'env-key'
    process.env.LM_STUDIO_URL = 'https://api.example.com/v1'

    await generateBriefing(mockState)

    expect(sentHeaders().Authorization).toBe('Bearer env-key')
  })

  it('sends no key for an LLM_API_KEY that has no LM_STUDIO_URL next to it', async () => {
    loadConfigMock.mockReturnValue({ lmStudioUrl: 'https://api.example.com/v1' })
    process.env.LLM_API_KEY = 'env-key'

    await generateBriefing(mockState)

    expect(sentHeaders()).toEqual({ 'Content-Type': 'application/json' })
  })

  it('keeps the key out of the request body and the returned briefing', async () => {
    loadConfigMock.mockReturnValue({ lmStudioUrl: 'https://api.example.com/v1', apiKey: 'cfg-key' })

    const result = await generateBriefing(mockState)

    expect(String((fetchMock.mock.calls[0][1] as { body: string }).body)).not.toContain('cfg-key')
    expect(JSON.stringify(result)).not.toContain('cfg-key')
  })
})
