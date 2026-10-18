import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const fixture = vi.hoisted(() => ({ privacyMode: true }))
const repoPath = '/private/workspace/helm-project'
vi.mock('./system', () => ({
  useSystemStore: (selector: (state: unknown) => unknown) =>
    selector({
      state: {
        gitRepos: [
          {
            name: 'helm',
            path: '/private/workspace/helm-project',
            branch: 'main',
            dirty: true,
            modified: 1,
            untracked: 0,
            ahead: 0,
            behind: 0,
            status: 'dirty'
          }
        ]
      },
      refresh: () => {}
    })
}))
vi.mock('./privacy', () => ({
  usePrivacyStore: (selector: (state: unknown) => unknown) => selector(fixture)
}))
import { GitStatusPanel } from '../panels/GitStatus'

describe('repository path privacy', () => {
  it('hides the path in both visible text and hover text in Secure View', () => {
    fixture.privacyMode = true
    const markup = renderToStaticMarkup(createElement(GitStatusPanel))
    expect(markup).toContain('Private workspace')
    expect(markup).not.toContain(repoPath)
  })

  it('shows the actual path when Secure View is off', () => {
    fixture.privacyMode = false
    const markup = renderToStaticMarkup(createElement(GitStatusPanel))
    expect(markup).toContain(repoPath)
    expect(markup).toContain(`title="${repoPath}"`)
  })
})
