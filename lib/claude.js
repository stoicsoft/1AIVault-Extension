// Pulls conversations from Claude.ai via its internal API. The service worker
// runs in the extension origin but credentials:'include' + host_permissions
// for claude.ai means cookies are sent — so the user's signed-in session is
// what authenticates these calls.

import { getJson } from './net.js'
import { getJsonViaClaudeTab, listAllConversationsViaClaudeTab } from './tab-fetch.js'
import { postConversations } from './vault.js'

const BASE = 'https://claude.ai/api'

/**
 * @param {(e: object) => void} emit
 * @param {{ selectedIds?: Set<string> | null }} [opts]
 *   selectedIds = null/undefined means "import every new/changed conversation".
 * @returns {Promise<{ imported: number, skipped: number, signedIn: boolean }>}
 */
export async function syncClaude(emit = () => {}, opts = {}) {
  const selected = opts.selectedIds instanceof Set ? opts.selectedIds : null
  emit({ stage: 'start', service: 'claude' })

  let orgs
  try {
    orgs = await getJson(`${BASE}/organizations`)
  } catch {
    emit({ stage: 'done', service: 'claude', signedIn: false })
    return { imported: 0, skipped: 0, signedIn: false }
  }
  if (!Array.isArray(orgs) || orgs.length === 0) {
    emit({ stage: 'done', service: 'claude', signedIn: false })
    return { imported: 0, skipped: 0, signedIn: false }
  }

  // Build project-name map and the work index. Conversations attached to a
  // project get a project:<name> tag downstream.
  const projectName = new Map() // project_uuid -> name
  const index = [] // { org, meta, projectUuid? }
  for (const org of orgs) {
    if (!org || !org.uuid) continue
    if (Array.isArray(org.capabilities) && org.capabilities.length > 0 && !org.capabilities.includes('chat')) continue
    if (org.api_disabled_reason) continue
    try {
      const projects = await getJson(
        `${BASE}/organizations/${org.uuid}/projects`
      )
      for (const p of projects || []) {
        if (p && p.uuid) projectName.set(p.uuid, p.name || '(unnamed project)')
      }
    } catch {}
    try {
      const list = await listAllConversationsViaClaudeTab(
        `${BASE}/organizations/${org.uuid}/chat_conversations`
      )
      for (const meta of list || []) {
        if (!meta || !meta.uuid) continue
        if (selected && !selected.has(meta.uuid)) continue
        const projectUuid = meta.project_uuid || (meta.project && meta.project.uuid) || null
        index.push({ org, meta, projectUuid })
      }
    } catch (err) {
      // 403 here means this specific org doesn't grant chat access to the
      // current session — skip it and keep going with the other orgs.
      if (err && err.status === 403) continue
      emit({
        stage: 'fatal',
        service: 'claude',
        error: `Could not list conversations for ${org.name || org.uuid}: ${err && err.message ? err.message : err}`,
      })
    }
  }
  emit({ stage: 'list', service: 'claude', total: index.length })

  const batch = []
  for (let i = 0; i < index.length; i++) {
    const { org, meta, projectUuid } = index[i]
    const cacheKey = `claude:${meta.uuid}`
    const cached = (await chrome.storage.local.get(cacheKey))[cacheKey]
    if (cached && cached === meta.updated_at) {
      emit({
        stage: 'item',
        service: 'claude',
        index: i + 1,
        total: index.length,
        title: meta.name || '(untitled)',
        outcome: 'cached',
      })
      continue
    }

    let full
    try {
      full = await getJsonViaClaudeTab(
        `${BASE}/organizations/${org.uuid}/chat_conversations/${meta.uuid}?rendering_mode=raw`
      )
    } catch (err) {
      emit({
        stage: 'item',
        service: 'claude',
        index: i + 1,
        total: index.length,
        title: meta.name || '(untitled)',
        outcome: 'error',
        error: err.message,
      })
      continue
    }

    const messages = extractMessages(full)
    if (messages.length === 0) {
      emit({
        stage: 'item',
        service: 'claude',
        index: i + 1,
        total: index.length,
        title: meta.name || '(untitled)',
        outcome: 'empty',
      })
      continue
    }

    const extraTags = []
    if (projectUuid && projectName.has(projectUuid)) {
      extraTags.push(`project:${projectName.get(projectUuid).toLowerCase()}`)
    }

    batch.push({
      externalId: meta.uuid,
      title: meta.name || null,
      createdAt: toEpochSec(meta.created_at),
      updatedAt: toEpochSec(meta.updated_at),
      messages,
      extraTags,
    })
    emit({
      stage: 'item',
      service: 'claude',
      index: i + 1,
      total: index.length,
      title: meta.name || '(untitled)',
      outcome: 'queued',
      messages: messages.length,
    })
    await chrome.storage.local.set({ [cacheKey]: meta.updated_at })
  }

  if (batch.length === 0) {
    emit({ stage: 'done', service: 'claude', imported: 0, skipped: 0, signedIn: true })
    return { imported: 0, skipped: 0, signedIn: true }
  }

  let imported = 0
  let skipped = 0
  let chunkIdx = 0
  const chunks = chunkBy(batch, 25)
  for (const chunk of chunks) {
    chunkIdx++
    emit({ stage: 'post', service: 'claude', chunk: chunkIdx, totalChunks: chunks.length, size: chunk.length })
    try {
      const r = await postConversations('claude_desktop', chunk)
      imported += r.imported || 0
      skipped += r.skipped || 0
    } catch (err) {
      emit({ stage: 'post-error', service: 'claude', error: err.message })
    }
  }
  emit({ stage: 'done', service: 'claude', imported, skipped, signedIn: true })
  return { imported, skipped, signedIn: true }
}

function extractMessages(full) {
  const raw = full && Array.isArray(full.chat_messages) ? full.chat_messages : []
  const out = []
  for (const m of raw) {
    const role = m.sender === 'human' ? 'user' : m.sender === 'assistant' ? 'assistant' : null
    if (!role) continue
    const text = collectText(m)
    if (text) out.push({ role, text })
  }
  return out
}

function collectText(m) {
  if (typeof m.text === 'string' && m.text.trim().length > 0) return m.text.trim()
  if (Array.isArray(m.content)) {
    const parts = []
    for (const c of m.content) {
      if (c && typeof c.text === 'string') parts.push(c.text)
    }
    return parts.join('\n').trim() || null
  }
  return null
}

function toEpochSec(iso) {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? Math.floor(t / 1000) : undefined
}

function chunkBy(arr, n) {
  const out = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}
