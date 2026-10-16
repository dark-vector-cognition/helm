import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import path from 'path'
import {
  GitNotFoundError,
  createGitResolver,
  findOnPath,
  requireGit,
  resolveGit,
  type PathLookup
} from './git-binary'

/**
 * A fake machine: the files that exist (read live, so a test can add one later), a platform and an
 * environment. It records every probe.
 */
function fakeMachine(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  files: string[]
): PathLookup & { probes: string[] } {
  const probes: string[] = []
  return {
    platform,
    env,
    probes,
    isExecutableFile: async (fullPath: string) => {
      probes.push(fullPath)
      return files.includes(fullPath)
    }
  }
}

const WIN_GIT = 'C:\\Program Files\\Git\\cmd\\git.exe'

describe('findOnPath on Windows', () => {
  it('skips a git.exe planted in the working directory and uses the one on PATH', async () => {
    // A scanned repo sits at C:\repos\evil with a git.exe at its top. PATH holds an empty entry and
    // ".", which Windows resolves against that directory, then the real git.
    const machine = fakeMachine(
      'win32',
      { PATH: ';.;C:\\Windows\\System32;C:\\Program Files\\Git\\cmd', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      ['C:\\repos\\evil\\git.exe', 'git.exe', '.\\git.exe', WIN_GIT]
    )

    await expect(findOnPath('git', machine)).resolves.toBe(WIN_GIT)

    expect(machine.probes).not.toContain('C:\\repos\\evil\\git.exe')
    expect(machine.probes).not.toContain('git.exe')
    expect(machine.probes).not.toContain('.\\git.exe')
    for (const probe of machine.probes) expect(probe).toMatch(/^[A-Za-z]:\\/)
  })

  it('finds no git when PATH holds only relative entries, even with a git.exe in the working directory', async () => {
    const machine = fakeMachine(
      'win32',
      { PATH: ';.;bin;..\\tools;\\bin;C:bin', PATHEXT: '.EXE' },
      ['C:\\repos\\evil\\git.exe', 'git.exe', 'bin\\git.exe', '\\bin\\git.exe', 'C:bin\\git.exe']
    )

    await expect(findOnPath('git', machine)).resolves.toBeNull()
    expect(machine.probes).toEqual([])
  })

  it('tries the PATHEXT extensions in order and skips scripts that execFile cannot start', async () => {
    const both = fakeMachine('win32', { PATH: 'C:\\tools', PATHEXT: '.EXE;.COM' }, [
      'C:\\tools\\git.com',
      'C:\\tools\\git.exe'
    ])
    await expect(findOnPath('git', both)).resolves.toBe('C:\\tools\\git.exe')

    const comFirst = fakeMachine('win32', { PATH: 'C:\\tools', PATHEXT: '.COM;.EXE' }, [
      'C:\\tools\\git.com',
      'C:\\tools\\git.exe'
    ])
    await expect(findOnPath('git', comFirst)).resolves.toBe('C:\\tools\\git.com')

    // A git.cmd shim comes first on PATH, the real git.exe comes later.
    const shim = fakeMachine(
      'win32',
      { PATH: 'C:\\shims;C:\\Program Files\\Git\\cmd', PATHEXT: '.BAT;.CMD;.EXE' },
      ['C:\\shims\\git.cmd', 'C:\\shims\\git.bat', WIN_GIT]
    )
    await expect(findOnPath('git', shim)).resolves.toBe(WIN_GIT)
    expect(shim.probes).not.toContain('C:\\shims\\git.cmd')
    expect(shim.probes).not.toContain('C:\\shims\\git.bat')
  })

  it('falls back to .com then .exe when PATHEXT is missing, empty or has no runnable extension', async () => {
    for (const pathExt of [undefined, '', '   ', '.BAT;.CMD;.VBS']) {
      const machine = fakeMachine('win32', { PATH: 'C:\\tools', PATHEXT: pathExt }, [
        'C:\\tools\\git.exe'
      ])
      await expect(findOnPath('git', machine)).resolves.toBe('C:\\tools\\git.exe')
    }
  })

  it('reads Path and PathExt in any letter case', async () => {
    const machine = fakeMachine('win32', { Path: 'C:\\tools', PathExt: '.EXE' }, ['C:\\tools\\git.exe'])
    await expect(findOnPath('git', machine)).resolves.toBe('C:\\tools\\git.exe')
  })

  it('strips quotes and spaces around a PATH entry', async () => {
    const machine = fakeMachine(
      'win32',
      { PATH: '  "C:\\Program Files\\Git\\cmd"  ;', PATHEXT: '.EXE' },
      [WIN_GIT]
    )
    await expect(findOnPath('git', machine)).resolves.toBe(WIN_GIT)
  })

  it('accepts a network path entry and rejects drive-relative and root-relative entries', async () => {
    const unc = fakeMachine('win32', { PATH: '\\\\server\\share\\bin', PATHEXT: '.EXE' }, [
      '\\\\server\\share\\bin\\git.exe'
    ])
    await expect(findOnPath('git', unc)).resolves.toBe('\\\\server\\share\\bin\\git.exe')

    const relative = fakeMachine('win32', { PATH: 'C:git;\\git;git', PATHEXT: '.EXE' }, [])
    await expect(findOnPath('git', relative)).resolves.toBeNull()
    expect(relative.probes).toEqual([])
  })

  it('returns null when git is on no PATH entry', async () => {
    const machine = fakeMachine('win32', { PATH: 'C:\\Windows;C:\\Windows\\System32' }, [])
    await expect(findOnPath('git', machine)).resolves.toBeNull()
  })
})

describe('findOnPath on POSIX', () => {
  it('returns the first runnable git in PATH order', async () => {
    const machine = fakeMachine('linux', { PATH: '/opt/bin:/usr/local/bin:/usr/bin' }, [
      '/usr/local/bin/git',
      '/usr/bin/git'
    ])
    await expect(findOnPath('git', machine)).resolves.toBe('/usr/local/bin/git')
  })

  it('never probes an empty, ".", or relative PATH entry', async () => {
    // An empty PATH entry means the working directory to a POSIX shell.
    const machine = fakeMachine('darwin', { PATH: ':.:bin:./bin:../x::/usr/bin' }, [
      'git',
      './git',
      'bin/git',
      '/usr/bin/git'
    ])

    await expect(findOnPath('git', machine)).resolves.toBe('/usr/bin/git')
    expect(machine.probes).toEqual(['/usr/bin/git'])
  })

  it('is not fooled by Windows-style names or separators', async () => {
    const machine = fakeMachine('linux', { PATH: 'C:\\tools;/usr/bin', PATHEXT: '.EXE' }, [
      '/usr/bin/git',
      'C:\\tools/git'
    ])
    // On POSIX the delimiter is a colon, so the whole string is one relative entry.
    await expect(findOnPath('git', machine)).resolves.toBeNull()
  })

  it('finds no git when PATH is unset or empty', async () => {
    await expect(findOnPath('git', fakeMachine('linux', {}, ['/usr/bin/git']))).resolves.toBeNull()
    await expect(
      findOnPath('git', fakeMachine('linux', { PATH: '' }, ['/usr/bin/git']))
    ).resolves.toBeNull()
  })

  it('does not look up a name that contains a path separator', async () => {
    const machine = fakeMachine('linux', { PATH: '/usr/bin' }, ['/usr/bin/git', '/usr/evil/git'])
    await expect(findOnPath('../evil/git', machine)).resolves.toBeNull()
    await expect(findOnPath('', machine)).resolves.toBeNull()
    expect(machine.probes).toEqual([])
  })
})

describe('createGitResolver', () => {
  it('searches once and then returns the cached absolute path', async () => {
    const machine = fakeMachine('win32', { PATH: 'C:\\Windows;C:\\Program Files\\Git\\cmd', PATHEXT: '.EXE' }, [
      WIN_GIT
    ])
    const resolve = createGitResolver(() => machine)

    await expect(resolve()).resolves.toBe(WIN_GIT)
    const probesAfterFirst = machine.probes.length
    expect(probesAfterFirst).toBeGreaterThan(0)

    await expect(resolve()).resolves.toBe(WIN_GIT)
    await expect(resolve()).resolves.toBe(WIN_GIT)
    expect(machine.probes).toHaveLength(probesAfterFirst)
  })

  it('does not even read the environment again once it has found git', async () => {
    let lookups = 0
    const machine = fakeMachine('linux', { PATH: '/usr/bin' }, ['/usr/bin/git'])
    const resolve = createGitResolver(() => {
      lookups++
      return machine
    })

    await resolve()
    await resolve()

    expect(lookups).toBe(1)
  })

  it('shares one search between calls made at the same time', async () => {
    const machine = fakeMachine('linux', { PATH: '/usr/bin' }, ['/usr/bin/git'])
    const resolve = createGitResolver(() => machine)

    const results = await Promise.all([resolve(), resolve(), resolve()])

    expect(results).toEqual(['/usr/bin/git', '/usr/bin/git', '/usr/bin/git'])
    expect(machine.probes).toEqual(['/usr/bin/git'])
  })

  it('returns null when git is missing, and does not remember the miss', async () => {
    const files: string[] = []
    const machine = fakeMachine('linux', { PATH: '/usr/bin' }, files)
    const resolve = createGitResolver(() => machine)

    await expect(resolve()).resolves.toBeNull()
    await expect(resolve()).resolves.toBeNull()
    expect(machine.probes).toEqual(['/usr/bin/git', '/usr/bin/git'])

    // git gets installed while HELM runs. The same resolver finds it on the next call.
    files.push('/usr/bin/git')
    await expect(resolve()).resolves.toBe('/usr/bin/git')
  })

  it('treats a failing search as git missing', async () => {
    const resolve = createGitResolver(() => ({
      platform: 'linux',
      env: { PATH: '/usr/bin' },
      isExecutableFile: async () => {
        throw new Error('disk error')
      }
    }))

    await expect(resolve()).resolves.toBeNull()
  })
})

// The real machine. These need a git on PATH, which every developer and CI machine has.
function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe.skipIf(!hasGit())('resolveGit on this machine', () => {
  it('returns an absolute path to a git that runs', async () => {
    const git = await resolveGit()

    expect(git).not.toBeNull()
    expect(path.isAbsolute(git as string)).toBe(true)
    expect(execFileSync(git as string, ['--version']).toString()).toContain('git version')
  })

  it('requireGit returns the same path', async () => {
    await expect(requireGit()).resolves.toBe(await resolveGit())
  })
})

describe('requireGit', () => {
  it('throws GitNotFoundError with a plain message when git is missing', async () => {
    const saved = process.env.PATH
    vi.resetModules()
    process.env.PATH = ''
    try {
      // A fresh module, so no earlier search has cached a path.
      const fresh = await import('./git-binary')
      await expect(fresh.resolveGit()).resolves.toBeNull()
      const failure = await fresh.requireGit().catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(fresh.GitNotFoundError)
      expect((failure as Error).message).toBe('git was not found on PATH')
    } finally {
      process.env.PATH = saved
      vi.resetModules()
    }
  })

  it('GitNotFoundError is an Error', () => {
    expect(new GitNotFoundError()).toBeInstanceOf(Error)
  })
})
