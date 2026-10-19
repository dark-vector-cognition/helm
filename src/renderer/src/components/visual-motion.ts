export interface VisualAnimation {
  redraw: () => void
  dispose: () => void
}

// Decorative canvases never need the display's full refresh rate or background work.
export function startVisualAnimation(
  canvas: HTMLCanvasElement,
  draw: (time: number, still: boolean) => void,
  animate: () => boolean = () => true
): VisualAnimation {
  const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
  let inView = false
  let disposed = false
  let frame = 0
  let lastDraw = -Infinity

  const visible = (): boolean => !disposed && inView && !document.hidden
  const moving = (): boolean => !preference.matches && animate()

  const tick = (timestamp: number): void => {
    frame = 0
    if (!visible()) return
    const motion = moving()
    if (timestamp - lastDraw >= 1000 / 30 - 0.5 || !motion) {
      draw(motion ? timestamp / 1000 : 0, !motion)
      lastDraw = timestamp
    }
    if (motion) frame = requestAnimationFrame(tick)
  }

  const redraw = (): void => {
    cancelAnimationFrame(frame)
    frame = 0
    lastDraw = -Infinity
    if (visible()) frame = requestAnimationFrame(tick)
  }

  const observer = new IntersectionObserver((entries) => {
    inView = entries.some((entry) => entry.isIntersecting)
    redraw()
  })
  observer.observe(canvas)
  document.addEventListener('visibilitychange', redraw)
  preference.addEventListener('change', redraw)

  return {
    redraw,
    dispose: () => {
      disposed = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      document.removeEventListener('visibilitychange', redraw)
      preference.removeEventListener('change', redraw)
    }
  }
}
