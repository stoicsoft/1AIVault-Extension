// Some claude.ai endpoints (notably /chat_conversations) return 403 when fetched
// directly from the service worker — they appear to be guarded by Cloudflare /
// anti-bot checks that look at headers the browser only attaches to requests
// originating from a real page. We work around it by running the fetch inside
// an actual claude.ai tab via chrome.scripting.executeScript: the browser then
// attaches every real header (UA-CH, Sec-Fetch-*, fingerprint cookies, etc.).

const CLAUDE_TAB_QUERY = ['https://claude.ai/*', 'https://*.claude.ai/*']

function isUsableClaudeUrl(url) {
  if (!url) return false
  try {
    const u = new URL(url)
    if (!/(^|\.)claude\.ai$/.test(u.hostname)) return false
    // Auth / login / sign-in flows live under these paths and don't have an
    // active session for /api/* — skip them.
    if (/^\/(login|signin|auth|logout)/i.test(u.pathname)) return false
    return true
  } catch {
    return false
  }
}

async function findClaudeTab() {
  const tabs = await chrome.tabs.query({ url: CLAUDE_TAB_QUERY })
  for (const t of tabs) {
    if (isUsableClaudeUrl(t.url) && t.status === 'complete') return t
  }
  for (const t of tabs) {
    if (isUsableClaudeUrl(t.url)) return t
  }
  return null
}

function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let done = false
    const finish = (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      chrome.tabs.onUpdated.removeListener(listener)
      if (err) reject(err)
      else resolve()
    }
    const timer = setTimeout(() => finish(new Error('tab load timeout')), timeoutMs)
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish()
    }
    chrome.tabs.onUpdated.addListener(listener)
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab && tab.status === 'complete') finish()
      })
      .catch(() => {})
  })
}

async function ensureClaudeTab(opts = {}) {
  const allowOpenTab = opts.allowOpenTab !== false
  const existing = await findClaudeTab()
  if (existing) return { tab: existing, created: false }
  if (!allowOpenTab) {
    // Caller (typically the auto-sync alarm) asked us to stay passive: never
    // pop a claude.ai tab without an explicit user action. Surface a typed
    // error so the sync layer can mark itself "skipped" cleanly.
    const err = new Error('no claude.ai tab open — passive sync skipped')
    err.code = 'NO_TAB'
    throw err
  }
  const tab = await chrome.tabs.create({ url: 'https://claude.ai/new', active: false })
  await waitForTabComplete(tab.id)
  // claude.ai sets a few cookies async after first paint — give it a beat.
  await new Promise((r) => setTimeout(r, 1500))
  // Re-fetch tab in case it redirected (e.g. to login).
  const refreshed = await chrome.tabs.get(tab.id).catch(() => null)
  if (refreshed && !isUsableClaudeUrl(refreshed.url)) {
    try { await chrome.tabs.remove(tab.id) } catch {}
    const err = new Error('not signed in to claude.ai')
    err.status = 401
    throw err
  }
  return { tab: refreshed || tab, created: true }
}

/**
 * Walks `?limit=…&offset=…` pages until the server runs out of new items.
 * Safe if the endpoint ignores `offset` (returns the same first page every
 * time): we dedupe by `uuid` and stop as soon as a page yields zero new rows.
 *
 * `opts.allowOpenTab` (default true) — when false, the helper will refuse to
 * spawn a hidden claude.ai tab if none is already open (used by the alarm
 * path so background syncs don't pop windows behind the user's back).
 */
export async function listAllConversationsViaClaudeTab(baseUrl, opts = {}, pageSize = 200, hardCap = 5000) {
  const seen = new Set()
  const all = []
  const sep = baseUrl.includes('?') ? '&' : '?'
  for (let offset = 0; offset < hardCap; offset += pageSize) {
    let batch
    try {
      batch = await getJsonViaClaudeTab(`${baseUrl}${sep}limit=${pageSize}&offset=${offset}`, opts)
    } catch (err) {
      if (offset === 0) throw err
      // Partial success — keep what we have rather than failing the sync.
      break
    }
    if (!Array.isArray(batch) || batch.length === 0) break
    let added = 0
    for (const item of batch) {
      if (!item || !item.uuid || seen.has(item.uuid)) continue
      seen.add(item.uuid)
      all.push(item)
      added++
    }
    // Stop if the page brought nothing new (offset unsupported) or was a
    // partial final page.
    if (added === 0 || batch.length < pageSize) break
  }
  return all
}

/**
 * GET JSON from a real claude.ai tab. Throws Error with `.status` on non-2xx.
 *
 * `opts.allowOpenTab` (default true) — see listAllConversationsViaClaudeTab.
 */
export async function getJsonViaClaudeTab(url, opts = {}) {
  const { tab, created } = await ensureClaudeTab(opts)
  try {
    let results
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: async (u) => {
          try {
            const r = await fetch(u, {
              credentials: 'include',
              headers: { Accept: 'application/json, text/plain, */*' },
            })
            const text = await r.text()
            // Surface a hint in the page console so the user can confirm the
            // fetch ran from the right context.
            try { console.debug('[1AIVault] tab-fetch', u, '→', r.status) } catch {}
            return { ok: r.ok, status: r.status, text }
          } catch (e) {
            return { ok: false, status: 0, error: String((e && e.message) || e) }
          }
        },
        args: [url],
      })
    } catch (e) {
      throw new Error(`tab inject failed: ${(e && e.message) || e}`)
    }
    const result = results && results[0] && results[0].result
    if (!result) throw new Error('tab fetch returned no result')
    if (result.error) throw new Error(result.error)
    if (!result.ok) {
      const err = new Error(`${url}: ${result.status}`)
      err.status = result.status
      err.bodySnippet = (result.text || '').slice(0, 200)
      throw err
    }
    try {
      return JSON.parse(result.text)
    } catch {
      throw new Error(`invalid JSON from ${url}`)
    }
  } finally {
    if (created) {
      try {
        await chrome.tabs.remove(tab.id)
      } catch {}
    }
  }
}
