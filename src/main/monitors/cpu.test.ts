import { describe, expect, it } from 'vitest'
import type { CpuInfo } from 'os'
import { getCpuUsage } from './cpu'

function cpu(user: number, idle: number): CpuInfo {
  return { model: 'test', speed: 1000, times: { user, idle, nice: 0, sys: 0, irq: 0 } }
}

describe('CPU sampling', () => {
  it('reports a fresh busy interval after a long idle period', () => {
    expect(getCpuUsage([cpu(200, 900)], [cpu(100, 900)])).toBe(100)
  })

  it('reports the current idle interval and averages across cores', () => {
    expect(getCpuUsage([cpu(100, 1000)], [cpu(100, 900)])).toBe(0)
    expect(getCpuUsage([cpu(200, 900), cpu(100, 1000)], [cpu(100, 900), cpu(100, 900)])).toBe(50)
  })

  it('handles missing, unchanged, replaced, and reset counters without NaN or spikes', () => {
    expect(getCpuUsage([], [])).toBe(0)
    expect(getCpuUsage([cpu(100, 900)], [])).toBe(0)
    expect(getCpuUsage([cpu(100, 900)], [cpu(100, 900)])).toBe(0)
    expect(getCpuUsage([cpu(10, 90)], [cpu(100, 900)])).toBe(0)
    expect(getCpuUsage([cpu(1000, 90)], [cpu(100, 900)])).toBe(0)
  })
})
