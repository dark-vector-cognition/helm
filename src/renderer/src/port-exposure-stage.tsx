// Development review page for the Grid > Listening Ports 3D map.
// It renders the real panel with a fixed synthetic snapshot, because live monitor data needs Electron.
import React from 'react'
import ReactDOM from 'react-dom/client'
import './assets/main.css'
import { PortExposurePanel } from './panels/PortExposure'
import { buildExposedServices } from './stores/port-exposure'
import type { NetworkConnection, PortInfo } from '../../shared/types'

const listen = (port: number, process: string, address: string, pid: number): PortInfo => ({
  port,
  pid,
  process,
  protocol: 'TCP',
  state: 'LISTEN',
  address
})

const link = (localPort: number, pid: number, scope: NetworkConnection['scope'], n: number): NetworkConnection[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${localPort}-${scope}-${i}`,
    processName: '',
    pid,
    protocol: 'TCP',
    state: 'ESTABLISHED',
    localAddress: scope === 'loopback' ? '127.0.0.1' : '192.168.1.20',
    localPort,
    remoteAddress: scope === 'loopback' ? '127.0.0.1' : scope === 'lan' ? '192.168.1.10' : '203.0.113.10',
    remotePort: 50000 + i,
    scope,
    bytesIn: 0,
    bytesOut: 0,
    bytesInPerSec: 0,
    bytesOutPerSec: 0
  }))

const SAMPLE = buildExposedServices(
  [
    listen(1234, 'LM Studio', '127.0.0.1', 501),
    listen(8742, 'vault-rag', '127.0.0.1', 502),
    listen(5173, 'node', '::1', 503),
    listen(5173, 'node', '127.0.0.1', 503),
    listen(47318, 'node', '127.0.0.1', 504),
    listen(11434, 'ollama', '*', 505),
    listen(11434, 'ollama', '127.0.0.1', 505),
    listen(8080, 'llama-server', '0.0.0.0', 506),
    listen(7000, 'ControlCenter', '*', 507),
    listen(5000, 'python3', '192.168.1.20', 508)
  ],
  [
    ...link(1234, 501, 'loopback', 3),
    ...link(8742, 502, 'loopback', 1),
    ...link(11434, 505, 'lan', 2),
    ...link(11434, 505, 'loopback', 4),
    ...link(8080, 506, 'lan', 1),
    ...link(8080, 506, 'internet', 1)
  ],
  [{ path: '/usr/local/bin/ollama', name: 'ollama', action: 'allow', type: 'user' }]
)

const params = new URLSearchParams(location.search)
const forceFallback = params.get('webgl') === 'off'

function Review(): JSX.Element {
  return (
    <div className="helm-shell min-h-screen p-4" data-skin="signal">
      <section className="shell-panel max-w-5xl mx-auto flex flex-col">
        <div className="shell-panel-header">
          <h1 className="shell-panel-title text-[11px] font-semibold">Listening Ports</h1>
        </div>
        <div className="shell-panel-body">
          <p className="mb-3 text-xs text-[color:var(--helm-accent-warm)]">
            Sample snapshot for review. These are not this machine's ports.
          </p>
          <PortExposurePanel sample={SAMPLE} forceFallback={forceFallback} />
        </div>
      </section>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('app') as HTMLElement).render(
  <React.StrictMode>
    <Review />
  </React.StrictMode>
)
