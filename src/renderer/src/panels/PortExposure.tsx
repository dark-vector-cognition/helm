import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { PortExposureScene } from '../components/PortExposureScene'
import { redactSensitiveText, usePrivacyStore } from '../stores/privacy'
import {
  buildExposedServices,
  connectionTotal,
  REACH_DETAIL,
  REACH_LABEL,
  storageAvailable,
  usePortExposureStore,
  type ExposedService
} from '../stores/port-exposure'
import { useSystemStore } from '../stores/system'

const FIREWALL_LABEL = { allow: 'Allow rule', block: 'Block rule', unknown: 'No matching rule' }

interface PortExposurePanelProps {
  // Review harness only: a fixed snapshot instead of live monitor data.
  sample?: ExposedService[]
  // Review harness only: exercise the fallback without breaking WebGL.
  forceFallback?: boolean
}

export function PortExposurePanel({ sample, forceFallback = false }: PortExposurePanelProps): JSX.Element {
  const state = useSystemStore((s) => s.state)
  const privacyMode = usePrivacyStore((s) => s.privacyMode)
  const { view, selectedKey, setView, select, saveCamera } = usePortExposureStore()
  const network = state?.network
  const isSample = sample !== undefined
  const connectionDataAvailable = isSample || network?.sourceMode === 'nettop' || (network?.connections.length ?? 0) > 0

  const services = useMemo(
    () =>
      sample ??
      (state
        ? buildExposedServices(state.ports, state.network?.connections, state.firewall?.rules)
        : []),
    [sample, state]
  )
  const selected = services.find((s) => s.key === selectedKey) ?? null
  const exposed = services.filter((s) => s.reach !== 'local')
  const local = services.filter((s) => s.reach === 'local')
  const show = (value: string): string => (privacyMode ? redactSensitiveText(value) : value)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef<PortExposureScene | null>(null)
  const [sceneState, setSceneState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [failure, setFailure] = useState('')
  const [label, setLabel] = useState<{ x: number; y: number } | null>(null)
  const [attempt, setAttempt] = useState(0)

  const want3d = view === '3d'

  useEffect(() => {
    if (!want3d) return
    if (forceFallback) {
      setSceneState('failed')
      setFailure('3D is turned off for this review (?webgl=off).')
      return
    }
    const canvas = canvasRef.current
    if (!canvas) return
    let cancelled = false
    setSceneState('loading')
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    import('../components/PortExposureScene')
      .then(({ PortExposureScene }) =>
        PortExposureScene.create(
          canvas,
          {
            onSelect: (key) => usePortExposureStore.getState().select(key),
            onViewSettled: (next) => usePortExposureStore.getState().saveCamera(next),
            onLabel: setLabel,
            onLost: (reason) => {
              setFailure(reason)
              setSceneState('failed')
            }
          },
          usePortExposureStore.getState().camera,
          reducedMotion
        )
      )
      .then((scene) => {
        if (cancelled) {
          scene.dispose()
          return
        }
        sceneRef.current = scene
        if (isSample) scene.registerInspector()
        setSceneState('ready')
      })
      .catch((error: unknown) => {
        if (cancelled) return
        console.error('Port exposure 3D view failed:', error)
        const message = error instanceof Error && error.message ? error.message : 'WebGL 2 is not available'
        setFailure(/[.!?]$/.test(message) ? message : `${message}.`)
        setSceneState('failed')
      })
    return () => {
      cancelled = true
      sceneRef.current?.dispose()
      sceneRef.current = null
      setLabel(null)
    }
  }, [want3d, forceFallback, attempt, isSample])

  useEffect(() => {
    if (sceneState === 'ready') sceneRef.current?.setServices(services, selectedKey)
  }, [sceneState, services, selectedKey])

  const choose = (key: string): void => {
    const next = key === selectedKey ? null : key
    select(next)
    if (next) sceneRef.current?.focusService(next)
  }

  const onCanvasKey = (event: KeyboardEvent<HTMLCanvasElement>): void => {
    const scene = sceneRef.current
    if (!scene) return
    const actions: Record<string, () => void> = {
      ArrowLeft: () => scene.rotate(-15),
      ArrowRight: () => scene.rotate(15),
      ArrowUp: () => scene.tilt(-8),
      ArrowDown: () => scene.tilt(8),
      '+': () => scene.zoom(0.85),
      '=': () => scene.zoom(0.85),
      '-': () => scene.zoom(1.18),
      '0': () => scene.resetView(),
      Home: () => scene.resetView(),
      Escape: () => select(null)
    }
    const action = actions[event.key]
    if (action) {
      event.preventDefault()
      event.stopPropagation()
      action()
    }
  }

  const controls: Array<[string, string, () => void]> = [
    ['Rotate left', '⟲', () => sceneRef.current?.rotate(-15)],
    ['Rotate right', '⟳', () => sceneRef.current?.rotate(15)],
    ['Tilt up', '△', () => sceneRef.current?.tilt(-8)],
    ['Tilt down', '▽', () => sceneRef.current?.tilt(8)],
    ['Zoom in', '+', () => sceneRef.current?.zoom(0.85)],
    ['Zoom out', '−', () => sceneRef.current?.zoom(1.18)],
    [
      'Reset view',
      '⌂',
      () => {
        sceneRef.current?.resetView()
        saveCamera(null)
      }
    ]
  ]

  if (!state && !sample) return <div className="text-gray-600 text-sm">Waiting for monitor data</div>

  return (
    <div className="port-exposure space-y-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-gray-400" aria-live="polite">
          {services.length === 0
            ? 'No listening ports'
            : `${services.length} listening ${services.length === 1 ? 'service' : 'services'}. ${exposed.length} bound beyond this Mac.`}
        </p>
        <div className="flex gap-1" role="group" aria-label="Port view">
          {(['list', '3d'] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={view === option}
              onClick={() => setView(option)}
              className={`px-2.5 py-1 rounded border text-xs ${
                view === option
                  ? 'border-[color:var(--helm-accent)] text-[color:var(--helm-accent)]'
                  : 'border-[color:var(--helm-control-border)] text-gray-400'
              }`}
            >
              {option === '3d' ? '3D map' : 'List'}
            </button>
          ))}
        </div>
      </div>

      {want3d && (
        <div className="space-y-2">
          <div className="relative w-full h-[clamp(240px,40vh,420px)] rounded border border-[color:var(--helm-border-soft)] overflow-hidden">
            <canvas
              ref={canvasRef}
              tabIndex={0}
              aria-label="3D map of listening ports. Boxes inside the rim are reachable from this Mac only. Cylinders outside the rim are bound to the network. Drag to rotate, scroll or pinch to zoom. Arrow keys rotate and tilt, plus and minus zoom, 0 resets."
              aria-describedby="port-exposure-legend"
              onKeyDown={onCanvasKey}
              className={`block w-full h-full touch-none outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--helm-accent)] ${
                sceneState === 'failed' ? 'invisible' : ''
              }`}
            />
            {sceneState === 'loading' && (
              <div className="absolute inset-0 grid place-items-center text-gray-500 text-xs">Loading 3D map</div>
            )}
            {sceneState === 'failed' && (
              <div role="status" className="absolute inset-0 grid place-items-center p-4 text-center">
                <div className="space-y-2 max-w-sm">
                  <p className="text-gray-300">The 3D map is not available.</p>
                  <p className="text-gray-500 text-xs">{failure} The list below shows every listening service and its reach.</p>
                  {!forceFallback && (
                    <button
                      type="button"
                      onClick={() => setAttempt((n) => n + 1)}
                      className="px-2.5 py-1 rounded border border-[color:var(--helm-control-border)] text-xs text-gray-300"
                    >
                      Try 3D again
                    </button>
                  )}
                </div>
              </div>
            )}
            {sceneState === 'ready' && selected && label && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute -translate-x-1/2 -translate-y-full px-1.5 py-0.5 rounded bg-[color:var(--helm-panel-bg)] border border-[color:var(--helm-accent)] text-[11px] font-mono text-[color:var(--helm-accent)] whitespace-nowrap"
                style={{ left: label.x, top: label.y }}
              >
                :{selected.port} {show(selected.process)}
              </div>
            )}
          </div>
          {sceneState === 'ready' && (
            <div className="flex flex-wrap gap-1" role="toolbar" aria-label="3D map controls">
              {controls.map(([name, glyph, run]) => (
                <button
                  key={name}
                  type="button"
                  aria-label={name}
                  title={name}
                  onClick={run}
                  className="min-w-[36px] min-h-[36px] px-2 rounded border border-[color:var(--helm-control-border)] text-gray-300 hover:text-white"
                >
                  <span aria-hidden="true">{glyph}</span>
                </button>
              ))}
            </div>
          )}
          <p id="port-exposure-legend" className="text-gray-500 text-xs">
            Box inside the rim: this Mac only. Cylinder outside the rim: bound to the network. Height: observed connections.
          </p>
        </div>
      )}

      {selected ? (
        <section aria-label={`Port ${selected.port} details`} className="rounded border border-[color:var(--helm-border-soft)] p-3 space-y-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-white font-mono font-bold">
              :{selected.port} <span className="text-gray-300 font-normal">{show(selected.process)}</span>
            </h3>
            <button type="button" onClick={() => select(null)} className="text-xs text-gray-500 hover:text-gray-300">
              Clear
            </button>
          </div>
          <p className="text-gray-200">
            {REACH_LABEL[selected.reach]}. <span className="text-gray-400">{REACH_DETAIL[selected.reach]}</span>
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
            <dt className="text-gray-500">Bind</dt>
            <dd className="font-mono text-gray-300">{privacyMode ? 'Hidden in Secure View' : selected.addresses.join(', ')}</dd>
            <dt className="text-gray-500">PID</dt>
            <dd className="font-mono text-gray-300">{selected.pids.join(', ')}</dd>
            <dt className="text-gray-500">Observed connections</dt>
            <dd className="text-gray-300">
              {!connectionDataAvailable
                ? 'Unavailable'
                : connectionTotal(selected) === 0
                  ? 'None observed'
                  : `${selected.connections.loopback} loopback, ${selected.connections.lan} LAN, ${selected.connections.internet} internet${selected.connections.unknown ? `, ${selected.connections.unknown} unknown` : ''}`}
            </dd>
            <dt className="text-gray-500">Firewall</dt>
            <dd className="text-gray-300">{FIREWALL_LABEL[selected.firewall]}</dd>
          </dl>
          <p className="text-gray-600 text-xs">Reach comes from the bind address. Firewall and router settings can still block access.</p>
        </section>
      ) : selectedKey ? (
        <p className="text-gray-500 text-xs">Port {selectedKey.split('/')[0]} is not listening now.</p>
      ) : null}

      {services.length > 0 && (
        <p className="text-gray-400 text-xs">
          {connectionDataAvailable
            ? 'Bind scope shows where a service listens. LAN and internet counts show connections observed in this snapshot.'
            : 'Per-service connection data is unavailable in this snapshot.'}
        </p>
      )}

      {([
        ['Bound beyond this Mac', exposed],
        ['This Mac only', local]
      ] as const).map(([title, group]) =>
        group.length === 0 ? null : (
          <div key={title} className="space-y-1">
            <h3 className="text-[11px] uppercase tracking-wide text-gray-400">{title}</h3>
            <ul className="space-y-0.5">
              {group.map((service) => (
                <li key={service.key}>
                  <button
                    type="button"
                    aria-pressed={service.key === selectedKey}
                    onClick={() => choose(service.key)}
                    className={`w-full grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 items-center py-1.5 px-2 rounded text-left hover:bg-gray-800/50 sm:grid-cols-[minmax(0,1fr)_minmax(9rem,0.65fr)_minmax(9rem,0.55fr)] ${
                      service.key === selectedKey ? 'bg-gray-800/60 ring-1 ring-[color:var(--helm-accent)]' : ''
                    }`}
                  >
                    <span className="col-span-2 flex items-center gap-2 min-w-0 sm:col-span-1">
                      <span className="text-white font-mono font-bold">:{service.port}</span>
                      <span className="text-gray-400 truncate">{show(service.process)}</span>
                    </span>
                    <span className="text-gray-400 text-xs">{REACH_LABEL[service.reach]}</span>
                    <span className="flex flex-wrap justify-end gap-x-3 text-gray-400 text-xs tabular-nums">
                      {connectionDataAvailable
                        ? ([['lan', 'LAN'], ['internet', 'Internet']] as const).map(([scope, label]) => (
                            <span key={scope} className={`whitespace-nowrap ${service.connections[scope] > 0 ? 'font-semibold text-[color:var(--helm-accent-warm)]' : ''}`}>
                              {label} {service.connections[scope]}
                            </span>
                          ))
                        : 'Unavailable'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )
      )}

      {!storageAvailable && (
        <p className="text-gray-600 text-xs">This view cannot save its settings here. They last until Helm closes.</p>
      )}
    </div>
  )
}
