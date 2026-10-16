import { describe, expect, it } from 'vitest'
import { normalizeEndpointUrl } from './endpoint-url'

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
