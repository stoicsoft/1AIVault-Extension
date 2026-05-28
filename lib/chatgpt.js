// Pulls conversations from chatgpt.com via its internal API. Auth is a Bearer
// access token fetched from /api/auth/session (which the page's own JS uses).

import { getJson, sleep } from './net.js'
import { postConversations } from './vault.js'

const ORIGIN = 'https://chatgpt.com'

/**
 * @param {(e: object) => void} emit
 * @param {{ selectedIds?: Set<string> | null }} [opts]
 */
export async function syncChatGPT(emit = () => {}, opts = {}) {
  const selected = opts.selectedIds instanceof Set ? opts.selectedIds : null
  emit({ stage: 'start', service: 'chatgpt' })

  let session
  try {
    const r = await fetch(`${ORIGIN}/api/auth/session`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    if (!r.ok) {
      emit({ stage: 'done', service: 'chatgpt', signedIn: false })
      return { imported: 0, skipped: 0, signedIn: false }
    }
    session = await r.json()
  } catch {
    emit({ stage: 'done', service: 'chatgpt', signedIn: false })
    return { imported: 0, skipped: 0, signedIn: false }
  }
  if (!session || !session.accessToken) {
    emit({ stage: 'done', service: 'chatgpt', signedIn: false })
    return { imported: 0, skipped: 0, signedIn: false }
  }

  const headers = { Accept: 'application/json', Authorization: `Bearer ${session.accessToken}` }

  let list
  try {
    list = await getJson(
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
      full = await getJson(`${ORIGIN}/backend-api/conversation/${meta.id}`, { headers })
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
      createdAt: typeof meta.create_time === 'number' ? Math.floor(meta.create_time) : undefined,
      updatedAt: typeof meta.update_time === 'number' ? Math.floor(meta.update_time) : undefined,
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

function chunkBy(arr, n) {
  const out = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}
