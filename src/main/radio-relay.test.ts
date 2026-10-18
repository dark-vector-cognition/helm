import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { __radioRelayInternals, getRadioRelayUrl, stopRadioRelayServer } from './radio-relay'

describe('radio relay access', () => {
  let directory: string | undefined

  afterEach(async () => {
    await stopRadioRelayServer()
    if (directory) await rm(directory, { recursive: true, force: true })
    directory = undefined
  })

  it('serves an issued local source and rejects unsigned or altered file requests', async () => {
    directory = await mkdtemp(join(tmpdir(), 'helm-radio-'))
    const audioPath = join(directory, 'track.mp3')
    const otherPath = join(directory, 'private.txt')
    await writeFile(audioPath, 'test audio bytes')
    await writeFile(otherPath, 'private fixture')
    const issuedUrl = await getRadioRelayUrl({ kind: 'local', value: audioPath })

    const allowed = await fetch(issuedUrl)
    expect(allowed.status).toBe(200)
    expect(await allowed.text()).toBe('test audio bytes')

    const ranged = await fetch(issuedUrl, { headers: { Range: 'bytes=5-9' } })
    expect(ranged.status).toBe(206)
    expect(await ranged.text()).toBe('audio')
    const head = await fetch(issuedUrl, { method: 'HEAD' })
    expect(head.headers.get('content-length')).toBe('16')
    expect(await head.text()).toBe('')

    const unsigned = new URL(issuedUrl)
    unsigned.search = ''
    const denied = await fetch(unsigned)
    expect(denied.status).toBe(403)
    await denied.text()

    const altered = new URL(issuedUrl)
    altered.pathname = `/local/${__radioRelayInternals.encodeRelayValue(otherPath)}`
    const forged = await fetch(altered)
    expect(forged.status).toBe(403)
    expect(await forged.text()).not.toContain('private fixture')
  })

  it('proxies an issued remote source and rejects an altered remote target', async () => {
    const upstream = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' })
      res.end('remote audio fixture')
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    try {
      const address = upstream.address()
      if (!address || typeof address === 'string') throw new Error('Missing fixture port')
      const issuedUrl = await getRadioRelayUrl({
        kind: 'remote',
        value: `http://127.0.0.1:${address.port}/stream.mp3`
      })
      const response = await fetch(issuedUrl)
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('remote audio fixture')

      const altered = new URL(issuedUrl)
      altered.pathname =
        '/remote/' + __radioRelayInternals.encodeRelayValue('http://example.invalid')
      const denied = await fetch(altered)
      expect(denied.status).toBe(403)
      await denied.text()
    } finally {
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })
})

describe('radio relay helpers', () => {
  it('round-trips encoded relay values', () => {
    const original = 'https://example.com/live stream.mp3?token=abc#frag'
    const encoded = __radioRelayInternals.encodeRelayValue(original)
    expect(__radioRelayInternals.decodeRelayValue(encoded)).toBe(original)
  })

  it('allows only http and https relay targets', () => {
    expect(__radioRelayInternals.isAllowedRemoteUrl('https://example.com/live.mp3')).toBe(true)
    expect(__radioRelayInternals.isAllowedRemoteUrl('http://example.com/live.mp3')).toBe(true)
    expect(__radioRelayInternals.isAllowedRemoteUrl('file:///tmp/test.mp3')).toBe(false)
    expect(__radioRelayInternals.isAllowedRemoteUrl('javascript:alert(1)')).toBe(false)
  })

  it('maps common file extensions to audio mime types', () => {
    expect(__radioRelayInternals.mimeTypeForPath('/tmp/song.mp3')).toBe('audio/mpeg')
    expect(__radioRelayInternals.mimeTypeForPath('/tmp/song.m4a')).toBe('audio/mp4')
    expect(__radioRelayInternals.mimeTypeForPath('/tmp/song.flac')).toBe('audio/flac')
    expect(__radioRelayInternals.mimeTypeForPath('/tmp/song.bin')).toBe('application/octet-stream')
  })

  it('normalizes extension hints and relay file suffixes', () => {
    expect(__radioRelayInternals.normalizeExtensionHint('.MP3')).toBe('mp3')
    expect(
      __radioRelayInternals.relayFileExtension({
        kind: 'remote',
        value: 'https://example.com/live',
        extensionHint: 'AAC'
      })
    ).toBe('aac')
    expect(
      __radioRelayInternals.relayFileExtension({
        kind: 'remote',
        value: 'https://example.com/live.mp3'
      })
    ).toBe('mp3')
    expect(__radioRelayInternals.stripRelayExtension('YWJjMTIz.mp3')).toBe('YWJjMTIz')
  })

  it('parses closed and open byte ranges', () => {
    expect(__radioRelayInternals.parseRangeHeader('bytes=0-99', 200)).toEqual({
      start: 0,
      end: 99
    })
    expect(__radioRelayInternals.parseRangeHeader('bytes=150-', 200)).toEqual({
      start: 150,
      end: 199
    })
    expect(__radioRelayInternals.parseRangeHeader('bytes=-25', 200)).toEqual({
      start: 175,
      end: 199
    })
  })

  it('rejects invalid byte ranges', () => {
    expect(__radioRelayInternals.parseRangeHeader(undefined, 200)).toBeNull()
    expect(__radioRelayInternals.parseRangeHeader('items=0-10', 200)).toBeNull()
    expect(__radioRelayInternals.parseRangeHeader('bytes=250-300', 200)).toBeNull()
    expect(__radioRelayInternals.parseRangeHeader('bytes=50-20', 200)).toBeNull()
  })
})
