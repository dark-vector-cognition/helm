import { describe, expect, it } from 'vitest'
import { envKeyWithEndpoint, normalizeEndpointUrl } from './endpoint-url'

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
})
