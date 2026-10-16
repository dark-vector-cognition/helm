import { exec } from 'child_process'
import { promisify } from 'util'
import { isMacOS, isWindows } from '../platform'

const execAsync = promisify(exec)

export interface BatteryState {
  hasBattery: boolean
  percent: number
  charging: boolean
  source: 'battery' | 'ac' | 'unknown'
  timestamp: number
}

/**
 * Parse `pmset -g batt` output on macOS.
 *
 * Example output:
 *   Now drawing from 'AC Power'
 *    -InternalBattery-0 (id=1234)	87%; charging; 0:42 remaining present: true
 *
 * Or:
 *   Now drawing from 'Battery Power'
 *    -InternalBattery-0 (id=1234)	42%; discharging; 1:30 remaining present: true
 */
export function parsePmsetOutput(raw: string): BatteryState {
  const now = Date.now()
  const lines = raw.trim().split('\n')

  if (lines.length === 0) {
    return { hasBattery: false, percent: 0, charging: false, source: 'unknown', timestamp: now }
  }

  // Determine power source from first line
  const firstLine = lines[0]
  let source: BatteryState['source'] = 'unknown'
  if (firstLine.includes("'AC Power'")) {
    source = 'ac'
  } else if (firstLine.includes("'Battery Power'")) {
    source = 'battery'
  }

  // Find battery line
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line.includes('InternalBattery')) continue

    const percentMatch = line.match(/(\d+)%/)
    if (!percentMatch) continue

    const percent = parseInt(percentMatch[1], 10)
    const charging = line.includes('charging') && !line.includes('discharging') && !line.includes('not charging')

    return {
      hasBattery: true,
      percent,
      charging,
      source,
      timestamp: now
    }
  }

  return { hasBattery: false, percent: 0, charging: false, source, timestamp: now }
}

/**
 * Parse WMIC battery CSV output on Windows.
 *
 * WMIC CSV output: Node,BatteryStatus,EstimatedChargeRemaining
 * BatteryStatus: 1=discharging, 2=AC power
 */
export function parseWmicBatteryOutput(raw: string): BatteryState {
  const now = Date.now()
  const lines = raw.trim().split('\n').filter((l) => l.trim().length > 0)

  // Need at least header + one data row
  if (lines.length < 2) {
    return { hasBattery: false, percent: 0, charging: false, source: 'unknown', timestamp: now }
  }

  // Data rows start at index 1 (skip header)
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].trim().split(',')
    if (parts.length < 3) continue

    const batteryStatus = parseInt(parts[1].trim(), 10)
    const chargeRemaining = parseInt(parts[2].trim(), 10)

    if (isNaN(batteryStatus) || isNaN(chargeRemaining)) continue

    const charging = batteryStatus === 2
    const source: BatteryState['source'] = charging ? 'ac' : 'battery'

    return {
      hasBattery: true,
      percent: chargeRemaining,
      charging,
      source,
      timestamp: now
    }
  }

  return { hasBattery: false, percent: 0, charging: false, source: 'unknown', timestamp: now }
}

/**
 * Get battery status. Supports macOS (pmset) and Windows (wmic).
 * Returns no-battery state on other platforms.
 */
export async function getBatteryStatus(): Promise<BatteryState> {
  const now = Date.now()

  if (isMacOS()) {
    try {
      const { stdout } = await execAsync('pmset -g batt', { timeout: 3000 })
      return parsePmsetOutput(stdout)
    } catch {
      return { hasBattery: false, percent: 0, charging: false, source: 'unknown', timestamp: now }
    }
  }

  if (isWindows()) {
    try {
      const { stdout } = await execAsync(
        'wmic path Win32_Battery get BatteryStatus, EstimatedChargeRemaining /format:csv',
        { timeout: 5000 }
      )
      return parseWmicBatteryOutput(stdout)
    } catch {
      return { hasBattery: false, percent: 0, charging: false, source: 'unknown', timestamp: now }
    }
  }

  return { hasBattery: false, percent: 0, charging: false, source: 'unknown', timestamp: now }
}
