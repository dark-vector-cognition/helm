import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getRepoCommitHistory, isValidCommitLimit } from './git'

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe('isValidCommitLimit', () => {
  it('accepts whole numbers from 1 to 100', () => {
    for (const n of [1, 2, 20, 99, 100]) expect(isValidCommitLimit(n)).toBe(true)
  })

  it('rejects everything else', () => {
    const bad: unknown[] = [
      0,
      -1,
      -100,
      101,
      1000,
      1e9,
      Number.MAX_SAFE_INTEGER,
      1.5,
      20.0000001,
      Number.NaN,
      Infinity,
      -Infinity,
      '20',
      '1; touch x #',
      '',
      null,
      undefined,
      {},
      [20],
      true
    ]
    for (const value of bad) expect(isValidCommitLimit(value)).toBe(false)
  })
})

// Real runs, no mocks. A limit that carries shell syntax must run nothing and return nothing.
describe.skipIf(!hasGit())('getRepoCommitHistory with a real repository', () => {
  let root: string
  let repo: string

  function commit(message: string): void {
    execFileSync(
      'git',
      ['-c', 'user.name=Test Author', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', message],
      { cwd: repo }
    )
  }

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'helm-history-')))
    repo = join(root, 'repo')
    execFileSync('git', ['init', '-q', repo])
    for (const n of [1, 2, 3, 4, 5]) commit(`change ${n}`)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('returns the newest commits up to a valid limit', async () => {
    const one = await getRepoCommitHistory(repo, 1)
    const three = await getRepoCommitHistory(repo, 3)
    const all = await getRepoCommitHistory(repo, 100)

    expect(one.map((c) => c.message)).toEqual(['change 5'])
    expect(three.map((c) => c.message)).toEqual(['change 5', 'change 4', 'change 3'])
    expect(all).toHaveLength(5)
    expect(all[0].author).toBe('Test Author')
  })

  it('uses 20 when no limit is given', async () => {
    await expect(getRepoCommitHistory(repo)).resolves.toHaveLength(5)
  })

  it('runs nothing and returns nothing for a limit with shell syntax', async () => {
    const before = readdirSync(repo).sort()
    const cwdBefore = readdirSync(process.cwd()).sort()

    const result = await getRepoCommitHistory(repo, '1; touch x #' as unknown as number)

    expect(result).toEqual([])
    expect(existsSync(join(repo, 'x'))).toBe(false)
    expect(readdirSync(repo).sort()).toEqual(before)
    expect(readdirSync(process.cwd()).sort()).toEqual(cwdBefore)
  })

  it('returns nothing for a float, a negative number, zero, and huge numbers', async () => {
    for (const limit of [1.5, -1, 0, 101, 1e9, Number.MAX_SAFE_INTEGER, Number.NaN, Infinity]) {
      await expect(getRepoCommitHistory(repo, limit)).resolves.toEqual([])
    }
  })

  it('reads a repository whose path holds quotes and shell syntax', async () => {
    const odd = join(root, `it's $(touch ${join(root, 'pwned')}) "dir"`)
    execFileSync('git', ['clone', '-q', repo, odd])

    const result = await getRepoCommitHistory(odd, 2)

    expect(result).toHaveLength(2)
    expect(existsSync(join(root, 'pwned'))).toBe(false)
  })
})
