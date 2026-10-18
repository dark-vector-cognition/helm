import { describe, expect, it } from 'vitest'
import { parseWindowsNetstatAno, parseWindowsNetstatE } from './network'
import { parseNetstatOutput } from './ports'
import { parseWindowsProcessOutput } from './processes'
import { parseWmicBatteryOutput } from './battery'
import { parseWindowsDiskOutput } from './disk'
import { parseNetshFirewallOutput } from './firewall'

describe('windows netstat -e', () => {
  it('reads interface byte totals', () => {
    const raw = [
      'Interface Statistics',
      '',
      '                           Received            Sent',
      '',
      'Bytes                     123456789        98765432',
      'Unicast packets              1000            2000'
    ].join('\r\n')
    expect(parseWindowsNetstatE(raw)).toEqual({ bytesIn: 123456789, bytesOut: 98765432 })
  })

  it('returns null when no Bytes row is present', () => {
    expect(parseWindowsNetstatE('Interface Statistics\r\n')).toBeNull()
    expect(parseWindowsNetstatE('')).toBeNull()
  })
})

describe('windows netstat -ano (network)', () => {
  it('parses tcp and udp rows and classifies scope', () => {
    const raw = [
      'Active Connections',
      '',
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    192.168.1.5:49721      142.250.80.46:443      ESTABLISHED     12345',
      '  TCP    127.0.0.1:5000         127.0.0.1:50321        ESTABLISHED     222',
      '  UDP    0.0.0.0:5353           *:*                                    333'
    ].join('\r\n')
    const rows = parseWindowsNetstatAno(raw)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({
      pid: 12345,
      protocol: 'tcp',
      state: 'ESTABLISHED',
      remoteAddress: '142.250.80.46',
      remotePort: 443,
      scope: 'internet'
    })
    expect(rows[1].scope).toBe('loopback')
    expect(rows[2]).toMatchObject({ pid: 333, protocol: 'udp', remotePort: null })
  })

  it('skips rows without a usable pid and ignores headers', () => {
    const raw = ['Active Connections', '  TCP    10.0.0.2:80    10.0.0.3:81    ESTABLISHED    0'].join(
      '\n'
    )
    expect(parseWindowsNetstatAno(raw)).toEqual([])
  })
})

describe('windows netstat -ano (ports)', () => {
  it('maps listening sockets to port rows with process names', () => {
    const raw = [
      'Active Connections',
      '',
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       4321',
      '  UDP    0.0.0.0:5353           *:*                                    999'
    ].join('\r\n')
    const rows = parseNetstatOutput(raw, new Map([[4321, 'node']]))
    expect(rows).toEqual([
      { port: 3000, pid: 4321, process: 'node', protocol: 'TCP', state: 'LISTEN', address: '0.0.0.0' },
      { port: 5353, pid: 999, process: 'PID:999', protocol: 'UDP', state: 'OTHER', address: '0.0.0.0' }
    ])
  })

  it('returns an empty list for empty output', () => {
    expect(parseNetstatOutput('')).toEqual([])
  })
})

describe('windows process list', () => {
  it('parses PowerShell CSV rows, including quoted commas and missing paths', () => {
    const raw = [
      '"Id","ProcessName","CPU","WorkingSetBytes","Path","User","StartTime","SampleTime"',
      '"4120","node","12.5","0","C:\\Users\\dev\\projects\\sample-app\\node_modules\\.bin\\vite.exe","DEV\\dev","100","10"',
      '"88","System","0","0","","","","10"'
    ].join('\r\n')
    const rows = parseWindowsProcessOutput(raw)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ pid: 4120, cpu: 0, mem: 0, name: 'vite.exe' })
    expect(rows[0].cwd).toMatch(/^C:\/.*\/projects\/sample-app$/)
    expect(rows[1]).toMatchObject({ pid: 88, name: 'System' })
    expect(rows[1].cwd).toBeUndefined()
  })

  it('returns an empty list for header-only output', () => {
    expect(parseWindowsProcessOutput('"Id","ProcessName"')).toEqual([])
  })
})

describe('windows battery', () => {
  it('reads charge and AC state from wmic csv output', () => {
    const raw = ['Node,BatteryStatus,EstimatedChargeRemaining', 'HOST,2,87'].join('\r\n')
    const state = parseWmicBatteryOutput(raw)
    expect(state).toMatchObject({ hasBattery: true, percent: 87, charging: true, source: 'ac' })
  })

  it('reports no battery for header-only output', () => {
    const state = parseWmicBatteryOutput('Node,BatteryStatus,EstimatedChargeRemaining')
    expect(state.hasBattery).toBe(false)
  })
})

describe('windows disk usage', () => {
  it('parses volume rows and computes usage percent', () => {
    const raw = ['"Filesystem","Mount","Total","Used","Available"', '"NTFS","C:","1000","250","750"'].join(
      '\r\n'
    )
    const mounts = parseWindowsDiskOutput(raw)
    expect(mounts).toHaveLength(1)
    expect(mounts[0]).toMatchObject({ mount: 'C:', totalBytes: 1000, usedBytes: 250, usagePercent: 25 })
  })

  it('skips zero-size volumes and header-only output', () => {
    expect(parseWindowsDiskOutput('"Filesystem","Mount","Total","Used","Available"')).toEqual([])
    expect(
      parseWindowsDiskOutput(['h', '"NTFS","D:","0","0","0"'].join('\n'))
    ).toEqual([])
  })
})

describe('windows firewall rules', () => {
  it('reads enabled allow and block rules from netsh output', () => {
    const raw = [
      'Rule Name:                            Allow SSH',
      '----------------------------------------------------------------------',
      'Enabled:                              Yes',
      'Direction:                            In',
      'Action:                               Allow',
      'Program:                              C:\\Windows\\System32\\OpenSSH\\sshd.exe',
      '',
      'Rule Name:                            Block Telnet',
      '----------------------------------------------------------------------',
      'Enabled:                              Yes',
      'Action:                               Block',
      'Program:                              Any',
      '',
      'Rule Name:                            Disabled Rule',
      '----------------------------------------------------------------------',
      'Enabled:                              No',
      'Action:                               Allow'
    ].join('\r\n')
    const rules = parseNetshFirewallOutput(raw)
    expect(rules.map((r) => [r.name, r.action])).toEqual([
      ['sshd.exe', 'allow'],
      ['Block Telnet', 'block']
    ])
  })

  it('returns an empty list for empty output', () => {
    expect(parseNetshFirewallOutput('')).toEqual([])
  })
})
