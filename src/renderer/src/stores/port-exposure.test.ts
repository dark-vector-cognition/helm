import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NetworkConnection, PortInfo } from '../../../shared/types'
import {
  buildExposedServices,
  classifyBindAddress,
  connectionTotal,
  localServiceGrid,
  matchFirewall,
  safeStorage,
  sanitizePersisted,
  usePortExposureStore
} from './port-exposure'

const listen = (port: number, process: string, address: string, pid = 100): PortInfo => ({
  port,
  pid,
  process,
  protocol: 'TCP',
  state: 'LISTEN',
  address
})

const conn = (
  localPort: number,
  pid: number,
  scope: NetworkConnection['scope']
): NetworkConnection => ({
  id: `${localPort}-${pid}-${scope}-${Math.random()}`,
  processName: 'x',
  pid,
  protocol: 'TCP',
  state: 'ESTABLISHED',
  localAddress: '127.0.0.1',
  localPort,
  remoteAddress: '10.0.0.2',
  remotePort: 50000,
  scope,
  bytesIn: 0,
  bytesOut: 0,
  bytesInPerSec: 0,
  bytesOutPerSec: 0
})

describe('classifyBindAddress', () => {
  it('treats loopback forms as local', () => {
    for (const a of ['127.0.0.1', '127.0.1.1', '::1', '[::1]', 'localhost', '::ffff:127.0.0.1']) {
      expect(classifyBindAddress(a)).toBe('local')
    }
  })
  it('treats wildcards as all interfaces', () => {
    for (const a of ['*', '0.0.0.0', '::', '[::]', '*.*']) {
      expect(classifyBindAddress(a)).toBe('all')
    }
  })
  it('treats a specific address as one interface', () => {
    expect(classifyBindAddress('192.168.1.20')).toBe('interface')
    expect(classifyBindAddress('fe80::1%en0')).toBe('interface')
  })
})

describe('buildExposedServices', () => {
  it('merges IPv4 and IPv6 entries and keeps the widest reach', () => {
    const services = buildExposedServices([
      listen(11434, 'ollama', '127.0.0.1'),
      listen(11434, 'ollama', '*')
    ])
    expect(services).toHaveLength(1)
    expect(services[0].reach).toBe('all')
    expect(services[0].addresses).toEqual(['127.0.0.1', '*'])
  })

  it('ignores non-listening sockets and sorts widest reach first', () => {
    const services = buildExposedServices([
      listen(1234, 'LM Studio', '127.0.0.1'),
      { ...listen(5000, 'x', '*'), state: 'ESTABLISHED' },
      listen(5173, 'node', '*')
    ])
    expect(services.map((s) => s.port)).toEqual([5173, 1234])
  })

  it('counts connections by scope for the owning process only', () => {
    const services = buildExposedServices(
      [listen(8742, 'python3', '*', 42)],
      [conn(8742, 42, 'lan'), conn(8742, 42, 'loopback'), conn(8742, 99, 'internet')]
    )
    expect(services[0].connections).toEqual({ loopback: 1, lan: 1, internet: 0, unknown: 0 })
    expect(connectionTotal(services[0])).toBe(2)
  })

  it('matches the listener protocol and bind address and counts each socket once', () => {
    const socket = { ...conn(5353, 42, 'lan'), localAddress: '192.168.1.20', protocol: 'tcp4' }
    const service = buildExposedServices(
      [
        listen(5353, 'node', '192.168.1.20', 42),
        listen(5353, 'node', '[::1]', 42),
        listen(5353, 'node', '192.168.1.20', 42)
      ],
      [
        socket,
        { ...socket, protocol: 'udp4' },
        { ...socket, localAddress: '192.168.1.21' },
        { ...socket, protocol: 'tcp6', localAddress: '::1', scope: 'loopback' }
      ]
    )[0]
    expect(service.connections).toEqual({ loopback: 1, lan: 1, internet: 0, unknown: 0 })
  })

  it('keeps IPv6 connections off an IPv4 wildcard listener', () => {
    const service = buildExposedServices(
      [listen(8080, 'node', '0.0.0.0', 42)],
      [
        { ...conn(8080, 42, 'lan'), localAddress: '192.168.1.20', protocol: 'tcp4' },
        { ...conn(8080, 42, 'loopback'), localAddress: '::1', protocol: 'tcp6' }
      ]
    )[0]
    expect(service.connections).toEqual({ loopback: 0, lan: 1, internet: 0, unknown: 0 })
  })
})

describe('matchFirewall', () => {
  it('uses exact name matches and leaves conflicting matches unknown', () => {
    const rules = [
      { path: '/x', name: 'ollama', action: 'allow' as const, type: 'user' as const },
      { path: '/y', name: 'sshd-keygen-wrapper', action: 'block' as const, type: 'system' as const }
    ]
    expect(matchFirewall('ollama', rules)).toBe('allow')
    expect(matchFirewall('sshd-keygen-wrapper', rules)).toBe('block')
    expect(matchFirewall('sshd', rules)).toBe('unknown')
    expect(matchFirewall('node', rules)).toBe('unknown')
    expect(matchFirewall('', rules)).toBe('unknown')
    expect(matchFirewall('ollama', [...rules, { ...rules[1], name: 'Ollama' }])).toBe('unknown')
  })
})

it('fits dense local boxes inside the slab without overlapping when selected', () => {
  for (const count of [11, 35, 256]) {
    const placements = Array.from({ length: count }, (_, index) => localServiceGrid(index, count))
    for (const [index, box] of placements.entries()) {
      const width = 0.09 * box.scale
      expect(Math.max(Math.abs(box.x), Math.abs(box.z)) + width / 2).toBeLessThan(0.5)
      for (const other of placements.slice(index + 1)) {
        expect(Math.max(Math.abs(box.x - other.x), Math.abs(box.z - other.z))).toBeGreaterThan(
          width
        )
      }
    }
  }
})

describe('sanitizePersisted', () => {
  it('returns defaults for invalid shapes', () => {
    expect(sanitizePersisted(null)).toEqual({ view: 'list', selectedKey: null, camera: null })
    expect(sanitizePersisted('junk')).toEqual({ view: 'list', selectedKey: null, camera: null })
  })
  it('keeps valid values and drops out-of-range camera data', () => {
    expect(
      sanitizePersisted({ view: '3d', selectedKey: '1234/LM Studio', camera: { yaw: 40, pitch: -30, distance: 2.5 } })
    ).toEqual({ view: '3d', selectedKey: '1234/LM Studio', camera: { yaw: 40, pitch: -30, distance: 2.5 } })
    expect(
      sanitizePersisted({ view: 'cube', selectedKey: 42, camera: { yaw: 40, pitch: 80, distance: 'far' } })
    ).toEqual({ view: 'list', selectedKey: null, camera: null })
  })
  it('opens legacy saved maps as a list once and keeps selection and camera', async () => {
    const state = { view: '3d', selectedKey: '8080/llama-server', camera: { yaw: 40, pitch: -30, distance: 2.5 } }
    let saved = JSON.stringify({ version: 1, state })
    vi.stubGlobal('window', { localStorage: { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value } } })
    try {
      await usePortExposureStore.persist.rehydrate()
      expect(usePortExposureStore.getState()).toMatchObject({ ...state, view: 'list' })
      usePortExposureStore.getState().setView('3d')
      await usePortExposureStore.persist.rehydrate()
      expect(usePortExposureStore.getState()).toMatchObject(state)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('safeStorage', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('does not throw when storage is unavailable', () => {
    const broken = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: () => {
        throw new Error('SecurityError')
      }
    }
    vi.stubGlobal('window', { localStorage: broken })
    expect(safeStorage.getItem('k')).toBeNull()
    expect(() => safeStorage.setItem('k', 'v')).not.toThrow()
    expect(() => safeStorage.removeItem('k')).not.toThrow()
  })
})
