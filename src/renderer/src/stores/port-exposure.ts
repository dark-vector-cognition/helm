import { create } from 'zustand'
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware'
import type {
  FirewallRule,
  NetworkConnection,
  NetworkScope,
  PortInfo
} from '../../../shared/types'

// Where a listening socket can be reached from, judged by its bind address.
// 'local' = loopback only. 'interface' = one specific address. 'all' = every interface.
export type BindReach = 'local' | 'interface' | 'all'
export type FirewallMatch = 'allow' | 'block' | 'unknown'
export type ExposureView = '3d' | 'list'

export interface ExposedService {
  key: string
  port: number
  process: string
  pids: number[]
  addresses: string[]
  reach: BindReach
  connections: Record<NetworkScope, number>
  firewall: FirewallMatch
}

export interface SavedCamera {
  yaw: number
  pitch: number
  distance: number
}

export const REACH_LABEL: Record<BindReach, string> = {
  local: 'This Mac only',
  interface: 'One network address',
  all: 'All network interfaces'
}

export const REACH_DETAIL: Record<BindReach, string> = {
  local: 'Bound to loopback. Other devices cannot open this port.',
  interface:
    'Bound to one address. Devices that can reach that address can try this port, subject to the firewall.',
  all: 'Bound to every interface. Devices on your network can try this port, subject to the firewall.'
}

const REACH_RANK: Record<BindReach, number> = { local: 0, interface: 1, all: 2 }
const WILDCARD_BINDS = new Set(['*', '0.0.0.0', '::', '*.*', ''])

function normalizeBindAddress(address: string): string {
  return address.trim().toLowerCase().replace(/^\[|\]$/g, '')
}

export function classifyBindAddress(address: string): BindReach {
  const value = normalizeBindAddress(address).replace(/%.*$/, '')
  if (WILDCARD_BINDS.has(value)) return 'all'
  if (value === 'localhost' || value === '::1' || value.startsWith('127.')) return 'local'
  if (value.startsWith('::ffff:127.')) return 'local'
  return 'interface'
}

export function matchFirewall(processName: string, rules: FirewallRule[] = []): FirewallMatch {
  const name = processName.toLowerCase()
  if (!name) return 'unknown'
  let match: FirewallMatch = 'unknown'
  for (const rule of rules) {
    if (rule.name.toLowerCase() !== name) continue
    if (match !== 'unknown' && match !== rule.action) return 'unknown'
    match = rule.action
  }
  return match
}

function emptyScopes(): Record<NetworkScope, number> {
  return { loopback: 0, lan: 0, internet: 0, unknown: 0 }
}

export function serviceKey(port: number, process: string): string {
  return `${port}/${process}`
}

// One service per port and process. lsof often reports the same service twice (IPv4 and IPv6);
// the widest reach wins so the view never understates exposure.
export function buildExposedServices(
  ports: PortInfo[],
  connections: NetworkConnection[] = [],
  firewallRules: FirewallRule[] = []
): ExposedService[] {
  const services = new Map<string, ExposedService>()
  const listeners = ports.filter((entry) => entry.state === 'LISTEN')
  for (const entry of listeners) {
    const key = serviceKey(entry.port, entry.process)
    const reach = classifyBindAddress(entry.address)
    const existing = services.get(key)
    if (existing) {
      if (!existing.pids.includes(entry.pid)) existing.pids.push(entry.pid)
      if (!existing.addresses.includes(entry.address)) existing.addresses.push(entry.address)
      if (REACH_RANK[reach] > REACH_RANK[existing.reach]) existing.reach = reach
      continue
    }
    services.set(key, {
      key,
      port: entry.port,
      process: entry.process,
      pids: [entry.pid],
      addresses: [entry.address],
      reach,
      connections: emptyScopes(),
      firewall: matchFirewall(entry.process, firewallRules)
    })
  }

  for (const connection of connections) {
    if (connection.localPort === null) continue
    const protocol = connection.protocol.toUpperCase().replace(/[46]$/, '')
    const address = normalizeBindAddress(connection.localAddress)
    const listener = listeners.find((entry) => {
      if (entry.port !== connection.localPort || entry.pid !== connection.pid || entry.protocol !== protocol) return false
      const bind = normalizeBindAddress(entry.address)
      if (bind === '0.0.0.0') return !address.includes(':')
      return bind === address || WILDCARD_BINDS.has(bind)
    })
    if (!listener) continue
    const service = services.get(serviceKey(listener.port, listener.process))
    if (service) service.connections[connection.scope] += 1
  }

  return [...services.values()].sort(
    (a, b) => REACH_RANK[b.reach] - REACH_RANK[a.reach] || a.port - b.port
  )
}

export function connectionTotal(service: ExposedService): number {
  const c = service.connections
  return c.loopback + c.lan + c.internet + c.unknown
}

// Keep dense local boxes inside the 1.1 m slab, with space between even selected boxes.
export function localServiceGrid(
  index: number,
  count: number
): { x: number; z: number; scale: number } {
  const columns = Math.ceil(Math.sqrt(count))
  const rows = Math.ceil(count / columns)
  const row = Math.floor(index / columns)
  const rowLength = Math.min(columns, count - row * columns)
  const step = Math.min(0.15, 0.9 / columns)
  return {
    x: ((index % columns) - (rowLength - 1) / 2) * step,
    z: (row - (rows - 1) / 2) * step,
    scale: Math.min(1, step / 0.125)
  }
}

// ---------- persisted view state ----------

export interface PortExposurePersisted {
  view: ExposureView
  selectedKey: string | null
  camera: SavedCamera | null
}

export const PORT_EXPOSURE_DEFAULTS: PortExposurePersisted = {
  view: 'list',
  selectedKey: null,
  camera: null
}

function finite(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null
}

// Stored data comes from disk and may be stale, hand-edited or from another version.
export function sanitizePersisted(raw: unknown): PortExposurePersisted {
  if (!raw || typeof raw !== 'object') return { ...PORT_EXPOSURE_DEFAULTS }
  const input = raw as Record<string, unknown>
  const view: ExposureView = input.view === '3d' ? '3d' : PORT_EXPOSURE_DEFAULTS.view
  const selectedKey =
    typeof input.selectedKey === 'string' && /^\d{1,5}\/.{1,200}$/.test(input.selectedKey)
      ? input.selectedKey
      : null
  let camera: SavedCamera | null = null
  if (input.camera && typeof input.camera === 'object') {
    const c = input.camera as Record<string, unknown>
    const yaw = finite(c.yaw, -3600, 3600)
    const pitch = finite(c.pitch, -89, -5)
    const distance = finite(c.distance, 0.8, 8)
    if (yaw !== null && pitch !== null && distance !== null) camera = { yaw, pitch, distance }
  }
  return { view, selectedKey, camera }
}

// Storage can throw (quota, disabled, private mode). The view keeps working in memory.
export let storageAvailable = true
export const safeStorage: StateStorage = {
  getItem: (name) => {
    try {
      return window.localStorage.getItem(name)
    } catch {
      storageAvailable = false
      return null
    }
  },
  setItem: (name, value) => {
    try {
      window.localStorage.setItem(name, value)
    } catch {
      storageAvailable = false
    }
  },
  removeItem: (name) => {
    try {
      window.localStorage.removeItem(name)
    } catch {
      storageAvailable = false
    }
  }
}

interface PortExposureStore extends PortExposurePersisted {
  setView: (view: ExposureView) => void
  select: (key: string | null) => void
  saveCamera: (camera: SavedCamera | null) => void
}

export const usePortExposureStore = create<PortExposureStore>()(
  persist(
    (set) => ({
      ...PORT_EXPOSURE_DEFAULTS,
      setView: (view) => set({ view }),
      select: (selectedKey) => set({ selectedKey }),
      saveCamera: (camera) => set({ camera })
    }),
    {
      name: 'helm-port-exposure',
      version: 2,
      storage: createJSONStorage(() => safeStorage),
      partialize: (s) => ({ view: s.view, selectedKey: s.selectedKey, camera: s.camera }),
      // Older saves did not distinguish an explicit map choice from the default.
      migrate: (persisted) => ({ ...sanitizePersisted(persisted), view: PORT_EXPOSURE_DEFAULTS.view }),
      merge: (persisted, current) => ({ ...current, ...sanitizePersisted(persisted) })
    }
  )
)
