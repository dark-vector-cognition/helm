import type { HiveSessionInfo } from '../../../shared/types'

export function getRunStages(session: HiveSessionInfo): {
  label: string
  done: boolean
  current: boolean
}[] {
  const returned = session.taskState === 'needs-review' || session.taskState === 'reviewed'
  return [
    { label: 'Launch', done: !!session.startedAt, current: false },
    { label: 'Accepted', done: !!session.acceptedAt, current: false },
    {
      label: 'Work',
      done: returned,
      current: !!session.acceptedAt && session.taskState === 'working'
    },
    { label: 'Review', done: session.taskState === 'reviewed', current: false }
  ]
}
