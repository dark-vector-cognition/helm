import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { expandGlobPattern } from './logs'
import { scanForRepos } from './git'

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// Real runs, no mocks: a directory whose name holds quotes, spaces and shell syntax must be
// treated as plain text and must never run anything.
const describePosix = process.platform === 'win32' ? describe.skip : describe

describePosix('POSIX path handling with quotes and shell syntax in the path', () => {
  let root: string
  let base: string
  let marker: string

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'helm-shell-')))
    marker = join(root, 'pwned')
    base = join(root, `it's "quoted" $(touch ${marker}) \`touch ${marker}\`; touch ${marker} dir`)
    mkdirSync(base, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('expands a wildcard pattern in such a directory and runs nothing', async () => {
    writeFileSync(join(base, 'a.log'), 'a')
    writeFileSync(join(base, 'b.log'), 'b')
    writeFileSync(join(base, 'c.txt'), 'c')

    const files = await expandGlobPattern(join(base, '*.log'))

    expect(files.sort()).toEqual([join(base, 'a.log'), join(base, 'b.log')])
    expect(existsSync(marker)).toBe(false)
  })

  it('returns nothing, and runs nothing, when the pattern matches no file', async () => {
    await expect(expandGlobPattern(join(base, '*.log'))).resolves.toEqual([])
    expect(existsSync(marker)).toBe(false)
  })

  it.skipIf(!hasGit())('finds a git repo inside such a directory and runs nothing', async () => {
    const repo = join(base, 'repo')
    mkdirSync(repo)
    execFileSync('git', ['init', '-q'], { cwd: repo })
    // A repo needs one commit before HEAD resolves.
    execFileSync(
      'git',
      ['-c', 'user.name=Test Author', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'init'],
      { cwd: repo }
    )

    const repos = await scanForRepos([base])

    expect(repos.map((r) => r.path)).toEqual([repo])
    expect(existsSync(marker)).toBe(false)
  })
})
