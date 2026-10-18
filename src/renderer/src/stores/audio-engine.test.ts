import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class FakeAudio extends EventTarget {
  src = ''
  preload = ''
  volume = 1
  currentTime = 0
  duration = 120
  paused = true
  play = vi.fn(() => Promise.resolve())
  load = vi.fn()
  pause = vi.fn(() => {
    this.paused = true
    this.dispatchEvent(new Event('pause'))
  })
}

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('Audio', FakeAudio)
})
afterEach(() => vi.unstubAllGlobals())

describe('audio playback requests', () => {
  it.each(['pause', 'stop', 'loadTrack', 'reload', 'play'] as const)(
    'ignores a rejected play superseded by %s',
    async (action) => {
      const engine = await import('./audio-engine')
      const audio = engine.getAudioElement() as unknown as FakeAudio
      let rejectPlay!: (error: Error) => void
      audio.play.mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectPlay = reject
          })
      )
      engine.loadTrack('first', 'first.mp3')
      const pending = engine.play()

      if (action === 'loadTrack') engine.loadTrack('second', 'second.mp3')
      else if (action === 'reload') engine.reload('first.mp3')
      else await engine[action]()

      rejectPlay(new DOMException('The play request was interrupted.', 'AbortError'))
      await pending
      expect(engine.getStatus()).not.toBe('error')
      expect(engine.getError()).toBeNull()
    }
  )

  it('still reports a failure from the current play request', async () => {
    const engine = await import('./audio-engine')
    const audio = engine.getAudioElement() as unknown as FakeAudio
    audio.play.mockRejectedValueOnce(new Error('Decoder unavailable'))
    await engine.play()
    expect(engine.getStatus()).toBe('error')
    expect(engine.getError()).toContain('Decoder unavailable')
  })
})
