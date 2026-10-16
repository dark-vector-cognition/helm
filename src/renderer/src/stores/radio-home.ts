import type { RadioHomeLocation } from '../../../shared/types'

/** Fired on window after the home endpoint is saved, so other views can re-read it. */
export const RADIO_HOME_CHANGED_EVENT = 'helm:radio-home-changed'

/**
 * Turn the saved home endpoint into a [latitude, longitude] pair.
 * Returns null when nothing usable is saved: no location, a non-numeric value from a
 * hand-edited config file, or a coordinate outside the valid range. 0 is a valid value.
 */
export function homePoint(location: RadioHomeLocation | null | undefined): [number, number] | null {
  if (!location) return null
  const { latitude, longitude } = location
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return null
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  if (latitude < -90 || latitude > 90) return null
  if (longitude < -180 || longitude > 180) return null
  return [latitude, longitude]
}
