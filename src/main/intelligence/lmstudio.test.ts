import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const loadConfig = vi.fn()
const saveConfig = vi.fn()
const networkInterfaces = vi.fn()
const exec = vi.fn()

vi.mock('../config', () => ({
  loadConfig,
  saveConfig
}))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    networkInterfaces
  }
})

vi.mock('child_process', () => ({
  exec
}))

describe('healLmStudioConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.LLM_API_KEY
    loadConfig.mockReturnValue({
      gitRepoPaths: [],
      monitorInterval: 2000,
      snapshotInterval: 30000,
      lmStudioUrl: 'http://10.55.0.10:1234'
    })
    networkInterfaces.mockReturnValue({})
    exec.mockImplementation((_command, _options, callback) => {
      callback(null, { stdout: '', stderr: '' })
    })
  })

  it('repairs a stale configured URL by falling back to localhost', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'http://10.55.0.10:1234/v1/models') {
        throw new Error('fetch failed')
      }

      return {
        ok: true,
        json: async () => ({ data: [{ id: 'mistral-local' }] })
      } as Response
    })

    const { healLmStudioConnection } = await import('./lmstudio')
    const result = await healLmStudioConnection({ persist: true, fetchImpl: fetchImpl as typeof fetch })

    expect(result.success).toBe(true)
    expect(result.repaired).toBe(true)
    expect(result.url).toBe('http://localhost:1234')
    expect(result.model).toBe('mistral-local')
    expect(result.previousUrl).toBe('http://10.55.0.10:1234')
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ lmStudioUrl: 'http://localhost:1234' })
    )
  })

  it('pins the configured model instead of using the first catalog entry', async () => {
    loadConfig.mockReturnValue({ lmStudioUrl: 'https://api.example.com', lmStudioModel: 'deepseek/chosen-fixture', apiKey: 'fixture' })
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ data: [{ id: 'unrelated-first' }, { id: 'deepseek/chosen-fixture' }] }) }) as Response)
    const { healLmStudioConnection } = await import('./lmstudio')
    const result = await healLmStudioConnection({ fetchImpl: fetchImpl as typeof fetch })
    expect(result.model).toBe('deepseek/chosen-fixture')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does not rewrite config when the configured endpoint is already healthy', async () => {
    const fetchImpl = vi.fn(async () => {
      return {
        ok: true,
        json: async () => ({ data: [{ id: 'healthy-model' }] })
      } as Response
    })

    const { healLmStudioConnection } = await import('./lmstudio')
    const result = await healLmStudioConnection({ persist: true, fetchImpl: fetchImpl as typeof fetch })

    expect(result.success).toBe(true)
    expect(result.repaired).toBe(false)
    expect(result.url).toBe('http://10.55.0.10:1234')
    expect(saveConfig).not.toHaveBeenCalled()
  })

  it('repairs a stale remote URL by scanning ARP neighbors', async () => {
    exec.mockImplementation((_command, _options, callback) => {
      callback(null, {
        stdout: '? (10.55.0.11) at aa:bb:cc:dd:ee:ff on en0 ifscope [ethernet]\n',
        stderr: ''
      })
    })

    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'http://10.55.0.10:1234/v1/models') {
        throw new Error('connect ETIMEDOUT 10.55.0.10:1234')
      }

      if (url === 'http://10.55.0.11:1234/v1/models') {
        return {
          ok: true,
          json: async () => ({ data: [{ id: 'qwen-neighbor' }] })
        } as Response
      }

      throw new Error(`unexpected url: ${url}`)
    })

    const { healLmStudioConnection } = await import('./lmstudio')
    const result = await healLmStudioConnection({ persist: true, fetchImpl: fetchImpl as typeof fetch })

    expect(result.success).toBe(true)
    expect(result.repaired).toBe(true)
    expect(result.url).toBe('http://10.55.0.11:1234')
    expect(result.model).toBe('qwen-neighbor')
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ lmStudioUrl: 'http://10.55.0.11:1234' })
    )
  })

  it('repairs a stale remote URL by sweeping the saved subnet when ARP is empty', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'http://10.55.0.22:1234/v1/models') {
        return {
          ok: true,
          json: async () => ({ data: [{ id: 'qwen-subnet' }] })
        } as Response
      }

      throw new Error(`connect ECONNREFUSED ${url}`)
    })

    const { healLmStudioConnection } = await import('./lmstudio')
    const result = await healLmStudioConnection({ persist: true, fetchImpl: fetchImpl as typeof fetch })

    expect(result.success).toBe(true)
    expect(result.repaired).toBe(true)
    expect(result.url).toBe('http://10.55.0.22:1234')
    expect(result.model).toBe('qwen-subnet')
    expect(result.previousUrl).toBe('http://10.55.0.10:1234')
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ lmStudioUrl: 'http://10.55.0.22:1234' })
    )
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://10.55.0.22:1234/v1/models',
      expect.objectContaining({ headers: {} })
    )
  })

  it('reports the checked endpoints when nothing is reachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:1234')
    })

    const { healLmStudioConnection, isLmStudioConnectivityError, parseArpNeighborIps } = await import('./lmstudio')
    const result = await healLmStudioConnection({ persist: true, fetchImpl: fetchImpl as typeof fetch })

    expect(result.success).toBe(false)
    expect(result.message).toContain('Checked')
    expect(result.message).toContain('Serve on Local Network')
    expect(result.attempts.length).toBeGreaterThan(0)
    expect(isLmStudioConnectivityError('fetch failed')).toBe(true)
    expect(isLmStudioConnectivityError('connect ECONNREFUSED 127.0.0.1:1234')).toBe(true)
    expect(
      parseArpNeighborIps('? (10.55.0.10) at aa:bb:cc:dd:ee:ff on en8 ifscope [ethernet]\n? (8.8.8.8) at aa:bb:cc:dd:ee:ff on en8 ifscope [ethernet]')
    ).toEqual(['10.55.0.10'])
  })
})

describe('healLmStudioConnection with no model configured', () => {
  const savedEnvUrl = process.env.LM_STUDIO_URL

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.LM_STUDIO_URL
    loadConfig.mockReturnValue({
      gitRepoPaths: [],
      monitorInterval: 2000,
      snapshotInterval: 30000
    })
    networkInterfaces.mockReturnValue({
      en0: [{ family: 'IPv4', address: '10.55.0.5' }]
    })
    exec.mockImplementation((_command, _options, callback) => {
      callback(null, {
        stdout: '? (10.55.0.11) at aa:bb:cc:dd:ee:ff on en0 ifscope [ethernet]\n',
        stderr: ''
      })
    })
  })

  afterEach(() => {
    if (savedEnvUrl === undefined) delete process.env.LM_STUDIO_URL
    else process.env.LM_STUDIO_URL = savedEnvUrl
  })

  it('reports a quiet not-configured state and only probes this machine', async () => {
    const fetchImpl = vi.fn(async (_url: string) => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:1234')
    })

    const { healLmStudioConnection, NO_MODEL_MESSAGE } = await import('./lmstudio')
    const result = await healLmStudioConnection({ persist: true, fetchImpl: fetchImpl as typeof fetch })

    expect(result.success).toBe(false)
    expect(result.configured).toBe(false)
    expect(result.message).toBe(NO_MODEL_MESSAGE)
    expect(result.message).not.toMatch(/unreachable|offline/i)
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      'http://localhost:1234/v1/models',
      'http://127.0.0.1:1234/v1/models'
    ])
    expect(exec).not.toHaveBeenCalled()
    expect(saveConfig).not.toHaveBeenCalled()
  })

  it('still finds a local server on the default port without saving anything', async () => {
    const fetchImpl = vi.fn(async (_url: string) => {
      return {
        ok: true,
        json: async () => ({ data: [{ id: 'local-default' }] })
      } as Response
    })

    const { healLmStudioConnection } = await import('./lmstudio')
    const result = await healLmStudioConnection({ persist: true, fetchImpl: fetchImpl as typeof fetch })

    expect(result.success).toBe(true)
    expect(result.configured).toBe(false)
    expect(result.repaired).toBe(false)
    expect(result.url).toBe('http://localhost:1234')
    expect(result.model).toBe('local-default')
    expect(saveConfig).not.toHaveBeenCalled()
  })

  it('treats an endpoint from LM_STUDIO_URL as configured', async () => {
    process.env.LM_STUDIO_URL = 'http://127.0.0.1:11434'
    const fetchImpl = vi.fn(async (_url: string) => {
      throw new Error('connect ECONNREFUSED')
    })

    const { healLmStudioConnection } = await import('./lmstudio')
    const result = await healLmStudioConnection({ persist: false, fetchImpl: fetchImpl as typeof fetch })

    expect(result.success).toBe(false)
    expect(result.configured).toBe(true)
    expect(result.message).toContain('Checked')
    expect(fetchImpl.mock.calls[0][0]).toBe('http://127.0.0.1:11434/v1/models')
  })
})

describe('optional API key', () => {
  const savedEnvKey = process.env.LLM_API_KEY
  const savedEnvUrl = process.env.LM_STUDIO_URL
  const HOSTED = 'https://api.example.com/v1'

  const okResponse = (): Response =>
    ({ ok: true, json: async () => ({ data: [{ id: 'hosted-model' }] }) }) as Response

  const sentHeaders = (fetchImpl: ReturnType<typeof vi.fn>, index = 0): Record<string, string> =>
    (fetchImpl.mock.calls[index][1] as { headers: Record<string, string> }).headers

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.LLM_API_KEY
    delete process.env.LM_STUDIO_URL
    networkInterfaces.mockReturnValue({})
    exec.mockImplementation((_command, _options, callback) => {
      callback(null, { stdout: '', stderr: '' })
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (savedEnvKey === undefined) delete process.env.LLM_API_KEY
    else process.env.LLM_API_KEY = savedEnvKey
    if (savedEnvUrl === undefined) delete process.env.LM_STUDIO_URL
    else process.env.LM_STUDIO_URL = savedEnvUrl
  })

  it('sends Authorization: Bearer <key> to the configured endpoint when apiKey is in the config file', async () => {
    loadConfig.mockReturnValue({ lmStudioUrl: HOSTED, apiKey: 'cfg-key' })
    const fetchImpl = vi.fn(async (_url: string, _init?: unknown) => okResponse())

    const { healLmStudioConnection } = await import('./lmstudio')
    const result = await healLmStudioConnection({ fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(result.success).toBe(true)
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.example.com/v1/models')
    expect(sentHeaders(fetchImpl)).toEqual({ Authorization: 'Bearer cfg-key' })
  })

  it('sends no Authorization header when no key is set', async () => {
    loadConfig.mockReturnValue({ lmStudioUrl: HOSTED })
    const fetchImpl = vi.fn(async (_url: string, _init?: unknown) => okResponse())

    const { healLmStudioConnection } = await import('./lmstudio')
    await healLmStudioConnection({ fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(sentHeaders(fetchImpl)).toEqual({})
    expect(sentHeaders(fetchImpl)).not.toHaveProperty('Authorization')
  })

  it('treats an empty or whitespace-only key as not set', async () => {
    loadConfig.mockReturnValue({ lmStudioUrl: HOSTED, apiKey: '   ' })
    process.env.LLM_API_KEY = '  '
    const fetchImpl = vi.fn(async (_url: string, _init?: unknown) => okResponse())

    const { healLmStudioConnection } = await import('./lmstudio')
    await healLmStudioConnection({ fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(sentHeaders(fetchImpl)).toEqual({})
  })

  it('lets LLM_API_KEY override the config file key when LM_STUDIO_URL names the endpoint', async () => {
    loadConfig.mockReturnValue({ lmStudioUrl: HOSTED, apiKey: 'cfg-key' })
    process.env.LLM_API_KEY = 'env-key'
    process.env.LM_STUDIO_URL = HOSTED
    const fetchImpl = vi.fn(async (_url: string, _init?: unknown) => okResponse())

    const { healLmStudioConnection } = await import('./lmstudio')
    await healLmStudioConnection({ fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(sentHeaders(fetchImpl)).toEqual({ Authorization: 'Bearer env-key' })
  })

  it('uses the environment key alone when the config file has none', async () => {
    loadConfig.mockReturnValue({ lmStudioUrl: HOSTED })
    process.env.LLM_API_KEY = ' env-key '
    process.env.LM_STUDIO_URL = HOSTED
    const fetchImpl = vi.fn(async (_url: string, _init?: unknown) => okResponse())

    const { healLmStudioConnection } = await import('./lmstudio')
    await healLmStudioConnection({ fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(sentHeaders(fetchImpl)).toEqual({ Authorization: 'Bearer env-key' })
  })

  it('sends the environment key to the LM_STUDIO_URL endpoint under any spelling of it', async () => {
    process.env.LLM_API_KEY = 'env-key'
    process.env.LM_STUDIO_URL = 'https://api.example.com'
    const { buildAuthHeaders } = await import('./lmstudio')
    const config = { lmStudioUrl: 'https://api.example.com' }

    for (const url of [
      'https://api.example.com',
      'https://api.example.com/',
      'https://api.example.com/v1',
      'https://API.example.com/v1/'
    ]) {
      expect(buildAuthHeaders(url, config)).toEqual({ Authorization: 'Bearer env-key' })
    }
  })

  it('does not send the environment key to any other endpoint', async () => {
    process.env.LLM_API_KEY = 'env-key'
    process.env.LM_STUDIO_URL = 'https://api.example.com'
    const { buildAuthHeaders } = await import('./lmstudio')
    const config = { lmStudioUrl: 'https://api.example.com' }

    for (const url of [
      'https://other.example.com',
      'http://api.example.com',
      'http://localhost:1234',
      'http://10.55.0.11:1234',
      'not a url'
    ]) {
      expect(buildAuthHeaders(url, config)).toEqual({})
    }
  })

  it('does not send the environment key to a saved URL that differs from LM_STUDIO_URL', async () => {
    process.env.LLM_API_KEY = 'env-key'
    process.env.LM_STUDIO_URL = 'https://a.example.com'
    const { buildAuthHeaders } = await import('./lmstudio')
    const config = { lmStudioUrl: 'https://b.example.com' }

    expect(buildAuthHeaders('https://b.example.com', config)).toEqual({})
    expect(buildAuthHeaders('https://a.example.com', config)).toEqual({
      Authorization: 'Bearer env-key'
    })
  })

  it('ignores the environment key when the URL was saved in the app and LM_STUDIO_URL is not set', async () => {
    process.env.LLM_API_KEY = 'env-key'
    loadConfig.mockReturnValue({ lmStudioUrl: 'https://saved.example.com/v1' })
    const fetchImpl = vi.fn(async (_url: string, _init?: unknown) => okResponse())

    const { healLmStudioConnection, buildAuthHeaders } = await import('./lmstudio')
    const result = await healLmStudioConnection({ fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(result.success).toBe(true)
    expect(fetchImpl.mock.calls[0][0]).toBe('https://saved.example.com/v1/models')
    expect(sentHeaders(fetchImpl)).toEqual({})
    expect(buildAuthHeaders('https://saved.example.com', { lmStudioUrl: 'https://saved.example.com' })).toEqual({})
  })

  it('ignores the environment key when LM_STUDIO_URL is not a URL', async () => {
    process.env.LLM_API_KEY = 'env-key'
    process.env.LM_STUDIO_URL = 'not a url'
    loadConfig.mockReturnValue({ lmStudioUrl: HOSTED })
    const { buildAuthHeaders, resolveApiKey } = await import('./lmstudio')

    expect(resolveApiKey({})).toBeUndefined()
    expect(buildAuthHeaders(HOSTED, { lmStudioUrl: HOSTED })).toEqual({})
    expect(buildAuthHeaders('not a url', { lmStudioUrl: 'not a url' })).toEqual({})
  })

  it('ignores the environment key when LM_STUDIO_URL is blank', async () => {
    process.env.LLM_API_KEY = 'env-key'
    process.env.LM_STUDIO_URL = '   '
    loadConfig.mockReturnValue({ lmStudioUrl: HOSTED })
    const { buildAuthHeaders, resolveApiKey } = await import('./lmstudio')

    expect(buildAuthHeaders(HOSTED, { lmStudioUrl: HOSTED })).toEqual({})
    expect(resolveApiKey({})).toBeUndefined()
  })

  it('uses the config file key, not the environment key, when only the environment key is unpaired', async () => {
    process.env.LLM_API_KEY = 'env-key'
    loadConfig.mockReturnValue({ lmStudioUrl: HOSTED, apiKey: 'cfg-key' })
    const fetchImpl = vi.fn(async (_url: string, _init?: unknown) => okResponse())

    const { healLmStudioConnection } = await import('./lmstudio')
    await healLmStudioConnection({ fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(sentHeaders(fetchImpl)).toEqual({ Authorization: 'Bearer cfg-key' })
  })

  it('keeps probing discovered hosts, without any key, when the environment key is unpaired', async () => {
    process.env.LLM_API_KEY = 'env-key'
    loadConfig.mockReturnValue({ lmStudioUrl: 'http://10.55.0.10:1234' })
    networkInterfaces.mockReturnValue({ en0: [{ family: 'IPv4', address: '10.55.0.5' }] })
    const fetchImpl = vi.fn(async (_url: string, _init?: unknown): Promise<Response> => {
      throw new Error('connect ECONNREFUSED')
    })

    const { healLmStudioConnection } = await import('./lmstudio')
    await healLmStudioConnection({ fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1)
    for (let i = 0; i < fetchImpl.mock.calls.length; i++) {
      expect(sentHeaders(fetchImpl, i)).toEqual({})
    }
  })

  it('probes only the LM_STUDIO_URL endpoint when the environment key is paired with it', async () => {
    process.env.LLM_API_KEY = 'env-key'
    process.env.LM_STUDIO_URL = HOSTED
    loadConfig.mockReturnValue({ lmStudioUrl: HOSTED })
    networkInterfaces.mockReturnValue({ en0: [{ family: 'IPv4', address: '10.55.0.5' }] })
    const fetchImpl = vi.fn(async (_url: string, _init?: unknown): Promise<Response> => {
      throw new Error('connect ECONNREFUSED')
    })

    const { healLmStudioConnection } = await import('./lmstudio')
    await healLmStudioConnection({ persist: true, fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual(['https://api.example.com/v1/models'])
    expect(saveConfig).not.toHaveBeenCalled()
  })

  it('never probes discovered hosts or rewrites the saved URL when a key is set', async () => {
    loadConfig.mockReturnValue({ lmStudioUrl: HOSTED, apiKey: 'cfg-key' })
    networkInterfaces.mockReturnValue({ en0: [{ family: 'IPv4', address: '10.55.0.5' }] })
    exec.mockImplementation((_command, _options, callback) => {
      callback(null, {
        stdout: '? (10.55.0.11) at aa:bb:cc:dd:ee:ff on en0 ifscope [ethernet]\n',
        stderr: ''
      })
    })
    const fetchImpl = vi.fn(async (_url: string, _init?: unknown): Promise<Response> => {
      throw new Error('connect ECONNREFUSED')
    })

    const { healLmStudioConnection } = await import('./lmstudio')
    const result = await healLmStudioConnection({
      persist: true,
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    expect(result.success).toBe(false)
    expect(result.configured).toBe(true)
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual(['https://api.example.com/v1/models'])
    expect(exec).not.toHaveBeenCalled()
    expect(saveConfig).not.toHaveBeenCalled()
  })

  it('sends the key only to the configured endpoint', async () => {
    loadConfig.mockReturnValue({ lmStudioUrl: HOSTED, apiKey: 'cfg-key' })
    const { buildAuthHeaders } = await import('./lmstudio')
    const config = { lmStudioUrl: HOSTED, apiKey: 'cfg-key' }

    expect(buildAuthHeaders('https://api.example.com', config)).toEqual({
      Authorization: 'Bearer cfg-key'
    })
    expect(buildAuthHeaders('https://api.example.com/v1/', config)).toEqual({
      Authorization: 'Bearer cfg-key'
    })
    expect(buildAuthHeaders('http://localhost:1234', config)).toEqual({})
    expect(buildAuthHeaders('http://10.55.0.11:1234', config)).toEqual({})
    expect(buildAuthHeaders('https://other.example.com', config)).toEqual({})
    expect(buildAuthHeaders('not a url', config)).toEqual({})
  })

  it('never logs or returns the key', async () => {
    loadConfig.mockReturnValue({ lmStudioUrl: HOSTED, apiKey: 'super-secret-key-123' })
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {})
    ]
    const fetchImpl = vi.fn(async (_url: string, _init?: unknown): Promise<Response> => {
      throw new Error('connect ECONNREFUSED')
    })

    const { healLmStudioConnection } = await import('./lmstudio')
    const result = await healLmStudioConnection({
      persist: true,
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    expect(JSON.stringify(result)).not.toContain('super-secret-key-123')
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain('super-secret-key-123')
    }
  })
})
