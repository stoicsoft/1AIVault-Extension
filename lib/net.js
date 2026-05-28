// Shared HTTP helpers. Sequential, paced, and 429/503-aware so we look like a
// fast human rather than a scraper.

const MIN_GAP_MS = 200

let nextAllowedAt = 0

async function pace() {
  const now = Date.now()
  if (now < nextAllowedAt) {
    await sleep(nextAllowedAt - now)
  }
  nextAllowedAt = Date.now() + MIN_GAP_MS
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** GET JSON with pacing + one retry on 429/503 honoring Retry-After. */
export async function getJson(url, opts = {}) {
  await pace()
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    ...(opts.headers || {}),
  }
  let res = await fetch(url, { credentials: 'include', ...opts, headers })
  if ((res.status === 429 || res.status === 503) && !opts._retried) {
    const retryAfter = parseInt(res.headers.get('Retry-After') || '5', 10)
    await sleep(Math.min(Math.max(retryAfter * 1000, 1000), 30000))
    return getJson(url, { ...opts, _retried: true })
  }
  if (!res.ok) {
    const err = new Error(`${url}: ${res.status}`)
    err.status = res.status
    throw err
  }
  return res.json()
}
