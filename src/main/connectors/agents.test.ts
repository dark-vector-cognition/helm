import { describe, expect, it } from 'vitest'
import type { AgentInfo } from '../../shared/types'
import { connectorAgentMatcher } from './agents'

const started = Date.parse('Mon Nov  9 20:10:03 2026')
const sample = [
  '40  1  501 Mon Nov  9 20:10:00 2026 /bin/codex',
  '41  1  501 Mon Nov  9 20:10:00 2026 /bin/codex',
  '45 40  501 Mon Nov  9 20:10:01 2026 /bin/sh',
  '50 45  501 Mon Nov  9 20:10:02 2026 /bin/node',
  '60 50  501 Mon Nov  9 20:10:03 2026 /bin/python',
  '61 50  502 Mon Nov  9 20:10:03 2026 /bin/python',
  '70 40  501 Mon Nov  9 20:10:02 2026 /bin/other',
  '71 70  501 Mon Nov  9 20:10:03 2026 /bin/python'
].join('\n')

function agent(pid: number, type: AgentInfo['type'] = 'codex'): AgentInfo {
  return { id: `pid:${pid}`, name: 'same label', type, status: 'unknown', source: 'process', pid }
}

describe('connector caller attribution', () => {
  it('uses the same-user process ancestry to choose the exact client', () => {
    const find = connectorAgentMatcher(sample, [agent(41), agent(40)], 501)
    expect(find(60, started)).toEqual({ pid: 40, name: 'Codex' })
  })

  it('withholds attribution for PID reuse, unrelated processes and other users', () => {
    const find = connectorAgentMatcher(sample, [agent(40)], 501)
    expect(find(60, started - 5000)).toBeUndefined()
    expect(find(61, started)).toBeUndefined()
    expect(find(71, started)).toBeUndefined()
    expect(connectorAgentMatcher(sample, [agent(40, 'claude-code')], 501)(60, started)).toBeUndefined()
  })
})
