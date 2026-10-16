/**
 * One way to compare model endpoint URLs, shared by the config store and the model client so
 * they can never disagree about whether two URLs name the same endpoint.
 *
 * Reduces a URL to what identifies the host: no trailing slash, no /v1, no query or hash, and a
 * lower-case scheme and host. Returns null for an empty or unparseable value.
 */
export function normalizeEndpointUrl(raw: unknown): string | null {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  if (!trimmed) return null

  try {
    const url = new URL(trimmed)
    url.hash = ''
    url.search = ''

    let pathname = url.pathname.replace(/\/+$/, '')
    if (pathname.endsWith('/v1')) {
      pathname = pathname.slice(0, -3)
    }
    url.pathname = pathname || ''

    return url.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}
