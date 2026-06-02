// Lightweight metadata discovery — used by the selection screen so the user
// can pick projects / conversations *before* we hit the per-conversation
// endpoints. No full-transcript fetches happen here.

import { getJson } from './net.js'
import { getJsonViaClaudeTab, listAllConversationsViaClaudeTab } from './tab-fetch.js'
import { getVaultStatuses } from './vault.js'

const CLAUDE_BASE = 'https://claude.ai/api'
const CHATGPT_ORIGIN = 'https://chatgpt.com'

/** @typedef {{
 *   id: string,
 *   title: string,
 *   updatedAt: number | null,
 *   cached: boolean
 * }} ConvSummary */

/** @typedef {{
 *   uuid: string,
 *   name: string,
 *   conversations: ConvSummary[]
 * }} ProjectSummary */

/** @typedef {{
 *   uuid: string,
 *   name: string,
 *   projects: ProjectSummary[],
 *   unfiled: ConvSummary[]
 * }} OrgSummary */

/** @returns {Promise<{ signedIn: boolean, orgs: OrgSummary[], error?: string }>} */
export async function discoverClaude() {
  let orgs
  try {
    orgs = await getJson(`${CLAUDE_BASE}/organizations`)
  } catch (err) {
    return { signedIn: false, orgs: [] }
  }
  if (!Array.isArray(orgs) || orgs.length === 0) {
    return { signedIn: false, orgs: [] }
  }

  const out = []
  const skipped = [] // orgs we couldn't list, kept for diagnostics
  for (const org of orgs) {
    if (!org || !org.uuid) continue
    if (orgLooksUnusable(org)) {
      skipped.push({ name: org.name || org.uuid, reason: 'no chat capability' })
      continue
    }
    const orgSummary = { uuid: org.uuid, name: org.name || 'Personal', projects: [], unfiled: [] }

    // Projects (best-effort — some org tiers don't have this endpoint).
    let projects = []
    try {
      const arr = await getJson(
        `${CLAUDE_BASE}/organizations/${org.uuid}/projects`
      )
      if (Array.isArray(arr)) projects = arr
    } catch {
      projects = []
    }
    const projectsByUuid = new Map()
    for (const p of projects) {
      if (!p || !p.uuid) continue
      projectsByUuid.set(p.uuid, {
        uuid: p.uuid,
        name: p.name || '(unnamed project)',
        conversations: [],
      })
    }

    // Conversations — fetched via a real claude.ai tab so Anthropic's
    // anti-bot guard accepts the request (direct service-worker fetches
    // started returning 403 on this endpoint). Paginated so we get more
    // than the first page.
    let conversations = []
    try {
      conversations = await listAllConversationsViaClaudeTab(
        `${CLAUDE_BASE}/organizations/${org.uuid}/chat_conversations`
      )
    } catch (err) {
      if (err && err.status === 401) {
        return { signedIn: false, orgs: [] }
      }
      if (err && err.status === 403) {
        // Common case: user is listed on the org but doesn't currently have
        // permission to read its chats (left org, team seat revoked, multi-
        // account session pointing at a different org, etc). Skip this org
        // and keep scanning the others rather than failing the whole sync.
        skipped.push({ name: org.name || org.uuid, reason: parsePermissionReason(err.bodySnippet) })
        continue
      }
      skipped.push({ name: org.name || org.uuid, reason: err.message })
      continue
    }

    for (const meta of conversations || []) {
      if (!meta || !meta.uuid) continue
      const summary = {
        id: meta.uuid,
        title: meta.name || '(untitled)',
        updatedAt: toEpochSec(meta.updated_at),
        // vaultStatus is filled in below once we ask the desktop vault.
        // Default to absent so the UI is correct when the vault is offline.
        vaultStatus: 'absent',
        cached: false,
      }
      const projUuid = meta.project_uuid || (meta.project && meta.project.uuid)
      if (projUuid && projectsByUuid.has(projUuid)) {
        projectsByUuid.get(projUuid).conversations.push(summary)
      } else {
        orgSummary.unfiled.push(summary)
      }
    }
    orgSummary.projects = [...projectsByUuid.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
    sortConvs(orgSummary.unfiled)
    for (const p of orgSummary.projects) sortConvs(p.conversations)

    // Cross-reference what the desktop vault already has so the user can
    // skip rows that are already imported and unchanged.
    const ids = []
    for (const p of orgSummary.projects) for (const c of p.conversations) ids.push(c.id)
    for (const c of orgSummary.unfiled) ids.push(c.id)
    const statuses = await getVaultStatuses('claude_desktop', ids)
    const annotate = (c) => annotateVaultStatus(c, statuses[c.id])
    for (const p of orgSummary.projects) p.conversations.forEach(annotate)
    orgSummary.unfiled.forEach(annotate)

    out.push(orgSummary)
  }
  if (out.length === 0 && skipped.length > 0) {
    const detail = skipped.map((s) => `${s.name} (${s.reason})`).join('; ')
    return {
      signedIn: true,
      orgs: [],
      error: `No accessible Claude.ai organizations found. Skipped: ${detail}. Open https://claude.ai, switch to the workspace you want to sync, then click Re-scan.`,
    }
  }
  return { signedIn: true, orgs: out }
}

function orgLooksUnusable(org) {
  // Belt-and-braces: filter orgs whose capability list explicitly excludes
  // chat. /api/organizations returns every org the account has ever touched,
  // including ones the user has been removed from.
  if (Array.isArray(org.capabilities) && org.capabilities.length > 0) {
    if (!org.capabilities.includes('chat')) return true
  }
  if (org.api_disabled_reason) return true
  return false
}

function parsePermissionReason(snippet) {
  if (!snippet) return 'no permission for this organization'
  try {
    const j = JSON.parse(snippet)
    if (j && j.error && j.error.message) return j.error.message
  } catch {}
  return snippet.slice(0, 100)
}

/** @returns {Promise<{ signedIn: boolean, conversations: ConvSummary[], error?: string }>} */
export async function discoverChatGPT() {
  let session
  try {
    const r = await fetch(`${CHATGPT_ORIGIN}/api/auth/session`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    if (!r.ok) return { signedIn: false, conversations: [] }
    session = await r.json()
  } catch {
    return { signedIn: false, conversations: [] }
  }
  if (!session || !session.accessToken) return { signedIn: false, conversations: [] }

  const headers = { Accept: 'application/json', Authorization: `Bearer ${session.accessToken}` }
  let items = []
  try {
    const list = await getJson(
      `${CHATGPT_ORIGIN}/backend-api/conversations?offset=0&limit=100&order=updated`,
      { headers }
    )
    items = Array.isArray(list && list.items) ? list.items : []
  } catch (err) {
    return { signedIn: true, conversations: [], error: err.message }
  }
  const conversations = items
    .filter((m) => m && m.id)
    .map((m) => ({
      id: m.id,
      title: m.title || '(untitled)',
      updatedAt: typeof m.update_time === 'number' ? Math.floor(m.update_time) : null,
      vaultStatus: 'absent',
      cached: false,
    }))
  sortConvs(conversations)

  const statuses = await getVaultStatuses('chatgpt', conversations.map((c) => c.id))
  for (const c of conversations) annotateVaultStatus(c, statuses[c.id])

  return { signedIn: true, conversations }
}

/**
 * Set `conv.vaultStatus` to one of 'absent' | 'current' | 'stale' based on
 * whether the desktop vault already has this conversation and whether the
 * stored updatedAt matches the source's. Also mirrors to the legacy `cached`
 * flag so the rest of the UI keeps working.
 */
function annotateVaultStatus(conv, status) {
  if (!status || !status.inVault) {
    conv.vaultStatus = 'absent'
    conv.cached = false
    return
  }
  // Both sides hold Unix seconds. Treat exact match as "current"; any drift
  // means the conversation has been touched since the last import.
  if (
    typeof status.updatedAt === 'number' &&
    typeof conv.updatedAt === 'number' &&
    status.updatedAt === conv.updatedAt
  ) {
    conv.vaultStatus = 'current'
    conv.cached = true
    return
  }
  conv.vaultStatus = 'stale'
  conv.cached = false
}

function toEpochSec(iso) {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? Math.floor(t / 1000) : null
}

function sortConvs(arr) {
  arr.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}
