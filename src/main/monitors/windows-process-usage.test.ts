import { describe, expect, it } from 'vitest'
import { groupProcesses, WindowsProcessSampler } from './processes'

const GIB = 1024 ** 3
const header = '"Id","ProcessName","CPU","WorkingSetBytes","Path","User","StartTime","SampleTime"'
function csv(rows: Array<Array<string | number>>): string {
  return [
    header,
    ...rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(','))
  ].join('\r\n')
}
function row(
  cpu: string | number,
  time: number,
  options: { pid?: number; started?: string; memory?: number; path?: string } = {}
): Array<string | number> {
  return [
    options.pid ?? 42,
    'node',
    cpu,
    options.memory ?? GIB,
    options.path ?? 'C:\\Users\\dev\\demo\\node.exe',
    '',
    options.started ?? '10000000000000000',
    time
  ]
}
function sampler(): WindowsProcessSampler {
  return new WindowsProcessSampler({ logicalCpuCount: 8, totalMemoryBytes: 16 * GIB })
}

describe('Windows process usage percentages', () => {
  it('reports a baseline CPU sample as zero, and working-set bytes as percent of RAM', () => {
    const [process] = sampler().parse(csv([row(7200, 100)]))
    expect(process.cpu).toBe(0)
    expect(process.mem).toBe(6.25)
  })

  it('normalizes CPU deltas to elapsed time and all logical processors', () => {
    const monitor = sampler()
    monitor.parse(csv([row(7200, 100)]))
    expect(monitor.parse(csv([row(7202, 102)]))[0].cpu).toBe(12.5)
    expect(monitor.parse(csv([row(7202, 105)]))[0].cpu).toBe(0)
  })

  it('uses actual sample times instead of assuming the polling interval', () => {
    const monitor = sampler()
    monitor.parse(csv([row(10, 10)]))
    expect(monitor.parse(csv([row(14, 18)]))[0].cpu).toBe(6.25)
  })

  it('does not inherit CPU time when Windows reuses a PID', () => {
    const monitor = sampler()
    monitor.parse(csv([row(10, 10)]))
    expect(monitor.parse(csv([row(50, 12, { started: '20000000000000000' })]))[0].cpu).toBe(0)
    expect(monitor.parse(csv([row(51, 14, { started: '20000000000000000' })]))[0].cpu).toBe(6.25)
  })

  it('drops exited processes from its baseline', () => {
    const monitor = sampler()
    monitor.parse(csv([row(10, 10)]))
    monitor.parse(csv([]))
    expect(monitor.parse(csv([row(20, 20)]))[0].cpu).toBe(0)
  })

  it('rebaselines missing or regressed counters without a spike', () => {
    const monitor = sampler()
    monitor.parse(csv([row(10, 10)]))
    expect(monitor.parse(csv([row('', 12)]))[0].cpu).toBe(0)
    expect(monitor.parse(csv([row(20, 14)]))[0].cpu).toBe(0)
    expect(monitor.parse(csv([row(1, 16)]))[0].cpu).toBe(0)
    expect(monitor.parse(csv([row(2, 18)]))[0].cpu).toBe(6.25)
  })

  it('handles repeated timestamps, missing start times and invalid numeric values', () => {
    const monitor = sampler()
    monitor.parse(csv([row(10, 10)]))
    expect(monitor.parse(csv([row(11, 10)]))[0].cpu).toBe(0)
    expect(monitor.parse(csv([row(12, 12, { started: '' })]))[0].cpu).toBe(0)
    expect(monitor.parse(csv([row('NaN', 14, { memory: -1 })]))[0]).toMatchObject({
      cpu: 0,
      mem: 0
    })
    expect(monitor.parse(csv([row('Infinity', 16)]))[0].cpu).toBe(0)
  })

  it('skips the idle pseudo-process and invalid PIDs, and retains CSV paths with commas', () => {
    const rows = sampler().parse(
      csv([
        row(1, 10, { pid: 0 }),
        row(1, 10, { pid: -1 }),
        row(1, 10, { path: 'C:\\Users\\dev\\demo, app\\node.exe' })
      ])
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].command).toBe('C:\\Users\\dev\\demo, app\\node.exe')
  })

  it('sums percentages for multi-process apps instead of seconds and megabytes', () => {
    const monitor = sampler()
    monitor.parse(csv([row(10, 10), row(20, 10, { pid: 43 })]))
    const processes = monitor.parse(csv([row(12, 12), row(24, 12, { pid: 43 })]))
    const [group] = groupProcesses(processes)
    expect(group.totalCpu).toBe(37.5)
    expect(group.totalMem).toBe(12.5)
  })
})
