import { describe, expect, it } from 'vitest'
import { homePoint } from './radio-home'
import type { RadioHomeLocation } from '../../../shared/types'

function loc(latitude: unknown, longitude: unknown): RadioHomeLocation {
  return { label: 'Base', latitude, longitude } as RadioHomeLocation
}

describe('homePoint', () => {
  it('has no point when no home endpoint is saved', () => {
    expect(homePoint(undefined)).toBeNull()
    expect(homePoint(null)).toBeNull()
  })

  it('returns the saved coordinates as latitude then longitude', () => {
    expect(homePoint(loc(10.5, -20.25))).toEqual([10.5, -20.25])
  })

  it('treats 0 and the range limits as real coordinates', () => {
    expect(homePoint(loc(0, 0))).toEqual([0, 0])
    expect(homePoint(loc(90, 180))).toEqual([90, 180])
    expect(homePoint(loc(-90, -180))).toEqual([-90, -180])
  })

  it('rejects values that are not finite numbers', () => {
    expect(homePoint(loc(Number.NaN, 1))).toBeNull()
    expect(homePoint(loc(1, Number.POSITIVE_INFINITY))).toBeNull()
    expect(homePoint(loc('10', '20'))).toBeNull()
    expect(homePoint(loc(undefined, 5))).toBeNull()
    expect(homePoint(loc(5, null))).toBeNull()
  })

  it('rejects coordinates outside the valid range', () => {
    expect(homePoint(loc(90.01, 0))).toBeNull()
    expect(homePoint(loc(-91, 0))).toBeNull()
    expect(homePoint(loc(0, 180.5))).toBeNull()
    expect(homePoint(loc(0, -181))).toBeNull()
  })
})
