import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startVisualAnimation, type VisualAnimation } from '../components/visual-motion'

let visibility: EventTarget & { hidden: boolean }
let preference: EventTarget & { matches: boolean }
let intersect: (entries: Array<{ isIntersecting: boolean }>) => void
let frames: Map<number, FrameRequestCallback>
let nextFrame: number
let animation: VisualAnimation | undefined

function frame(timestamp: number): void {
  const pending = [...frames.values()]
  frames.clear()
  pending.forEach((callback) => callback(timestamp))
}

beforeEach(() => {
  frames = new Map()
  nextFrame = 0
  visibility = Object.assign(new EventTarget(), { hidden: false })
  preference = Object.assign(new EventTarget(), { matches: false })
  vi.stubGlobal('document', visibility)
  vi.stubGlobal('window', { matchMedia: () => preference })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: typeof intersect) { intersect = callback }
    observe(): void {}
    disconnect(): void {}
  })
})

afterEach(() => {
  animation?.dispose()
  animation = undefined
  vi.unstubAllGlobals()
})

describe('decorative canvas scheduling', () => {
  it('draws only visible content, caps draws at 30 fps, and stops while hidden', () => {
    const draw = vi.fn()
    animation = startVisualAnimation({} as HTMLCanvasElement, draw)
    expect(frames.size).toBe(0)
    intersect([{ isIntersecting: true }])
    frame(0)
    frame(1000 / 60)
    frame(1000 / 30)
    expect(draw).toHaveBeenCalledTimes(2)

    visibility.hidden = true
    visibility.dispatchEvent(new Event('visibilitychange'))
    expect(frames.size).toBe(0)
    visibility.hidden = false
    visibility.dispatchEvent(new Event('visibilitychange'))
    frame(100)
    expect(draw).toHaveBeenCalledTimes(3)

    intersect([{ isIntersecting: false }])
    expect(frames.size).toBe(0)
  })

  it('draws a stable reduced-motion frame, supports redraws, and resumes on preference change', () => {
    preference.matches = true
    const draw = vi.fn()
    animation = startVisualAnimation({} as HTMLCanvasElement, draw)
    intersect([{ isIntersecting: true }])
    frame(200)
    expect(draw).toHaveBeenLastCalledWith(0, true)
    expect(frames.size).toBe(0)
    animation.redraw()
    frame(400)
    expect(draw).toHaveBeenLastCalledWith(0, true)

    preference.matches = false
    preference.dispatchEvent(new Event('change'))
    frame(500)
    expect(draw).toHaveBeenLastCalledWith(0.5, false)
    expect(frames.size).toBe(1)
  })

  it('keeps idle visuals static and cancels all future work on disposal', () => {
    let active = false
    const draw = vi.fn()
    animation = startVisualAnimation({} as HTMLCanvasElement, draw, () => active)
    intersect([{ isIntersecting: true }])
    frame(100)
    expect(draw).toHaveBeenLastCalledWith(0, true)
    expect(frames.size).toBe(0)
    active = true
    animation.redraw()
    frame(200)
    expect(frames.size).toBe(1)
    animation.dispose()
    intersect([{ isIntersecting: true }])
    visibility.dispatchEvent(new Event('visibilitychange'))
    expect(frames.size).toBe(0)
  })
})
