// Lightweight metadata discovery — used by the selection screen so the user
// can pick projects / conversations *before* we hit the per-conversation
// endpoints. No full-transcript fetches happen here.

import { getJson } from './net.js'

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

  const cache = await chrome.storage.local.get(null)
  const out = []
  for (const org of orgs) {
    if (!org || !org.uuid) continue
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

    // Conversations.
    let conversations = []
    try {
      conversations = await getJson(
        `${CLAUDE_BASE}/organizations/${org.uuid}/chat_conversations`
      )
    } catch (err) {
      return { signedIn: true, orgs: [], error: `claude conversations: ${err.message}` }
    }

    for (const meta of conversations || []) {
      if (!meta || !meta.uuid) continue
      const summary = {
        id: meta.uuid,
        title: meta.name || '(untitled)',
        updatedAt: toEpochSec(meta.updated_at),
        cached: cache[`claude:${meta.uuid}`] === meta.updated_at,
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
    out.push(orgSummary)
  }
  return { signedIn: true, orgs: out }
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
  const cache = await chrome.storage.local.get(null)
  const conversations = items
    .filter((m) => m && m.id)
    .map((m) => ({
      id: m.id,
      title: m.title || '(untitled)',
      updatedAt: typeof m.update_time === 'number' ? Math.floor(m.update_time) : null,
      cached: cache[`chatgpt:${m.id}`] === m.update_time,
    }))
  sortConvs(conversations)
  return { signedIn: true, conversations }
}

function toEpochSec(iso) {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? Math.floor(t / 1000) : null
}

function sortConvs(arr) {
  arr.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}
