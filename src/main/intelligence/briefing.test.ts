import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { buildBriefingPrompt, buildNoModelBriefing, generateBriefing, parseBriefingResponse } from './briefing'
import type { LmStudioHealResult, SystemState } from '../../shared/types'
import { isLocalEndpoint } from '../endpoint-url'
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
  it('sends only resource totals in hosted briefing mode', () => {
    const prompt = buildBriefingPrompt(mockState, true)
    expect(prompt).toContain('35.5%')
    expect(prompt).toContain('56.3%')
    for (const privateDetail of ['my-app', 'postgres', 'claude-code', '/home/user', 'feature/auth', '3000']) {
      expect(prompt).not.toContain(privateDetail)
    }
  })

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

  it('uses a pinned hosted model and keeps identities out of its payload', async () => {
    loadConfigMock.mockReturnValue({ lmStudioUrl: 'https://openrouter.ai/api' })
    vi.mocked(healLmStudioConnection).mockResolvedValue({ ...connected, url: 'https://openrouter.ai/api', model: 'deepseek/chosen-fixture' })
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ model: 'deepseek/chosen-fixture', choices: [{ message: { content: '{"summary":"Live fixture response","alerts":[],"suggestions":[]}' } }] }) })
    const result = await generateBriefing(mockState)
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(sent.model).toBe('deepseek/chosen-fixture')
    expect(result.model).toBe('deepseek/chosen-fixture')
    expect(sent.messages[1].content).toContain('35.5%')
    expect(sent.messages[1].content).not.toContain('my-app')
    expect(sent.messages[1].content).not.toContain('/home/user')
  })

  it('sends only resource totals to any other hosted endpoint', async () => {
    for (const url of ['https://api.openai.com', 'https://api.together.xyz', 'https://llm.example.net/openai']) {
      fetchMock.mockClear()
      loadConfigMock.mockReturnValue({ lmStudioUrl: url })
      vi.mocked(healLmStudioConnection).mockResolvedValue({ ...connected, url })
      await generateBriefing(mockState)
      const content = JSON.parse(fetchMock.mock.calls[0][1].body).messages[1].content as string
      expect(content, url).toContain('35.5%')
      for (const identity of ['my-app', 'postgres', '/home/user', 'feature/auth', 'project', ':3000']) {
        expect(content, `${url} ${identity}`).not.toContain(identity)
      }
    }
  })

  it('keeps the full workspace briefing for a local network endpoint', async () => {
    for (const url of ['http://localhost:1234', 'http://192.168.1.20:1234', 'http://studio.local:1234']) {
      fetchMock.mockClear()
      loadConfigMock.mockReturnValue({ lmStudioUrl: url })
      vi.mocked(healLmStudioConnection).mockResolvedValue({ ...connected, url })
      await generateBriefing(mockState)
      const content = JSON.parse(fetchMock.mock.calls[0][1].body).messages[1].content as string
      expect(content, url).toContain('my-app')
      expect(content, url).toContain('feature/auth')
    }
  })

  it('does not claim a successful briefing for an empty provider response', async () => {
    loadConfigMock.mockReturnValue({ lmStudioUrl: 'https://api.example.com' })
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: '' } }] }) })
    const result = await generateBriefing(mockState)
    expect(result.summary).toContain('returned no briefing text')
    expect(result.model).toBeUndefined()
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

describe('generateBriefing redirects', () => {
  const servers: Server[] = []

  const listen = async (host: string, handler: Parameters<typeof createServer>[1]): Promise<number> => {
    const server = createServer(handler)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, host, resolve))
    return (server.address() as AddressInfo).port
  }

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))))
  })

  it('does not follow a local endpoint redirect to a hosted endpoint', async () => {
    // The real fetch runs. The hosted target is an IPv4-mapped address: HELM classifies it as
    // hosted, but the connection stays on this machine, so the test needs no network.
    const hostedBodies: string[] = []
    const hostedPort = await listen('::', (req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        hostedBodies.push(body)
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ choices: [{ message: { content: '{"summary":"leaked","alerts":[],"suggestions":[]}' } }] }))
      })
    })
    const hostedUrl = `http://[::ffff:127.0.0.1]:${hostedPort}/v1/chat/completions`
    expect(isLocalEndpoint(hostedUrl)).toBe(false)

    let localRequests = 0
    const localPort = await listen('127.0.0.1', (req, res) => {
      localRequests++
      req.resume()
      res.writeHead(307, { Location: hostedUrl })
      res.end()
    })
    const localUrl = `http://127.0.0.1:${localPort}`
    expect(isLocalEndpoint(localUrl)).toBe(true)

    loadConfigMock.mockReturnValue({ lmStudioUrl: localUrl })
    vi.mocked(healLmStudioConnection).mockResolvedValue({
      success: true,
      repaired: false,
      configured: true,
      message: 'reachable',
      url: localUrl,
      model: 'local-model',
      attempts: []
    })

    const result = await generateBriefing(mockState)

    expect(localRequests).toBe(1)
    expect(hostedBodies).toEqual([])
    expect(result.summary).not.toBe('leaked')
    expect(result.alerts[0]?.severity).toBe('warning')
  })
})
