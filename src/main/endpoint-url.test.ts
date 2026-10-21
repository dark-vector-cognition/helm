import { describe, expect, it } from 'vitest'
import { envKeyWithEndpoint, isLocalEndpoint, normalizeEndpointUrl } from './endpoint-url'

describe('isLocalEndpoint', () => {
  it('accepts this machine and local network addresses', () => {
    for (const url of [
      'http://localhost:1234',
      'http://LOCALHOST:1234/v1',
      'http://helm.localhost:8080',
      'http://studio.local:1234',
      'http://127.0.0.1:1234',
      'http://10.0.0.5:1234',
      'http://172.16.4.2:11434',
      'http://172.31.255.1',
      'http://192.168.1.20:1234',
      'http://169.254.10.10',
      'http://[::1]:1234',
      'http://[fd12:3456::1]:1234',
      'http://[fe80::1]:1234'
    ]) {
      expect(isLocalEndpoint(url), url).toBe(true)
    }
  })

  it('treats every other host as hosted', () => {
    for (const url of [
      'https://openrouter.ai/api',
      'https://api.deepseek.com',
      'https://api.openai.com/v1',
      'https://api.together.xyz/v1',
      'https://api.example.com',
      'https://localhost.example.com',
      'https://local.example.com',
      'http://172.32.0.1',
      'http://8.8.8.8',
      'http://192.169.1.1',
      'http://[2001:db8::1]',
      'http://gpu-box:1234',
      'not a url',
      '',
      undefined
    ]) {
      expect(isLocalEndpoint(url), String(url)).toBe(false)
    }
  })
})

describe('normalizeEndpointUrl', () => {
  it('treats spellings of one endpoint as equal', () => {
    const spellings = [
      'https://api.example.com',
      'https://api.example.com/',
      'https://api.example.com/v1',
      'https://api.example.com/v1/',
      '  HTTPS://API.EXAMPLE.COM/v1  ',
      'https://api.example.com/v1?x=1#frag'
    ]
    for (const spelling of spellings) {
      expect(normalizeEndpointUrl(spelling)).toBe('https://api.example.com')
    }
  })

  it('keeps the port and any path that is not /v1', () => {
    expect(normalizeEndpointUrl('http://10.0.0.5:1234/v1')).toBe('http://10.0.0.5:1234')
    expect(normalizeEndpointUrl('https://host.example.com/openai/v1')).toBe(
      'https://host.example.com/openai'
    )
  })

  it('keeps different hosts apart', () => {
    expect(normalizeEndpointUrl('https://a.example.com')).not.toBe(
      normalizeEndpointUrl('https://b.example.com')
    )
    expect(normalizeEndpointUrl('http://a.example.com')).not.toBe(
      normalizeEndpointUrl('https://a.example.com')
    )
  })

  it('returns null for empty, blank, non-string and unparseable values', () => {
    for (const value of ['', '   ', 'not a url', undefined, null, 42]) {
      expect(normalizeEndpointUrl(value)).toBeNull()
    }
  })
})

describe('envKeyWithEndpoint', () => {
  it('pairs the key with the normalized endpoint', () => {
    expect(
      envKeyWithEndpoint({ LLM_API_KEY: ' k ', LM_STUDIO_URL: ' HTTPS://API.example.com/v1/ ' })
    ).toEqual({ key: 'k', url: 'https://api.example.com' })
  })

  it('has no pair without a key', () => {
    for (const key of [undefined, '', '   ']) {
      expect(envKeyWithEndpoint({ LLM_API_KEY: key, LM_STUDIO_URL: 'https://api.example.com' })).toBeUndefined()
    }
  })

  it('has no pair when LM_STUDIO_URL is missing, blank or not a URL', () => {
    for (const url of [undefined, '', '   ', 'not a url', 'api example com', '://nohost']) {
      expect(envKeyWithEndpoint({ LLM_API_KEY: 'k', LM_STUDIO_URL: url })).toBeUndefined()
    }
  })

  it('reads the real environment by default', () => {
    const saved = { key: process.env.LLM_API_KEY, url: process.env.LM_STUDIO_URL }
    process.env.LLM_API_KEY = 'k'
    process.env.LM_STUDIO_URL = 'not a url'
    try {
      expect(envKeyWithEndpoint()).toBeUndefined()
      process.env.LM_STUDIO_URL = 'http://localhost:1234'
      expect(envKeyWithEndpoint()).toEqual({ key: 'k', url: 'http://localhost:1234' })
    } finally {
      if (saved.key === undefined) delete process.env.LLM_API_KEY
      else process.env.LLM_API_KEY = saved.key
      if (saved.url === undefined) delete process.env.LM_STUDIO_URL
      else process.env.LM_STUDIO_URL = saved.url
    }
  })

  it('uses provider environment keys only for their exact authenticated endpoint', () => {
    const keys = { OPENROUTER_API_KEY: 'router-fixture', DEEPSEEK_API_KEY: 'deepseek-fixture' }
    expect(envKeyWithEndpoint({ ...keys, LM_STUDIO_URL: 'https://openrouter.ai/api/v1' })).toEqual({ key: 'router-fixture', url: 'https://openrouter.ai/api' })
    expect(envKeyWithEndpoint({ ...keys, LM_STUDIO_URL: 'https://api.deepseek.com/v1' })).toEqual({ key: 'deepseek-fixture', url: 'https://api.deepseek.com' })
    for (const url of ['http://openrouter.ai/api', 'https://other.example/api', 'https://openrouter.ai.evil.example/api', 'http://localhost:1234']) {
      expect(envKeyWithEndpoint({ ...keys, LM_STUDIO_URL: url })).toBeUndefined()
    }
    expect(envKeyWithEndpoint({ ...keys, LLM_API_KEY: 'explicit-fixture', LM_STUDIO_URL: 'https://openrouter.ai/api' })?.key).toBe('explicit-fixture')
  })

})
