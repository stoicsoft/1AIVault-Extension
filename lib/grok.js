// Pulls conversations from grok.com via its same-origin REST API.
// Auth is the signed-in grok.com session (SSO cookies). Every request runs
// inside a real grok.com tab — direct service-worker fetches are blocked the
// same way claude.ai / chatgpt.com are.
//
// Surface (as of 2026):
//   GET  /rest/app-chat/conversations?pageSize=&pageToken=
//   GET  /rest/app-chat/conversations_v2/<id>
//   GET  /rest/app-chat/conversations/<id>/response-node
//   POST /rest/app-chat/conversations/<id>/load-responses  { responseIds }

import { sleep } from './net.js'
import { withServiceTab } from './tab-fetch.js'
import { getVaultStatuses, postConversations } from './vault.js'

const ORIGIN = 'https://grok.com'
const SOURCE = 'grok_web'
const PAGE_SIZE = 100
const MAX_PAGES = 50

/**
 * @param {(e: object) => void} emit
 * @param {{ selectedIds?: Set<string> | null, allowOpenTab?: boolean }} [opts]
 *   allowOpenTab=false → never spawn a hidden grok.com tab; if none is open,
 *   the sync silently aborts. Used by the auto-sync alarm so background runs
 *   don't pop windows behind the user.
 */
export async function syncGrok(emit = () => {}, opts = {}) {
  const selected = opts.selectedIds instanceof Set ? opts.selectedIds : null
  const allowOpenTab = opts.allowOpenTab !== false
  emit({ stage: 'start', service: 'grok' })

  try {
    return await withServiceTab('grok', { allowOpenTab }, (fetchJson) =>
      syncViaTab(fetchJson, emit, selected)
    )
  } catch (err) {
    if (err && err.code === 'NO_TAB') {
      emit({
        stage: 'done',
        service: 'grok',
        skipped: true,
        reason: 'no grok.com tab open',
        imported: 0,
        signedIn: true,
      })
      return { imported: 0, skipped: 0, signedIn: true, passiveSkipped: true }
    }
    if (err && (err.status === 401 || err.status === 403)) {
      emit({ stage: 'done', service: 'grok', signedIn: false })
      return { imported: 0, skipped: 0, signedIn: false }
    }
    throw err
  }
}

async function syncViaTab(fetchJson, emit, selected) {
  let items
  try {
    items = await listGrokConversations(fetchJson)
  } catch (err) {
    if (err && (err.status === 401 || err.status === 403)) {
      emit({ stage: 'done', service: 'grok', signedIn: false })
      return { imported: 0, skipped: 0, signedIn: false }
    }
    emit({ stage: 'done', service: 'grok', signedIn: true, error: err.message })
    return { imported: 0, skipped: 0, signedIn: true, error: err.message }
  }

  const index = items.filter((m) => m && m.id && (!selected || selected.has(m.id)))
  emit({ stage: 'list', service: 'grok', total: index.length })

  // The desktop vault is the source of truth for what has already been
  // imported; the local markers are only a fast path that saves a transcript
  // fetch. An empty map means we could not ask (unpaired / vault offline /
  // older desktop build) — in that case the markers are not trustworthy
  // either, so re-send and let the POST surface the real failure rather than
  // reporting every conversation as "up to date".
  const vaultStatuses = await getVaultStatuses(SOURCE, index.map((m) => m.id))
  const vaultAnswered = Object.keys(vaultStatuses).length > 0
  if (!vaultAnswered && index.length > 0) {
    emit({ stage: 'vault-unreachable', service: 'grok', total: index.length })
  }

  const batch = []
  for (let i = 0; i < index.length; i++) {
    const meta = index[i]
    const cacheKey = `grok:${meta.id}`
    const cached = (await chrome.storage.local.get(cacheKey))[cacheKey]
    const status = vaultStatuses[meta.id]
    const inVault = vaultAnswered && !!status && status.inVault === true
    if (inVault && cached != null && meta.updatedAt != null && cached === meta.updatedAt) {
      emit({
        stage: 'item',
        service: 'grok',
        index: i + 1,
        total: index.length,
        title: meta.title || '(untitled)',
        outcome: 'cached',
      })
      continue
    }

    let extracted
    try {
      await sleep(200)
      extracted = await fetchTranscript(fetchJson, meta.id)
    } catch (err) {
      emit({
        stage: 'item',
        service: 'grok',
        index: i + 1,
        total: index.length,
        title: meta.title || '(untitled)',
        outcome: 'error',
        error: err.message,
      })
      continue
    }

    const messages = extracted.messages
    if (messages.length === 0) {
      emit({
        stage: 'item',
        service: 'grok',
        index: i + 1,
        total: index.length,
        title: meta.title || '(untitled)',
        outcome: 'empty',
      })
      continue
    }

    const title = extracted.title || meta.title || null
    const createdAt = extracted.createdAt ?? meta.createdAt
    const updatedAt = extracted.updatedAt ?? meta.updatedAt
    batch.push({
      externalId: meta.id,
      title,
      createdAt,
      updatedAt,
      messages,
    })
    emit({
      stage: 'item',
      service: 'grok',
      index: i + 1,
      total: index.length,
      title: title || '(untitled)',
      outcome: 'queued',
      messages: messages.length,
    })
  }

  if (batch.length === 0) {
    emit({ stage: 'done', service: 'grok', imported: 0, skipped: 0, signedIn: true })
    return { imported: 0, skipped: 0, signedIn: true }
  }

  let imported = 0
  let skipped = 0
  let chunkIdx = 0
  const chunks = chunkBy(batch, 25)
  for (const chunk of chunks) {
    chunkIdx++
    emit({
      stage: 'post',
      service: 'grok',
      chunk: chunkIdx,
      totalChunks: chunks.length,
      size: chunk.length,
    })
    try {
      const r = await postConversations(SOURCE, chunk)
      imported += r.imported || 0
      skipped += r.skipped || 0
      // Only now is the vault known to hold these. Marking them earlier is
      // what stranded conversations permanently: a failed POST left "already
      // synced" markers behind and every later run skipped them.
      await rememberSynced(chunk)
    } catch (err) {
      emit({ stage: 'post-error', service: 'grok', error: err.message })
    }
    if (chunkIdx < chunks.length) await sleep(150)
  }
  emit({ stage: 'done', service: 'grok', imported, skipped, signedIn: true })
  return { imported, skipped, signedIn: true }
}

/**
 * Paginated conversation list. Returns normalized summaries the picker and
 * the sync loop both consume.
 *
 * @param {(url: string, opts?: object) => Promise<any>} fetchJson
 * @returns {Promise<Array<{ id: string, title: string, createdAt: number|null, updatedAt: number|null }>>}
 */
export async function listGrokConversations(fetchJson) {
  const seen = new Set()
  const seenTokens = new Set()
  const all = []
  let pageToken = null
  for (let page = 0; page < MAX_PAGES; page++) {
    let url = `${ORIGIN}/rest/app-chat/conversations?pageSize=${PAGE_SIZE}`
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`
    const payload = await fetchJson(url)
    const records = extractListRecords(payload)
    let added = 0
    for (const rec of records) {
      const id = convId(rec)
      if (!id || seen.has(id)) continue
      seen.add(id)
      all.push({
        id,
        title: str(rec.title) || str(rec.name) || '(untitled)',
        createdAt: pickTime(rec, CREATE_KEYS),
        updatedAt: pickTime(rec, UPDATE_KEYS) ?? pickTime(rec, CREATE_KEYS),
      })
      added++
    }
    const next = str(payload && (payload.nextPageToken || payload.next_page_token))
    if (!next || added === 0 || seenTokens.has(next)) break
    seenTokens.add(next)
    pageToken = next
  }
  return all
}

async function fetchTranscript(fetchJson, id) {
  const encoded = encodeURIComponent(id)
  let detail = null
  try {
    const v2 = await fetchJson(`${ORIGIN}/rest/app-chat/conversations_v2/${encoded}`)
    detail = isRecord(v2) && isRecord(v2.conversation) ? v2.conversation : v2
  } catch {
    detail = null
  }

  const nodePayload = await fetchJson(
    `${ORIGIN}/rest/app-chat/conversations/${encoded}/response-node`
  )
  const responseIds = uniqueStrings(
    extractNodes(nodePayload).map((n) => str(n.responseId) || str(n.response_id) || str(n.id))
  )

  const messagesPayload = await fetchJson(
    `${ORIGIN}/rest/app-chat/conversations/${encoded}/load-responses`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(responseIds.length > 0 ? { responseIds } : {}),
    }
  )
  const responses = extractResponses(messagesPayload)
  const byId = new Map()
  for (const rec of responses) {
    const rid = str(rec.responseId) || str(rec.response_id) || str(rec.id)
    if (rid) byId.set(rid, rec)
  }

  const ordered = responseIds.length > 0
    ? responseIds.map((rid) => byId.get(rid)).filter(Boolean)
    : responses

  const messages = []
  for (const rec of ordered) {
    const role = responseRole(rec.sender || rec.role)
    const text = extractText(rec)
    if (!role || !text) continue
    messages.push({ role, text })
  }

  return {
    title: (detail && (str(detail.title) || str(detail.name))) || null,
    createdAt: detail ? pickTime(detail, CREATE_KEYS) : null,
    updatedAt: detail ? pickTime(detail, UPDATE_KEYS) ?? pickTime(detail, CREATE_KEYS) : null,
    messages,
  }
}

const CREATE_KEYS = ['createTime', 'createdAt', 'created_at', 'create_time']
const UPDATE_KEYS = [
  'modifyTime',
  'modifiedTime',
  'updateTime',
  'updatedAt',
  'updated_at',
  'update_time',
  'lastUpdateTime',
  'systemPromptTime',
]

function extractListRecords(payload) {
  if (Array.isArray(payload)) return payload.filter(isRecord)
  if (!isRecord(payload)) return []
  for (const key of ['conversations', 'items', 'results', 'data']) {
    if (Array.isArray(payload[key])) return payload[key].filter(isRecord)
  }
  // Envelope has changed before — accept any top-level array of records
  // that look like conversations (have an id).
  const out = []
  for (const value of Object.values(payload)) {
    if (!Array.isArray(value)) continue
    for (const item of value) {
      if (isRecord(item) && convId(item)) out.push(item)
    }
    if (out.length > 0) return out
  }
  return []
}

function extractNodes(payload) {
  if (Array.isArray(payload)) return payload.filter(isRecord)
  if (!isRecord(payload)) return []
  for (const key of ['responseNodes', 'nodes', 'responses', 'items']) {
    if (Array.isArray(payload[key])) return payload[key].filter(isRecord)
  }
  return []
}

function extractResponses(payload) {
  if (Array.isArray(payload)) return payload.filter(isRecord)
  if (!isRecord(payload)) return []
  if (Array.isArray(payload.responses)) return payload.responses.filter(isRecord)
  if (Array.isArray(payload.items)) return payload.items.filter(isRecord)
  return []
}

function convId(rec) {
  return str(rec.conversationId) || str(rec.conversation_id) || str(rec.id)
}

function responseRole(sender) {
  const n = typeof sender === 'string' ? sender.trim().toLowerCase() : ''
  if (n === 'human' || n === 'user') return 'user'
  if (n === 'assistant' || n === 'bot' || n === 'grok' || n === 'ai' || n === 'model') {
    return 'assistant'
  }
  return null
}

function extractText(rec) {
  if (!rec) return null
  const candidates = [rec.message, rec.text, rec.content, rec.markdown]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return stripArtifacts(c)
    if (isRecord(c) && typeof c.text === 'string' && c.text.trim()) return stripArtifacts(c.text)
  }
  return null
}

function stripArtifacts(text) {
  return String(text)
    .replace(/<grok:render\b[^>]*>[\s\S]*?<\/grok:render>/gi, '')
    .replace(/<grok:render\b[^>]*\/?\s*>/gi, '')
    .replace(/&lt;grok:render\b[\s\S]*?&gt;[\s\S]*?&lt;\/grok:render&gt;/gi, '')
    .trim()
}

function pickTime(rec, keys) {
  if (!rec) return null
  for (const k of keys) {
    const t = toEpochSec(rec[k])
    if (t != null) return t
  }
  return null
}

function toEpochSec(v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v > 10_000_000_000 ? Math.floor(v / 1000) : Math.floor(v)
  }
  if (typeof v === 'string' && v.trim()) {
    const numeric = Number(v)
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric > 10_000_000_000 ? Math.floor(numeric / 1000) : Math.floor(numeric)
    }
    const t = Date.parse(v)
    return Number.isFinite(t) ? Math.floor(t / 1000) : null
  }
  return null
}

function str(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function isRecord(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function uniqueStrings(arr) {
  const seen = new Set()
  const out = []
  for (const v of arr) {
    if (!v || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

/** Persist the per-conversation dedup markers for a chunk the vault accepted. */
async function rememberSynced(chunk) {
  const marks = {}
  for (const conv of chunk) {
    if (conv.updatedAt != null) marks[`grok:${conv.externalId}`] = conv.updatedAt
  }
  if (Object.keys(marks).length > 0) await chrome.storage.local.set(marks)
}

function chunkBy(arr, n) {
  const out = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}
