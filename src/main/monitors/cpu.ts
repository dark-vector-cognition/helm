import type { CpuInfo } from 'os'

export function getCpuUsage(current: CpuInfo[], previous: CpuInfo[]): number {
  if (current.length === 0 || current.length !== previous.length) return 0

  let totalDelta = 0
  let idleDelta = 0
  for (let i = 0; i < current.length; i++) {
    const now = current[i].times
    const before = previous[i].times
    const total = Object.values(now).reduce((sum, time) => sum + time, 0)
    const previousTotal = Object.values(before).reduce((sum, time) => sum + time, 0)
    if (total < previousTotal || now.idle < before.idle) return 0
    totalDelta += total - previousTotal
    idleDelta += now.idle - before.idle
  }

  return totalDelta > 0 ? Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)) : 0
}
