// Some claude.ai endpoints (notably /chat_conversations) and every chatgpt.com
// endpoint return 403 / CORS blocks when fetched directly from the service
// worker — they're guarded by Cloudflare / anti-bot checks that look at headers
// the browser only attaches to requests originating from a real page. We work
// around it by running the fetch inside an actual tab on the target site via
// chrome.scripting.executeScript: the browser then attaches every real header
// (UA-CH, Sec-Fetch-*, fingerprint cookies, etc.).

const SERVICES = {
  claude: {
    label: 'claude.ai',
    tabQuery: ['https://claude.ai/*', 'https://*.claude.ai/*'],
    hostPattern: /(^|\.)claude\.ai$/,
    // Auth / login / sign-in flows live under these paths and don't have an
    // active session for /api/* — skip them.
    blockedPaths: /^\/(login|signin|auth|logout)/i,
    newTabUrl: 'https://claude.ai/new',
  },
  chatgpt: {
    label: 'chatgpt.com',
    tabQuery: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
    hostPattern: /(^|\.)(chatgpt\.com|chat\.openai\.com)$/,
    blockedPaths: /^\/auth/i,
    newTabUrl: 'https://chatgpt.com/',
  },
}

function isUsableUrl(svc, url) {
  if (!url) return false
  try {
    const u = new URL(url)
    if (!svc.hostPattern.test(u.hostname)) return false
    if (svc.blockedPaths.test(u.pathname)) return false
    return true
  } catch {
    return false
  }
}

async function findTab(svc) {
  const tabs = await chrome.tabs.query({ url: svc.tabQuery })
  for (const t of tabs) {
    if (isUsableUrl(svc, t.url) && t.status === 'complete') return t
  }
  for (const t of tabs) {
    if (isUsableUrl(svc, t.url)) return t
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

async function ensureTab(svc, opts = {}) {
  const allowOpenTab = opts.allowOpenTab !== false
  const existing = await findTab(svc)
  if (existing) return { tab: existing, created: false }
  if (!allowOpenTab) {
    // Caller (typically the auto-sync alarm) asked us to stay passive: never
    // pop a tab without an explicit user action. Surface a typed error so the
    // sync layer can mark itself "skipped" cleanly.
    const err = new Error(`no ${svc.label} tab open — passive sync skipped`)
    err.code = 'NO_TAB'
    throw err
  }
  const tab = await chrome.tabs.create({ url: svc.newTabUrl, active: false })
  await waitForTabComplete(tab.id)
  // Both sites set a few cookies async after first paint — give it a beat.
  await new Promise((r) => setTimeout(r, 1500))
  // Re-fetch tab in case it redirected (e.g. to login).
  const refreshed = await chrome.tabs.get(tab.id).catch(() => null)
  if (refreshed && !isUsableUrl(svc, refreshed.url)) {
    try { await chrome.tabs.remove(tab.id) } catch {}
    const err = new Error(`not signed in to ${svc.label}`)
    err.status = 401
    throw err
  }
  return { tab: refreshed || tab, created: true }
}

async function fetchJsonInTab(tab, url, fetchOpts = {}) {
  let results
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: async (u, opts) => {
        try {
          const init = {
            credentials: 'include',
            headers: { Accept: 'application/json, text/plain, */*', ...(opts.headers || {}) },
          }
          // method/body are only present for POST-style RPCs (e.g. Claude
          // Design's Connect endpoints). Absent for the common GET path.
          if (opts.method) init.method = opts.method
          if (opts.body != null) init.body = opts.body
          const r = await fetch(u, init)
          const text = await r.text()
          // Surface a hint in the page console so the user can confirm the
          // fetch ran from the right context.
          try { console.debug('[1AIVault] tab-fetch', opts.method || 'GET', u, '→', r.status) } catch {}
          return { ok: r.ok, status: r.status, text }
        } catch (e) {
          return { ok: false, status: 0, error: String((e && e.message) || e) }
        }
      },
      args: [url, { method: fetchOpts.method, headers: fetchOpts.headers || {}, body: fetchOpts.body }],
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
}

/**
 * Run `fn` with a JSON fetcher bound to a single tab on the service's site,
 * so multi-request flows (session → list → each conversation) reuse one tab
 * instead of opening and closing one per request. The fetcher is
 * `(url, { headers? }) => Promise<json>` and throws Error with `.status` on
 * non-2xx.
 *
 * `opts.allowOpenTab` (default true) — when false, refuse to spawn a hidden
 * tab if none is already open (used by the alarm path so background syncs
 * don't pop windows behind the user's back); throws Error with
 * `.code === 'NO_TAB'`.
 */
export async function withServiceTab(service, opts, fn) {
  const svc = SERVICES[service]
  if (!svc) throw new Error(`unknown tab-fetch service: ${service}`)
  const { tab, created } = await ensureTab(svc, opts)
  try {
    return await fn((url, fetchOpts = {}) => fetchJsonInTab(tab, url, fetchOpts))
  } finally {
    if (created) {
      try {
        await chrome.tabs.remove(tab.id)
      } catch {}
    }
  }
}

/** One-shot GET/POST JSON from a real tab on the service's site. */
export async function getJsonViaTab(service, url, opts = {}) {
  return withServiceTab(service, opts, (fetchJson) =>
    fetchJson(url, { method: opts.method, headers: opts.headers, body: opts.body })
  )
}

/** GET JSON from a real claude.ai tab. Throws Error with `.status` on non-2xx. */
export async function getJsonViaClaudeTab(url, opts = {}) {
  return getJsonViaTab('claude', url, opts)
}

/**
 * POST JSON to a real claude.ai tab and parse the JSON reply. Used for the
 * Claude Design Connect-RPC endpoints (`/design/…/OmeletteService/*`), which
 * are POST-only and share claude.ai's origin/Cloudflare guard — so they must
 * run inside a claude.ai tab exactly like the chat endpoints.
 */
export async function postJsonViaClaudeTab(url, body, opts = {}) {
  return getJsonViaTab('claude', url, {
    ...opts,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body || {}),
  })
}

/**
 * Walks `?limit=…&offset=…` pages until the server runs out of new items.
 * Safe if the endpoint ignores `offset` (returns the same first page every
 * time): we dedupe by `uuid` and stop as soon as a page yields zero new rows.
 *
 * `opts.allowOpenTab` (default true) — see withServiceTab.
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
