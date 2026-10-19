import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const fixture = vi.hoisted(() => ({ status: 'unknown', otherStatuses: [] as string[] }))
vi.mock('./system', () => ({ useSystemStore: (select: (state: unknown) => unknown) => select({ state: {
  agents: [{ id: 'review', name: 'Reviewer', type: 'other', source: 'state-file',
    status: fixture.status, currentAction: 'Review the workspace' },
  ...fixture.otherStatuses.map((status, i) => ({ id: `other-${i}`, name: 'Detected agent', type: 'other', source: 'process', status }))],
  processes: [], ports: [], gitRepos: [], cpu: { usage: 0 }, memory: { usagePercent: 0 }
} }) }))
vi.mock('./timeseries', () => ({ useTimeSeriesStore: () => ({
  cpuHistory: [], memHistory: [], netInHistory: [], netOutHistory: []
}) }))
vi.mock('./navigation', () => ({ useNavigationStore: (select: (state: unknown) => unknown) => select({ setCurrentPage: () => {} }) }))
vi.mock('./privacy', () => ({ usePrivacyStore: (select: (state: unknown) => unknown) => select({ privacyMode: true }), redactSensitiveText: (text: string) => text }))
import { ScorecardsStrip } from '../panels/ScorecardsStrip'
import { HeaderTicker } from '../components/HeaderTicker'

describe('agent state summaries', () => {
  it('does not turn unknown task state into idle or present-tense task activity', () => {
    fixture.status = 'unknown'
    const score = renderToStaticMarkup(createElement(ScorecardsStrip))
    const ticker = renderToStaticMarkup(createElement(HeaderTicker))
    expect(score).toContain('Agents • unknown')
    expect(score).not.toContain('Agents • idle')
    expect(ticker).toContain('1 unknown')
    expect(ticker).toContain('LAST REPORT: Review the workspace')
  })

  it('keeps an explicitly reported waiting state visible', () => {
    fixture.status = 'waiting'
    const score = renderToStaticMarkup(createElement(ScorecardsStrip))
    expect(score).toContain('Agents • 1 waiting')
    expect(score).not.toContain('Agents • reported idle')
  })

  it('keeps required review visible beside detected and active agents', () => {
    fixture.status = 'waiting'
    fixture.otherStatuses = ['unknown', 'active']
    const score = renderToStaticMarkup(createElement(ScorecardsStrip))
    expect(score).toContain('Agents • 1 waiting')
    expect(score).not.toContain('Agents • unknown')
    fixture.otherStatuses = []
  })

})
