import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'

const hooks = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)> }))
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  return {
    ...actual,
    useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, vi.fn()],
    useRef: (initial: unknown) => ({ current: initial }),
    useEffect: (effect: () => void | (() => void)) => {
      hooks.effects.push(effect)
    }
  }
})
vi.mock('../components/RadioSignalGlobe', () => ({ RadioSignalGlobe: () => null }))
vi.mock('../components/RadioRippleVisualizer', () => ({ RadioRippleVisualizer: () => null }))
vi.mock('./radio', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./radio')>()
  const useRadioStore = Object.assign(
    (selector: (state: ReturnType<typeof actual.useRadioStore.getState>) => unknown) =>
      selector(actual.useRadioStore.getState()),
    actual.useRadioStore
  )
  return { ...actual, useRadioStore }
})

class FakeAudio extends EventTarget {
  src = ''
  preload = ''
  volume = 1
  currentTime = 0
  duration = 120
  paused = true
  play = vi.fn(async () => {
    this.paused = false
    this.dispatchEvent(new Event('playing'))
  })
  load = vi.fn()
  pause = vi.fn(() => {
    this.paused = true
    this.dispatchEvent(new Event('pause'))
  })
}

function button(tree: ReactElement, title: string): { onClick: () => void } {
  const props = tree.props as { title?: string; onClick: () => void; children?: unknown }
  if (tree.type === 'button' && props.title === title) return props
  const children = Array.isArray(props.children) ? props.children.flat() : [props.children]
  for (const child of children) {
    if (child && typeof child === 'object' && 'props' in child) {
      try {
        return button(child as ReactElement, title)
      } catch {
        /* Search remaining children. */
      }
    }
  }
  throw new Error(`Button not found: ${title}`)
}

beforeEach(() => {
  vi.resetModules()
  hooks.effects = []
  vi.stubGlobal('Audio', FakeAudio)
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() })
  vi.stubGlobal('window', {
    localStorage,
    helm: {
      getConfig: vi.fn().mockResolvedValue({}),
      resolveRadioSource: vi.fn().mockResolvedValue('http://relay/audio.mp3')
    },
    setInterval: vi.fn(),
    clearInterval: vi.fn()
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('radio panel playback lifecycle', () => {
  it('still cues the initial source after StrictMode effect replay', async () => {
    const { FMRadioPanel } = await import('../panels/FMRadio')
    const engine = await import('./audio-engine')
    FMRadioPanel()
    const cleanups = hooks.effects.map((effect) => effect())
    for (const cleanup of cleanups) cleanup?.()
    hooks.effects.forEach((effect) => effect())
    await Promise.resolve()
    await Promise.resolve()
    expect(engine.getCurrentTrackId()).toBe('wbgo-jazz')
    expect((engine.getAudioElement() as unknown as FakeAudio).play).not.toHaveBeenCalled()
  })

  it.each(['stop', 'unmount'] as const)('cancels a pending cue on %s', async (action) => {
    let resolveSource!: (url: string) => void
    vi.mocked(window.helm.resolveRadioSource).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSource = resolve
        })
    )
    const { FMRadioPanel } = await import('../panels/FMRadio')
    const engine = await import('./audio-engine')
    const tree = FMRadioPanel()
    const cleanups = hooks.effects.map((effect) => effect())
    button(tree, 'Next').onClick()
    if (action === 'stop') button(tree, 'Stop').onClick()
    else for (const cleanup of cleanups) cleanup?.()
    resolveSource('http://relay/next.mp3')
    await Promise.resolve()
    await Promise.resolve()
    expect((engine.getAudioElement() as unknown as FakeAudio).play).not.toHaveBeenCalled()
  })

  it('stops the removed active file before selecting the default station', async () => {
    const { useRadioStore, DEFAULT_RADIO_STATION_ID } = await import('./radio')
    const engine = await import('./audio-engine')
    useRadioStore.getState().addLocalFile('Track.mp3', '/music/Track.mp3')
    const file = useRadioStore.getState().localFiles[0]
    useRadioStore.getState().setSelectedStationId(file.id)
    engine.loadTrack(file.id, 'http://relay/audio.mp3')
    await engine.play()
    const { FMRadioPanel } = await import('../panels/FMRadio')
    const tree = FMRadioPanel()
    hooks.effects.forEach((effect) => effect())
    button(tree, 'Remove from local library').onClick()
    await Promise.resolve()
    await Promise.resolve()
    expect(engine.isPaused()).toBe(true)
    expect(engine.getStatus()).toBe('paused')
    expect(useRadioStore.getState().localFiles).toEqual([])
    expect(useRadioStore.getState().selectedStationId).toBe(DEFAULT_RADIO_STATION_ID)
  })
})
