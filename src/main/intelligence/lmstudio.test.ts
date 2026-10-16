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
      expect.objectContaining({
        headers: { Authorization: 'Bearer lm-studio' }
      })
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
      parseArpNeighborIps('? (10.55.0.10) at cc:ba:bd:fc:81:19 on en8 ifscope [ethernet]\n? (8.8.8.8) at aa:bb:cc:dd:ee:ff on en8 ifscope [ethernet]')
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
