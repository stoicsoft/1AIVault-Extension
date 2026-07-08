// Pulls conversations from chatgpt.com via its internal API. Auth is a Bearer
// access token fetched from /api/auth/session (which the page's own JS uses).
// All requests run inside a real chatgpt.com tab — direct service-worker
// fetches are blocked by Cloudflare / CORS (same story as claude.ai).

import { sleep } from './net.js'
import { withServiceTab } from './tab-fetch.js'
import { postConversations } from './vault.js'

const ORIGIN = 'https://chatgpt.com'

/**
 * @param {(e: object) => void} emit
 * @param {{ selectedIds?: Set<string> | null, allowOpenTab?: boolean }} [opts]
 *   allowOpenTab=false → never spawn a hidden chatgpt.com tab; if none is
 *   open, the sync silently aborts. Used by the auto-sync alarm so background
 *   runs don't pop windows behind the user.
 */
export async function syncChatGPT(emit = () => {}, opts = {}) {
  const selected = opts.selectedIds instanceof Set ? opts.selectedIds : null
  const allowOpenTab = opts.allowOpenTab !== false
  emit({ stage: 'start', service: 'chatgpt' })

  try {
    return await withServiceTab('chatgpt', { allowOpenTab }, (fetchJson) =>
      syncViaTab(fetchJson, emit, selected)
    )
  } catch (err) {
    if (err && err.code === 'NO_TAB') {
      // Passive (alarm) run with no chatgpt.com tab open — abort cleanly.
      emit({ stage: 'done', service: 'chatgpt', skipped: true, reason: 'no chatgpt.com tab open', imported: 0, signedIn: true })
      return { imported: 0, skipped: 0, signedIn: true, passiveSkipped: true }
    }
    if (err && err.status === 401) {
      emit({ stage: 'done', service: 'chatgpt', signedIn: false })
      return { imported: 0, skipped: 0, signedIn: false }
    }
    // Anything else (tab load timeout, inject failure, …) is a real fault —
    // let the caller surface it as a fatal event instead of masking it as
    // "not signed in" the way the old direct-fetch path did.
    throw err
  }
}

async function syncViaTab(fetchJson, emit, selected) {
  let session
  try {
    session = await fetchJson(`${ORIGIN}/api/auth/session`)
  } catch {
    emit({ stage: 'done', service: 'chatgpt', signedIn: false })
    return { imported: 0, skipped: 0, signedIn: false }
  }
  if (!session || !session.accessToken) {
    emit({ stage: 'done', service: 'chatgpt', signedIn: false })
    return { imported: 0, skipped: 0, signedIn: false }
  }

  const headers = { Authorization: `Bearer ${session.accessToken}` }

  let list
  try {
    list = await fetchJson(
      `${ORIGIN}/backend-api/conversations?offset=0&limit=100&order=updated`,
      { headers }
    )
  } catch (err) {
    emit({ stage: 'done', service: 'chatgpt', signedIn: true, error: err.message })
    return { imported: 0, skipped: 0, signedIn: true, error: err.message }
  }

  const items = (Array.isArray(list && list.items) ? list.items : []).filter(
    (m) => m && m.id && (!selected || selected.has(m.id))
  )
  emit({ stage: 'list', service: 'chatgpt', total: items.length })

  const batch = []
  for (let i = 0; i < items.length; i++) {
    const meta = items[i]
    const cacheKey = `chatgpt:${meta.id}`
    const cached = (await chrome.storage.local.get(cacheKey))[cacheKey]
    if (cached && cached === meta.update_time) {
      emit({
        stage: 'item',
        service: 'chatgpt',
        index: i + 1,
        total: items.length,
        title: meta.title || '(untitled)',
        outcome: 'cached',
      })
      continue
    }

    let full
    try {
      // Light pacing so we look like a fast human rather than a scraper.
      await sleep(200)
      full = await fetchJson(`${ORIGIN}/backend-api/conversation/${meta.id}`, { headers })
    } catch (err) {
      emit({
        stage: 'item',
        service: 'chatgpt',
        index: i + 1,
        total: items.length,
        title: meta.title || '(untitled)',
        outcome: 'error',
        error: err.message,
      })
      continue
    }

    const messages = extractMessages(full)
    if (messages.length === 0) {
      emit({
        stage: 'item',
        service: 'chatgpt',
        index: i + 1,
        total: items.length,
        title: meta.title || '(untitled)',
        outcome: 'empty',
      })
      continue
    }

    batch.push({
      externalId: meta.id,
      title: meta.title || null,
      createdAt: toEpochSec(meta.create_time),
      updatedAt: toEpochSec(meta.update_time),
      messages,
    })
    emit({
      stage: 'item',
      service: 'chatgpt',
      index: i + 1,
      total: items.length,
      title: meta.title || '(untitled)',
      outcome: 'queued',
      messages: messages.length,
    })
    await chrome.storage.local.set({ [cacheKey]: meta.update_time })
  }

  if (batch.length === 0) {
    emit({ stage: 'done', service: 'chatgpt', imported: 0, skipped: 0, signedIn: true })
    return { imported: 0, skipped: 0, signedIn: true }
  }

  let imported = 0
  let skipped = 0
  let chunkIdx = 0
  const chunks = chunkBy(batch, 25)
  for (const chunk of chunks) {
    chunkIdx++
    emit({ stage: 'post', service: 'chatgpt', chunk: chunkIdx, totalChunks: chunks.length, size: chunk.length })
    try {
      const r = await postConversations('chatgpt', chunk)
      imported += r.imported || 0
      skipped += r.skipped || 0
    } catch (err) {
      emit({ stage: 'post-error', service: 'chatgpt', error: err.message })
    }
    if (chunkIdx < chunks.length) await sleep(150)
  }
  emit({ stage: 'done', service: 'chatgpt', imported, skipped, signedIn: true })
  return { imported, skipped, signedIn: true }
}

function extractMessages(full) {
  if (!full || !full.mapping || !full.current_node) return []
  const chain = []
  let id = full.current_node
  const seen = new Set()
  while (id && !seen.has(id) && full.mapping[id]) {
    seen.add(id)
    chain.unshift(full.mapping[id])
    id = full.mapping[id].parent
  }
  const out = []
  for (const node of chain) {
    const m = node.message
    if (!m || !m.author || !m.author.role) continue
    if (m.author.role === 'system') continue
    const parts = m.content && Array.isArray(m.content.parts) ? m.content.parts : []
    const text = parts
      .filter((p) => typeof p === 'string')
      .join('\n')
      .trim()
    if (!text) continue
    out.push({ role: m.author.role === 'assistant' ? 'assistant' : 'user', text })
  }
  return out
}

// The conversations list endpoint returns ISO-8601 strings for
// create_time/update_time while the per-conversation endpoint returns epoch
// seconds — accept both.
function toEpochSec(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v)
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(t) ? Math.floor(t / 1000) : undefined
}

function chunkBy(arr, n) {
  const out = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}
