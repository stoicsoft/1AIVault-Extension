// Pulls "Claude Design" projects from claude.ai. Design does NOT use the same
// /api/* REST surface as chat — it talks to a Connect-RPC service under
// /design/…/OmeletteService/*. Two methods are all we need:
//
//   ListProjects  {cursor?}       -> { items: [{ projectId, name, viewedAt, … }], cursor? }
//   GetProject    {projectId}     -> { projectId, name, createdAt, updatedAt, data }
//
// `data` is base64-encoded JSON holding the whole project, including every
// chat and message. We flatten a project's chats into a single conversation
// (most projects have exactly one) and import it under source 'claude_design'.
// The design source files themselves live inside assistant `write_file` tool
// calls (not the chat text), so we also replay those to reconstruct the final
// files and append them to the transcript — see extractFiles / renderFilesMessage.
//
// Every request runs inside a real claude.ai tab (see tab-fetch.js) so
// Anthropic's origin / anti-bot guard accepts it — the same reason the chat
// endpoints are fetched through a tab.

import { withServiceTab } from './tab-fetch.js'
import { getVaultStatuses, postConversations } from './vault.js'

const RPC = 'https://claude.ai/design/anthropic.omelette.api.v1alpha.OmeletteService'
// Connect-RPC over JSON requires the request media type or the server rejects
// the POST with 415 Unsupported Media Type. The tab fetcher only adds Accept,
// so we must set Content-Type ourselves here.
const RPC_HEADERS = { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }
const SOURCE = 'claude_design'
// Local "updatedAt" cache namespace. Bump the version whenever we change what
// we extract from a project so already-synced projects re-import once and pick
// up the new content (v2 added the embedded design files).
const CACHE_NS = `${SOURCE}:v2`
const cacheKeyFor = (projectId) => `${CACHE_NS}:${projectId}`

/** @typedef {{ id: string, title: string, updatedAt: number|null, vaultStatus: string, cached: boolean }} ConvSummary */

/**
 * Cheap metadata listing for the picker — lists projects only (no transcript
 * fetches). Mirrors discoverChatGPT's flat shape.
 *
 * @param {{ allowOpenTab?: boolean }} [opts]
 * @returns {Promise<{ signedIn: boolean, projects: ConvSummary[], error?: string, skipped?: boolean, reason?: string }>}
 */
export async function discoverClaudeDesign(opts = {}) {
  const allowOpenTab = opts.allowOpenTab !== false

  let items
  try {
    items = await withServiceTab('claude', { allowOpenTab }, (fetchJson) =>
      listAllProjects(fetchJson)
    )
  } catch (err) {
    if (err && err.code === 'NO_TAB') {
      return { signedIn: true, projects: [], skipped: true, reason: 'no claude.ai tab open' }
    }
    if (err && err.status === 401) return { signedIn: false, projects: [] }
    if (err && err.status === 403) return { signedIn: false, projects: [] }
    return { signedIn: true, projects: [], error: err && err.message ? err.message : String(err) }
  }

  const projects = []
  for (const p of items) {
    if (!p || !p.projectId) continue
    // ListProjects has no updatedAt — only viewedAt. Prefer the updatedAt we
    // cached at last import (so already-synced projects compare equal to the
    // vault and read as "imported"); fall back to viewedAt for never-synced
    // ones so the row still sorts sensibly.
    const cacheKey = cacheKeyFor(p.projectId)
    const cached = (await chrome.storage.local.get(cacheKey))[cacheKey]
    projects.push({
      id: p.projectId,
      title: p.name || '(untitled design)',
      updatedAt: (typeof cached === 'number' ? cached : null) ?? toEpochSec(p.viewedAt),
      vaultStatus: 'absent',
      cached: false,
    })
  }
  sortConvs(projects)

  const statuses = await getVaultStatuses(SOURCE, projects.map((c) => c.id))
  for (const c of projects) annotateVaultStatus(c, statuses[c.id])

  return { signedIn: true, projects }
}

/**
 * @param {(e: object) => void} emit
 * @param {{ selectedIds?: Set<string>|null, allowOpenTab?: boolean }} [opts]
 * @returns {Promise<{ imported: number, skipped: number, signedIn: boolean, passiveSkipped?: boolean }>}
 */
export async function syncClaudeDesign(emit = () => {}, opts = {}) {
  const selected = opts.selectedIds instanceof Set ? opts.selectedIds : null
  const allowOpenTab = opts.allowOpenTab !== false
  emit({ stage: 'start', service: 'design' })

  try {
    return await withServiceTab('claude', { allowOpenTab }, (fetchJson) =>
      syncViaTab(fetchJson, emit, selected)
    )
  } catch (err) {
    if (err && err.code === 'NO_TAB') {
      emit({ stage: 'done', service: 'design', skipped: true, reason: 'no claude.ai tab open', imported: 0, signedIn: true })
      return { imported: 0, skipped: 0, signedIn: true, passiveSkipped: true }
    }
    if (err && (err.status === 401 || err.status === 403)) {
      emit({ stage: 'done', service: 'design', signedIn: false })
      return { imported: 0, skipped: 0, signedIn: false }
    }
    throw err
  }
}

async function syncViaTab(fetchJson, emit, selected) {
  let items
  try {
    items = await listAllProjects(fetchJson)
  } catch (err) {
    if (err && (err.status === 401 || err.status === 403)) {
      emit({ stage: 'done', service: 'design', signedIn: false })
      return { imported: 0, skipped: 0, signedIn: false }
    }
    emit({ stage: 'done', service: 'design', signedIn: true, error: err.message })
    return { imported: 0, skipped: 0, signedIn: true, error: err.message }
  }

  const index = items.filter((p) => p && p.projectId && (!selected || selected.has(p.projectId)))
  emit({ stage: 'list', service: 'design', total: index.length })

  const batch = []
  for (let i = 0; i < index.length; i++) {
    const meta = index[i]
    const title = meta.name || '(untitled design)'

    let full
    try {
      full = await fetchJson(`${RPC}/GetProject`, {
        method: 'POST',
        headers: RPC_HEADERS,
        body: JSON.stringify({ projectId: meta.projectId }),
      })
    } catch (err) {
      emit({ stage: 'item', service: 'design', index: i + 1, total: index.length, title, outcome: 'error', error: err.message })
      continue
    }

    let project
    try {
      project = decodeProjectData(full && full.data)
    } catch (err) {
      emit({ stage: 'item', service: 'design', index: i + 1, total: index.length, title, outcome: 'error', error: `decode failed: ${err.message}` })
      continue
    }

    const updatedAt = toEpochSec(full && full.updatedAt)
    const cacheKey = cacheKeyFor(meta.projectId)
    const cached = (await chrome.storage.local.get(cacheKey))[cacheKey]
    if (typeof cached === 'number' && cached === updatedAt) {
      emit({ stage: 'item', service: 'design', index: i + 1, total: index.length, title, outcome: 'cached' })
      continue
    }

    const messages = extractMessages(project)
    const files = extractFiles(project)
    if (messages.length === 0 && files.length === 0) {
      emit({ stage: 'item', service: 'design', index: i + 1, total: index.length, title, outcome: 'empty' })
      continue
    }

    const extraTags = ['claude-design']
    if (Array.isArray(project.activeSkills)) {
      for (const s of project.activeSkills) {
        if (typeof s === 'string' && s) extraTags.push(`skill:${s.toLowerCase()}`)
      }
    }
    const fileTypes = new Set()
    const assets = new Set()
    for (const f of files) {
      extraTags.push(`file:${f.path}`)
      const ext = fileExt(f.path)
      if (ext) fileTypes.add(ext)
      if (f.asset) assets.add(f.asset)
    }
    for (const t of fileTypes) extraTags.push(`filetype:${t}`)
    for (const a of assets) extraTags.push(`asset:${slugify(a)}`)

    // Embed the final file set as a trailing assistant turn so the design
    // source is searchable in the vault alongside the conversation.
    const filesMessage = renderFilesMessage(files)
    const allMessages = filesMessage ? [...messages, filesMessage] : messages

    batch.push({
      externalId: meta.projectId,
      title: meta.name || project.name || null,
      createdAt: toEpochSec(full && full.createdAt),
      updatedAt,
      messages: allMessages,
      extraTags,
    })
    emit({ stage: 'item', service: 'design', index: i + 1, total: index.length, title, outcome: 'queued', messages: allMessages.length, files: files.length })
    if (typeof updatedAt === 'number') await chrome.storage.local.set({ [cacheKey]: updatedAt })
  }

  if (batch.length === 0) {
    emit({ stage: 'done', service: 'design', imported: 0, skipped: 0, signedIn: true })
    return { imported: 0, skipped: 0, signedIn: true }
  }

  let imported = 0
  let skipped = 0
  let chunkIdx = 0
  const chunks = chunkBy(batch, 25)
  for (const chunk of chunks) {
    chunkIdx++
    emit({ stage: 'post', service: 'design', chunk: chunkIdx, totalChunks: chunks.length, size: chunk.length })
    try {
      const r = await postConversations(SOURCE, chunk)
      imported += r.imported || 0
      skipped += r.skipped || 0
    } catch (err) {
      emit({ stage: 'post-error', service: 'design', error: err.message })
    }
  }
  emit({ stage: 'done', service: 'design', imported, skipped, signedIn: true })
  return { imported, skipped, signedIn: true }
}

/**
 * Walk the `cursor`-paginated ListProjects endpoint. The server ignores
 * page-size hints (fixed 20/page) and returns a `cursor` string for the next
 * page, absent/empty when there are no more. Dedupe by projectId defensively.
 */
async function listAllProjects(fetchJson, hardCap = 5000) {
  const all = []
  const seen = new Set()
  let cursor = null
  for (let guard = 0; guard < 500 && all.length < hardCap; guard++) {
    const body = cursor ? { cursor } : {}
    const resp = await fetchJson(`${RPC}/ListProjects`, {
      method: 'POST',
      headers: RPC_HEADERS,
      body: JSON.stringify(body),
    })
    const items = Array.isArray(resp && resp.items) ? resp.items : []
    let added = 0
    for (const it of items) {
      if (!it || !it.projectId || seen.has(it.projectId)) continue
      seen.add(it.projectId)
      all.push(it)
      added++
    }
    cursor = resp && resp.cursor ? resp.cursor : null
    if (!cursor || added === 0) break
  }
  return all
}

/** Decode GetProject's base64 `data` (UTF-8 JSON) into the project object. */
function decodeProjectData(b64) {
  if (typeof b64 !== 'string' || !b64) throw new Error('no data field')
  const bin = atob(b64)
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  const text = new TextDecoder('utf-8').decode(bytes)
  return JSON.parse(text)
}

/**
 * Flatten a project's chats (ordered by creation) into a single {role, text}[]
 * transcript. Prefers a message's plain `content` string, falling back to the
 * concatenated text of its typed `contentBlocks`.
 */
function extractMessages(project) {
  const chats = project && project.chats && typeof project.chats === 'object' ? project.chats : {}
  const chatList = Object.values(chats).sort(
    (a, b) => (Date.parse(a && a.created) || 0) - (Date.parse(b && b.created) || 0)
  )
  const out = []
  for (const chat of chatList) {
    const msgs = chat && Array.isArray(chat.messages) ? chat.messages : []
    for (const m of msgs) {
      const role = m && m.role === 'assistant' ? 'assistant' : m && m.role === 'user' ? 'user' : null
      if (!role) continue
      const text = collectText(m)
      if (text) out.push({ role, text })
    }
  }
  return out
}

function collectText(m) {
  if (typeof m.content === 'string' && m.content.trim().length > 0) return m.content.trim()
  if (Array.isArray(m.contentBlocks)) {
    const parts = []
    for (const b of m.contentBlocks) {
      if (b && typeof b.text === 'string' && b.text.trim().length > 0) parts.push(b.text.trim())
    }
    if (parts.length > 0) return parts.join('\n')
  }
  return null
}

/**
 * Reconstruct the project's final design files. Files are produced by
 * `write_file` tool calls buried in assistant messages' `contentBlocks[]`
 * (`toolCall.input.{path,content,asset}`) — the chat transcript itself never
 * carries the file bodies. We replay the writes in chat order so the last write
 * to a path wins, giving the final state of each file. `input.asset` groups
 * files into named deliverables (e.g. "Plainsmith — macOS app").
 *
 * @returns {{ path: string, content: string, asset: string|null }[]}
 */
function extractFiles(project) {
  const chats = project && project.chats && typeof project.chats === 'object' ? project.chats : {}
  const chatList = Object.values(chats).sort(
    (a, b) => (Date.parse(a && a.created) || 0) - (Date.parse(b && b.created) || 0)
  )
  const byPath = new Map() // path -> { path, content, asset }; last write wins
  for (const chat of chatList) {
    const msgs = chat && Array.isArray(chat.messages) ? chat.messages : []
    for (const m of msgs) {
      const blocks = m && Array.isArray(m.contentBlocks) ? m.contentBlocks : []
      for (const b of blocks) {
        const tc = b && b.toolCall
        if (!tc || tc.name !== 'write_file') continue
        const inp = tc.input
        if (!inp || typeof inp.path !== 'string' || typeof inp.content !== 'string') continue
        byPath.set(inp.path, {
          path: inp.path,
          content: inp.content,
          asset: typeof inp.asset === 'string' && inp.asset ? inp.asset : null,
        })
      }
    }
  }
  return Array.from(byPath.values())
}

/**
 * Render the design file set as a single assistant transcript message: files
 * grouped by their asset, each in a fenced code block. Returns null when there
 * are no files. The fence length adapts to any backtick run inside the content
 * so file bodies that contain ``` stay intact.
 */
function renderFilesMessage(files) {
  if (!files.length) return null
  const groups = new Map() // asset ('' = ungrouped) -> files, first-seen order
  for (const f of files) {
    const key = f.asset || ''
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(f)
  }
  const parts = ['### Design files']
  for (const [asset, list] of groups) {
    if (asset) parts.push(`\n#### ${asset}`)
    for (const f of list) parts.push(`\n**${f.path}**\n${fence(f.content, fenceLang(f.path))}`)
  }
  return { role: 'assistant', text: parts.join('\n') }
}

function fence(content, lang) {
  let longest = 0
  for (const run of content.match(/`+/g) || []) if (run.length > longest) longest = run.length
  const ticks = '`'.repeat(Math.max(3, longest + 1))
  return `${ticks}${lang}\n${content}\n${ticks}`
}

function fenceLang(path) {
  const ext = (path.split('.').pop() || '').toLowerCase()
  const map = {
    html: 'html', htm: 'html', jsx: 'jsx', tsx: 'tsx', js: 'js', ts: 'ts',
    css: 'css', scss: 'scss', md: 'markdown', json: 'json', svg: 'xml',
    vue: 'vue', py: 'python', sh: 'bash',
  }
  return map[ext] || ''
}

function fileExt(path) {
  return (path.split('.').pop() || '').toLowerCase()
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function annotateVaultStatus(conv, status) {
  if (!status || !status.inVault) {
    conv.vaultStatus = 'absent'
    conv.cached = false
    return
  }
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

function toEpochSec(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v)
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(t) ? Math.floor(t / 1000) : null
}

function sortConvs(arr) {
  arr.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}

function chunkBy(arr, n) {
  const out = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}
