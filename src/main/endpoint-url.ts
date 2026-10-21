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

/**
 * True only when the endpoint is on this machine or the local network: localhost, a `.local`
 * name, a loopback, private or link-local IPv4 address, or a loopback, unique-local or link-local
 * IPv6 address. Every other host, a bare single-label name and an unparseable value count as
 * hosted, so briefings to them carry resource totals only.
 */
export function isLocalEndpoint(raw: unknown): boolean {
  const normalized = normalizeEndpointUrl(raw)
  if (!normalized) return false
  const host = new URL(normalized).hostname.toLowerCase()

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/)
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])]
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    )
  }

  if (host.startsWith('[') && host.endsWith(']')) {
    const ipv6 = host.slice(1, -1)
    return ipv6 === '::1' || /^f[cd][0-9a-f]{2}:/.test(ipv6) || /^fe[89ab][0-9a-f]:/.test(ipv6)
  }

  return false
}

/**
 * The API key from LLM_API_KEY paired with the endpoint from LM_STUDIO_URL, or undefined.
 *
 * The key counts only when LM_STUDIO_URL is set and parses as a URL, because that pair is the user
 * naming both the endpoint and the key for it in one place. `url` is the normalized endpoint the
 * key may be sent to. The model client and the settings flag (hasApiKey) both use this one
 * function, so the UI never reports a key that the client would ignore. Never log the result.
 */
export function envKeyWithEndpoint(
  env: Record<string, string | undefined> = process.env
): { key: string; url: string } | undefined {
  const url = normalizeEndpointUrl(env.LM_STUDIO_URL)
  const providerKey = url === 'https://openrouter.ai/api' ? env.OPENROUTER_API_KEY
    : url === 'https://api.deepseek.com' ? env.DEEPSEEK_API_KEY : undefined
  const key = env.LLM_API_KEY?.trim() || providerKey?.trim()
  return key && url ? { key, url } : undefined
}
