import { describe, expect, it } from 'vitest'
import type { HiveSessionInfo } from '../../../shared/types'
import { getRunStages } from './run-stages'

const run: HiveSessionInfo = {
  id: 'test',
  role: 'analyst',
  model: 'default',
  tmuxSession: '',
  tmuxWindow: '',
  workingDir: '/demo',
  startedAt: 100,
  status: 'running',
  taskState: 'starting'
}

describe('run evidence', () => {
  it('does not infer acceptance or working from a live process', () => {
    const stages = getRunStages({ ...run, taskState: 'working' })
    expect(stages.filter((s) => s.done).map((s) => s.label)).toEqual(['Launch'])
    expect(stages.some((s) => s.current)).toBe(false)
  })
  it('keeps a returned result separate from human review', () => {
    const stages = getRunStages({ ...run, acceptedAt: 101, taskState: 'needs-review' })
    expect(stages.map((s) => s.done)).toEqual([true, true, true, false])
    expect(
      getRunStages({ ...run, acceptedAt: 101, taskState: 'reviewed' }).every((s) => s.done)
    ).toBe(true)
  })
  it('never animates interrupted or failed work as current', () => {
    for (const taskState of ['failed', 'stopped', 'interrupted'] as const) {
      const stages = getRunStages({ ...run, acceptedAt: 101, finishedAt: 102, taskState })
      expect(stages.some((s) => s.current)).toBe(false)
      expect(stages[2].done).toBe(false)
    }
  })
})
