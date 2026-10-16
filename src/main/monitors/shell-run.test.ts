import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockExecFile, mockExec } = vi.hoisted(() => ({ mockExecFile: vi.fn(), mockExec: vi.fn() }))

vi.mock('child_process', () => ({ execFile: mockExecFile, exec: mockExec }))
vi.mock('../platform', () => ({ isWindows: () => true }))

import {
  POWERSHELL_ENV_PREFIX,
  POWERSHELL_EXPAND_GLOB_SCRIPT,
  POWERSHELL_FIND_GIT_SCRIPT,
  powerShellArgs,
  runPowerShell
} from './shell-run'
import { expandGlobPattern } from './logs'
import { scanForRepos } from './git'

// Paths that would break or hijack a PowerShell command string if they were pasted into one.
const NASTY_PATHS = [
  "C:\\Users\\O'Brien\\repos",
  'C:\\Users\\Jane\u2019s Files\\repos',
  "C:\\x'; Remove-Item -Recurse C:\\ ; '",
  'C:\\a" ; calc ; "b',
  'C:\\tmp\\$(calc)\\`whoami`',
  'C:\\Users\\me\\logs\\*.log'
]

interface ExecFileCall {
  file: string
  args: string[]
  env: Record<string, string>
}

function lastExecFileCall(): ExecFileCall {
  const call = mockExecFile.mock.calls[mockExecFile.mock.calls.length - 1]
  return { file: call[0], args: call[1], env: call[2].env }
}

describe('PowerShell calls keep paths out of the command text', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExecFile.mockImplementation(
      (_file: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: string) => void) =>
        cb(null, '')
    )
  })

  it('runPowerShell passes values through environment variables only', async () => {
    for (const path of NASTY_PATHS) {
      mockExecFile.mockClear()
      await runPowerShell('Get-ChildItem -LiteralPath $env:HELM_PS_DIR', { DIR: path }, 1000)

      const { file, args, env } = lastExecFileCall()
      expect(file).toBe('powershell.exe')
      expect(args).toEqual(powerShellArgs('Get-ChildItem -LiteralPath $env:HELM_PS_DIR'))
      expect(args.join(' ')).not.toContain(path)
      expect(env[`${POWERSHELL_ENV_PREFIX}DIR`]).toBe(path)
    }
  })

  it('the fixed scripts contain no value and read only their own variables', () => {
    expect(POWERSHELL_FIND_GIT_SCRIPT).toContain('$env:HELM_PS_DIR')
    expect(POWERSHELL_EXPAND_GLOB_SCRIPT).toContain('$env:HELM_PS_PATTERN')
    for (const script of [POWERSHELL_FIND_GIT_SCRIPT, POWERSHELL_EXPAND_GLOB_SCRIPT]) {
      // No quoted placeholder that a value could be pasted into.
      expect(script).not.toMatch(/\$\{|%s|\{\d\}/)
    }
  })

  it('scanForRepos sends a directory with a single quote as an environment value', async () => {
    const dir = "C:\\Users\\O'Brien\\repos"

    await scanForRepos([dir])

    const { file, args, env } = lastExecFileCall()
    expect(file).toBe('powershell.exe')
    expect(args[args.length - 1]).toBe(POWERSHELL_FIND_GIT_SCRIPT)
    expect(args.join(' ')).not.toContain("O'Brien")
    expect(env.HELM_PS_DIR).toContain("O'Brien")
    expect(mockExec).not.toHaveBeenCalled()
  })

  it('scanForRepos keeps every nasty directory out of the script', async () => {
    for (const dir of NASTY_PATHS) {
      mockExecFile.mockClear()
      await scanForRepos([dir])
      const { args, env } = lastExecFileCall()
      expect(args.join(' ')).not.toContain(dir)
      expect(env.HELM_PS_DIR).toContain(dir.slice(0, 12))
    }
  })

  it('expandGlobPattern sends a pattern with a single quote as an environment value', async () => {
    const pattern = "C:\\Users\\O'Brien\\logs\\*.log"

    await expandGlobPattern(pattern)

    const { file, args, env } = lastExecFileCall()
    expect(file).toBe('powershell.exe')
    expect(args[args.length - 1]).toBe(POWERSHELL_EXPAND_GLOB_SCRIPT)
    expect(args.join(' ')).not.toContain("O'Brien")
    expect(env.HELM_PS_PATTERN).toBe(pattern)
    expect(mockExec).not.toHaveBeenCalled()
  })

  it('reads Windows CRLF output into clean paths', async () => {
    mockExecFile.mockImplementation(
      (_file: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: string) => void) =>
        cb(null, "C:\\Users\\O'Brien\\logs\\a.log\r\nC:\\Users\\O'Brien\\logs\\b.log\r\n")
    )

    const files = await expandGlobPattern("C:\\Users\\O'Brien\\logs\\*.log")

    expect(files).toEqual(["C:\\Users\\O'Brien\\logs\\a.log", "C:\\Users\\O'Brien\\logs\\b.log"])
  })

  it('returns an empty list when PowerShell fails', async () => {
    mockExecFile.mockImplementation(
      (_file: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: string) => void) =>
        cb(new Error('boom'), '')
    )

    await expect(expandGlobPattern("C:\\O'Brien\\*.log")).resolves.toEqual([])
    await expect(scanForRepos(["C:\\O'Brien"])).resolves.toEqual([])
  })
})
