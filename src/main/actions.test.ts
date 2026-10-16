import { describe, it, expect } from 'vitest'
import { isProtectedProcess, validatePid, PROTECTED_PROCESSES } from './actions'

const isWin = process.platform === 'win32'

describe('isProtectedProcess', () => {
  it('returns true for protected system processes', () => {
    if (isWin) {
      expect(isProtectedProcess('System')).toBe(true)
      expect(isProtectedProcess('csrss.exe')).toBe(true)
      expect(isProtectedProcess('explorer.exe')).toBe(true)
      expect(isProtectedProcess('lsass.exe')).toBe(true)
    } else {
      expect(isProtectedProcess('Finder')).toBe(true)
      expect(isProtectedProcess('WindowServer')).toBe(true)
      expect(isProtectedProcess('loginwindow')).toBe(true)
      expect(isProtectedProcess('kernel_task')).toBe(true)
    }
  })

  it('returns true for Helm itself', () => {
    expect(isProtectedProcess('Electron')).toBe(true)
    expect(isProtectedProcess('HELM')).toBe(true)
  })

  it('returns false for normal processes', () => {
    expect(isProtectedProcess('node')).toBe(false)
    expect(isProtectedProcess('postgres')).toBe(false)
    expect(isProtectedProcess('python3')).toBe(false)
  })

  it('matches case-insensitively', () => {
    if (isWin) {
      expect(isProtectedProcess('system')).toBe(true)
      expect(isProtectedProcess('EXPLORER.EXE')).toBe(true)
    } else {
      expect(isProtectedProcess('finder')).toBe(true)
      expect(isProtectedProcess('WINDOWSERVER')).toBe(true)
    }
  })
})

describe('validatePid', () => {
  it('returns false for PID 0 or negative', () => {
    expect(validatePid(0)).toBe(false)
    expect(validatePid(-1)).toBe(false)
  })

  it('returns false for PID 1 (init/launchd)', () => {
    expect(validatePid(1)).toBe(false)
  })

  it('returns true for normal PIDs', () => {
    expect(validatePid(1234)).toBe(true)
    expect(validatePid(99999)).toBe(true)
  })
})

describe('PROTECTED_PROCESSES', () => {
  it('contains critical system processes', () => {
    const names = PROTECTED_PROCESSES.map((n) => n.toLowerCase())
    if (isWin) {
      expect(names).toContain('system')
      expect(names).toContain('csrss.exe')
      expect(names).toContain('lsass.exe')
      expect(names).toContain('explorer.exe')
    } else {
      expect(names).toContain('finder')
      expect(names).toContain('windowserver')
      expect(names).toContain('loginwindow')
      expect(names).toContain('kernel_task')
    }
  })
})
