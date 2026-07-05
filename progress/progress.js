// 1AIVault sync flow:
//   1. Discover — quietly fetch project + conversation lists.
//   2. Select  — user picks what to import (default all, "Only new" trims to
//                conversations not yet cached).
//   3. Run     — filtered sync with live progress + activity log.

const views = {
  picker: document.getElementById('view-picker'),
  loading: document.getElementById('view-loading'),
  select: document.getElementById('view-select'),
  run: document.getElementById('view-run'),
}
function show(name) {
  for (const k of Object.keys(views)) views[k].classList.toggle('hidden', k !== name)
}

const reasonEl = document.getElementById('reason')
const headerActions = document.getElementById('headerActions')

// ─── State ─────────────────────────────────────────────────────────────────
// All checkbox state lives in `selection.{claude,chatgpt}` (Set<id>) and is
// updated as the user clicks. Display controls only change which rows are
// visible; the final sync still sends the selected IDs.

let discovery = null
const selection = {
  claude: new Set(),
  chatgpt: new Set(),
}
let filter = ''
let viewMode = 'projects'
let statusFilter = 'all'
let sortMode = 'updated-desc'
let queryNewOnly = false

// ─── Bootstrap ─────────────────────────────────────────────────────────────

init()

async function init() {
  const state = await chrome.runtime.sendMessage({ type: 'progress-state' })
  if (state && state.inFlight) {
    // A sync is already running (alarm fired while we were navigating here).
    setHeaderActions('running')
    show('run')
    for (const e of state.lastEvents || []) consume(e)
    subscribeProgress()
    return
  }
  await renderLastSyncSummary()
  show('picker')
  setHeaderActions('picker')
}

async function renderLastSyncSummary() {
  const el = document.getElementById('lastSyncInfo')
  if (!el) return
  const { lastSync } = await chrome.storage.local.get('lastSync')
  if (!lastSync) {
    el.textContent = 'No sync yet.'
    return
  }
  const ago = humanAgo(lastSync.at)
  const r = lastSync.result || {}
  const describe = (svc, name) => {
    if (!svc) return `${name}: —`
    if (svc.skipped) return `${name}: skipped`
    if (svc.error) return `${name}: error`
    if (svc.signedIn === false) return `${name}: not signed in`
    return `${name}: +${svc.imported || 0} new`
  }
  el.textContent = `Last sync ${ago} — ${describe(r.claude, 'Claude.ai')}, ${describe(r.chatgpt, 'ChatGPT')}`
}

document.querySelectorAll('.picker-card').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const which = btn.dataset.service
    const services = which === 'both' ? ['claude', 'chatgpt'] : [which]
    const loadingMsg = document.getElementById('loadingMsg')
    if (loadingMsg) {
      loadingMsg.textContent = `Discovering ${services.map(labelFor).join(' + ')}…`
    }
    show('loading')
    setHeaderActions('loading')
    discovery = await chrome.runtime.sendMessage({ type: 'discover', services })
    buildInitialSelection()
    show('select')
    setHeaderActions('select')
    renderTree()
  })
})

function buildInitialSelection() {
  // Default: pick everything that's either new to the vault or has changed
  // since the last import. Skip 'current' items so the user isn't forced
  // to re-classify conversations that haven't changed.
  selection.claude.clear()
  selection.chatgpt.clear()
  const needsImport = (c) => c.vaultStatus !== 'current'
  if (discovery && discovery.claude && discovery.claude.signedIn) {
    for (const org of discovery.claude.orgs) {
      for (const p of org.projects) for (const c of p.conversations) if (needsImport(c)) selection.claude.add(c.id)
      for (const c of org.unfiled) if (needsImport(c)) selection.claude.add(c.id)
    }
  }
  if (discovery && discovery.chatgpt && discovery.chatgpt.signedIn) {
    for (const c of discovery.chatgpt.conversations) if (needsImport(c)) selection.chatgpt.add(c.id)
  }
  updateSummary()
}

// ─── Selection UI ──────────────────────────────────────────────────────────

function setHeaderActions(stage) {
  headerActions.innerHTML = ''
  if (stage === 'picker') {
    reasonEl.textContent = 'ready'
  } else if (stage === 'loading') {
    reasonEl.textContent = 'discovering…'
  } else if (stage === 'select') {
    reasonEl.textContent = 'choose what to import'
    const back = document.createElement('button')
    back.className = 'secondary'
    back.textContent = '← Back'
    back.onclick = () => {
      show('picker')
      setHeaderActions('picker')
      void renderLastSyncSummary()
    }
    headerActions.appendChild(back)
  } else if (stage === 'running') {
    reasonEl.textContent = 'syncing…'
  } else if (stage === 'done') {
    reasonEl.textContent = 'done'
    const back = document.createElement('button')
    back.className = 'secondary'
    back.textContent = 'Back to selection'
    back.onclick = () => {
      show('select')
      setHeaderActions('select')
    }
    const home = document.createElement('button')
    home.textContent = 'Sync something else'
    home.onclick = () => {
      show('picker')
      setHeaderActions('picker')
      void renderLastSyncSummary()
    }
    headerActions.appendChild(back)
    headerActions.appendChild(home)
  }
}

const tree = document.getElementById('tree')
const searchInput = document.getElementById('searchInput')
const projectsViewBtn = document.getElementById('projectsViewBtn')
const entriesViewBtn = document.getElementById('entriesViewBtn')
const statusFilterEl = document.getElementById('statusFilter')
const sortSelect = document.getElementById('sortSelect')
const selectAllBtn = document.getElementById('selectAllBtn')
const deselectAllBtn = document.getElementById('deselectAllBtn')
const onlyNewBtn = document.getElementById('onlyNewBtn')
const onlyUpdatedBtn = document.getElementById('onlyUpdatedBtn')
const queryNewOnlyInput = document.getElementById('queryNewOnlyInput')
const summaryEl = document.getElementById('summary')
const startBtn = document.getElementById('startBtn')

searchInput.addEventListener('input', () => {
  filter = searchInput.value.trim().toLowerCase()
  renderTree()
})
projectsViewBtn.addEventListener('click', () => {
  viewMode = 'projects'
  renderTree()
})
entriesViewBtn.addEventListener('click', () => {
  viewMode = 'entries'
  renderTree()
})
statusFilterEl.addEventListener('change', () => {
  statusFilter = statusFilterEl.value
  renderTree()
})
sortSelect.addEventListener('change', () => {
  sortMode = sortSelect.value
  renderTree()
})
selectAllBtn.addEventListener('click', () => {
  forEachVisibleConv((service, conv) => {
    if (isQueryable(conv)) selection[service].add(conv.id)
  })
  renderTree()
})
deselectAllBtn.addEventListener('click', () => {
  forEachVisibleConv((service, conv) => selection[service].delete(conv.id))
  renderTree()
})
onlyNewBtn.addEventListener('click', () => {
  // Keep only conversations the vault has never seen.
  selectByStatus((c) => c.vaultStatus === 'absent')
})
onlyUpdatedBtn.addEventListener('click', () => {
  // Keep only conversations the vault already has but that changed upstream.
  selectByStatus((c) => c.vaultStatus === 'stale')
})
queryNewOnlyInput.addEventListener('change', () => {
  queryNewOnly = queryNewOnlyInput.checked
  pruneSelectionForQuery()
  renderTree()
})

function selectByStatus(predicate) {
  selection.claude.clear()
  selection.chatgpt.clear()
  forEachConv((service, conv) => {
    if (predicate(conv) && isQueryable(conv)) selection[service].add(conv.id)
  })
  renderTree()
}
startBtn.addEventListener('click', startSync)

function renderTree() {
  tree.innerHTML = ''
  if (viewMode === 'entries') {
    tree.appendChild(renderEntriesSection())
  } else {
    if (discovery && discovery.claude) {
      tree.appendChild(renderClaudeSection(discovery.claude))
    }
    if (discovery && discovery.chatgpt) {
      tree.appendChild(renderChatGPTSection(discovery.chatgpt))
    }
  }
  updateControls()
  updateSummary()
}

function renderEntriesSection() {
  const root = section('Entries')
  appendDiscoveryWarnings(root)
  const list = sortedEntries(getAllEntries().filter(entryMatches))
  if (list.length === 0) {
    root.appendChild(warn(emptyMessage()))
    return root
  }
  const container = document.createElement('div')
  container.className = 'children'
  for (const entry of list) {
    container.appendChild(convRow(entry.service, entry.conv, false, entryMeta(entry)))
  }
  root.appendChild(container)
  return root
}

function renderClaudeSection(data) {
  const root = section('Claude.ai')
  if (!data.signedIn) {
    root.appendChild(warn(`Not signed in on this browser. Open claude.ai, sign in, then Re-scan.`))
    return root
  }
  if (data.error) {
    root.appendChild(warn(`Error: ${data.error}`))
    return root
  }
  let rendered = 0
  for (const org of data.orgs) {
    const projectNodes = []
    for (const proj of org.projects) {
      const visibleChildren = visibleConversations('claude', proj.conversations, proj.name, org.name)
      if (visibleChildren.length === 0) continue
      projectNodes.push({ proj, visibleChildren })
    }
    const visibleUnfiled = visibleConversations('claude', org.unfiled, 'Unfiled', org.name)
    if (visibleUnfiled.length > 0) {
      projectNodes.push({
        proj: { uuid: `__unfiled__:${org.uuid}`, name: 'Unfiled', conversations: org.unfiled },
        visibleChildren: visibleUnfiled,
      })
    }
    for (const { proj, visibleChildren } of sortProjectNodes(projectNodes)) {
      const projNode = projectRow('claude', proj, visibleChildren)
      root.appendChild(projNode.row)
      for (const c of visibleChildren) {
        projNode.children.appendChild(convRow('claude', c, true, `${org.name} / ${proj.name}`))
      }
      root.appendChild(projNode.children)
      rendered++
    }
  }
  if (rendered === 0) root.appendChild(warn(emptyMessage()))
  return root
}

function renderChatGPTSection(data) {
  const root = section('ChatGPT')
  if (!data.signedIn) {
    root.appendChild(warn(`Not signed in on this browser. Open chatgpt.com, sign in, then Re-scan.`))
    return root
  }
  if (data.error) {
    root.appendChild(warn(`Error: ${data.error}`))
    return root
  }
  const list = sortedEntries(
    data.conversations
      .map((conv) => ({ service: 'chatgpt', conv, projectName: '', orgName: '' }))
      .filter(entryMatches)
  )
  if (list.length === 0) {
    root.appendChild(warn(emptyMessage()))
    return root
  }
  const container = document.createElement('div')
  container.className = 'children'
  for (const entry of list) container.appendChild(convRow('chatgpt', entry.conv, false, entryMeta(entry)))
  root.appendChild(container)
  return root
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

function getAllEntries() {
  const entries = []
  if (discovery && discovery.claude && discovery.claude.signedIn && !discovery.claude.error) {
    for (const org of discovery.claude.orgs) {
      for (const p of org.projects) {
        for (const conv of p.conversations) {
          entries.push({ service: 'claude', conv, projectName: p.name, orgName: org.name })
        }
      }
      for (const conv of org.unfiled) {
        entries.push({ service: 'claude', conv, projectName: 'Unfiled', orgName: org.name })
      }
    }
  }
  if (discovery && discovery.chatgpt && discovery.chatgpt.signedIn && !discovery.chatgpt.error) {
    for (const conv of discovery.chatgpt.conversations) {
      entries.push({ service: 'chatgpt', conv, projectName: '', orgName: '' })
    }
  }
  return entries
}

function appendDiscoveryWarnings(root) {
  if (discovery && discovery.claude) appendServiceWarning(root, 'Claude.ai', discovery.claude)
  if (discovery && discovery.chatgpt) appendServiceWarning(root, 'ChatGPT', discovery.chatgpt)
}

function appendServiceWarning(root, label, data) {
  if (!data.signedIn) {
    root.appendChild(warn(`${label}: not signed in on this browser.`))
  } else if (data.error) {
    root.appendChild(warn(`${label}: ${data.error}`))
  }
}

function visibleConversations(service, conversations, projectName, orgName) {
  return sortedEntries(
    conversations
      .map((conv) => ({ service, conv, projectName, orgName }))
      .filter(entryMatches)
  ).map((entry) => entry.conv)
}

function entryMatches(entry) {
  if (!statusMatches(entry.conv)) return false
  if (!filter) return true
  const haystack = [
    entry.conv.title,
    entry.projectName,
    entry.orgName,
    labelFor(entry.service),
  ].join(' ').toLowerCase()
  return haystack.includes(filter)
}

function statusMatches(conv) {
  const status = conv.vaultStatus || 'absent'
  if (statusFilter === 'importable') return status === 'absent' || status === 'stale'
  if (statusFilter === 'new') return status === 'absent'
  if (statusFilter === 'updated') return status === 'stale'
  if (statusFilter === 'imported') return status === 'current'
  return true
}

function sortedEntries(entries) {
  return entries.slice().sort(compareEntries)
}

function compareEntries(a, b) {
  if (sortMode === 'updated-asc') {
    return compareUpdated(a, b, 1) || compareTitle(a, b)
  }
  if (sortMode === 'title-asc') {
    return compareTitle(a, b) || compareUpdated(a, b, -1)
  }
  if (sortMode === 'project-asc') {
    return collator.compare(a.projectName || '', b.projectName || '') || compareTitle(a, b)
  }
  if (sortMode === 'status-asc') {
    return statusRank(a.conv) - statusRank(b.conv) || compareUpdated(a, b, -1) || compareTitle(a, b)
  }
  if (sortMode === 'service-asc') {
    return collator.compare(labelFor(a.service), labelFor(b.service)) || compareUpdated(a, b, -1) || compareTitle(a, b)
  }
  return compareUpdated(a, b, -1) || compareTitle(a, b)
}

function compareUpdated(a, b, direction) {
  return ((a.conv.updatedAt || 0) - (b.conv.updatedAt || 0)) * direction
}

function compareTitle(a, b) {
  return collator.compare(a.conv.title || '', b.conv.title || '')
}

function sortProjectNodes(nodes) {
  return nodes.slice().sort((a, b) => {
    if (sortMode === 'updated-asc') {
      return projectUpdated(a) - projectUpdated(b) || collator.compare(a.proj.name || '', b.proj.name || '')
    }
    if (sortMode === 'title-asc' || sortMode === 'project-asc' || sortMode === 'service-asc') {
      return collator.compare(a.proj.name || '', b.proj.name || '')
    }
    if (sortMode === 'status-asc') {
      return projectStatusRank(a) - projectStatusRank(b) || collator.compare(a.proj.name || '', b.proj.name || '')
    }
    return projectUpdated(b) - projectUpdated(a) || collator.compare(a.proj.name || '', b.proj.name || '')
  })
}

function projectUpdated(node) {
  let latest = 0
  for (const c of node.visibleChildren) latest = Math.max(latest, c.updatedAt || 0)
  return latest
}

function projectStatusRank(node) {
  let rank = 99
  for (const c of node.visibleChildren) rank = Math.min(rank, statusRank(c))
  return rank
}

function statusRank(conv) {
  const status = conv.vaultStatus || 'absent'
  if (status === 'absent') return 0
  if (status === 'stale') return 1
  if (status === 'current') return 2
  return 3
}

function entryMeta(entry) {
  if (entry.service === 'claude') return `${labelFor(entry.service)} / ${entry.projectName || 'Unfiled'}`
  return labelFor(entry.service)
}

function emptyMessage() {
  if (filter || statusFilter !== 'all') return 'No entries match the current search or filter.'
  return 'No conversations found.'
}

function section(title) {
  const wrap = document.createElement('div')
  wrap.className = 'section'
  const head = document.createElement('div')
  head.className = 'head'
  head.textContent = title
  wrap.appendChild(head)
  return wrap
}

function warn(text) {
  const w = document.createElement('div')
  w.className = 'signin-warn'
  w.textContent = text
  return w
}

function badge(text, className) {
  const b = document.createElement('span')
  b.className = className || 'badge'
  b.textContent = text
  return b
}

function projectRow(service, proj, visibleConversations) {
  const row = document.createElement('div')
  row.className = 'node project'
  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'
  const caret = document.createElement('span')
  caret.className = 'caret'
  caret.textContent = '›'
  const title = document.createElement('span')
  title.className = 'title'
  title.textContent = proj.name
  title.dataset.count = String(visibleConversations.length)
  const when = document.createElement('span')
  when.className = 'when'
  when.textContent = formatProjectDate(visibleConversations)
  row.appendChild(checkbox)
  row.appendChild(caret)
  row.appendChild(title)
  row.appendChild(when)

  const children = document.createElement('div')
  children.className = 'children'
  children.style.display = 'none'

  caret.onclick = (e) => {
    e.stopPropagation()
    const open = children.style.display !== 'none'
    children.style.display = open ? 'none' : 'block'
    caret.classList.toggle('open', !open)
  }
  // Project-level checkbox toggles all children in this project.
  const childIds = visibleConversations.filter(isQueryable).map((c) => c.id)
  const refreshCheckbox = () => {
    const sel = selection[service]
    let on = 0
    for (const id of childIds) if (sel.has(id)) on++
    checkbox.checked = on === childIds.length && childIds.length > 0
    checkbox.indeterminate = on > 0 && on < childIds.length
    checkbox.disabled = childIds.length === 0
  }
  refreshCheckbox()
  checkbox.onclick = (e) => {
    e.stopPropagation()
    if (checkbox.disabled) return
    const sel = selection[service]
    if (checkbox.checked) for (const id of childIds) sel.add(id)
    else for (const id of childIds) sel.delete(id)
    renderTree()
  }
  row.onclick = (e) => {
    if (e.target === checkbox) return
    caret.onclick(e)
  }

  return { row, children, refreshCheckbox }
}

function convRow(service, conv, indented, metaText = '') {
  const status = conv.vaultStatus || 'absent'
  const node = document.createElement('div')
  node.className = 'node status-' + status
  if (!isQueryable(conv)) node.classList.add('not-queryable')
  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'
  checkbox.checked = selection[service].has(conv.id)
  checkbox.disabled = !isQueryable(conv)
  const indent = document.createElement('span')
  indent.className = 'indent'
  if (!indented) indent.style.display = 'none'
  const title = document.createElement('span')
  title.className = 'title'
  title.textContent = conv.title || '(untitled)'
  const meta = document.createElement('span')
  meta.className = 'meta'
  meta.textContent = metaText
  const right = document.createElement('span')
  right.className = 'when'
  right.textContent = formatDate(conv.updatedAt)
  node.appendChild(checkbox)
  node.appendChild(indent)
  node.appendChild(title)
  node.appendChild(meta)
  node.appendChild(right)
  if (status === 'absent') {
    node.appendChild(badge('new', 'badge success'))
  } else if (status === 'current') {
    node.appendChild(badge('imported', 'badge muted'))
  } else if (status === 'stale') {
    node.appendChild(badge('updated', 'badge accent'))
  }

  checkbox.onclick = (e) => {
    e.stopPropagation()
    if (checkbox.disabled) return
    if (checkbox.checked) selection[service].add(conv.id)
    else selection[service].delete(conv.id)
    updateSummary()
  }
  node.onclick = (e) => {
    if (e.target === checkbox || checkbox.disabled) return
    checkbox.checked = !checkbox.checked
    checkbox.onclick(e)
  }
  return node
}

function formatDate(epochSec) {
  return epochSec ? new Date(epochSec * 1000).toLocaleDateString() : ''
}

function formatProjectDate(conversations) {
  let latest = 0
  for (const c of conversations) latest = Math.max(latest, c.updatedAt || 0)
  return formatDate(latest)
}

function updateSummary() {
  const c = selection.claude.size
  const g = selection.chatgpt.size
  const selectedForSync = getSelectedIdsForSync()
  const syncCount = selectedForSync.claude.length + selectedForSync.chatgpt.length
  let newCount = 0
  let updatedCount = 0
  let importedCount = 0
  forEachConv((service, conv) => {
    if (!selection[service].has(conv.id)) return
    const status = conv.vaultStatus || 'absent'
    if (status === 'absent') newCount++
    else if (status === 'stale') updatedCount++
    else if (status === 'current') importedCount++
  })
  const entries = getAllEntries()
  const visibleCount = entries.filter(entryMatches).length
  const parts = [
    `${c + g} selected`,
    `${c} Claude · ${g} ChatGPT`,
    `${newCount} new · ${updatedCount} updated · ${importedCount} imported`,
  ]
  if (queryNewOnly) parts.push(`${syncCount} to query`)
  parts.push(`${visibleCount}/${entries.length} visible`)
  summaryEl.textContent = parts.join(' · ')
  startBtn.disabled = syncCount === 0
}

function updateControls() {
  projectsViewBtn.classList.toggle('active', viewMode === 'projects')
  entriesViewBtn.classList.toggle('active', viewMode === 'entries')
  statusFilterEl.value = statusFilter
  sortSelect.value = sortMode
  queryNewOnlyInput.checked = queryNewOnly
  onlyUpdatedBtn.disabled = queryNewOnly
}

function isQueryable(conv) {
  return !queryNewOnly || (conv.vaultStatus || 'absent') === 'absent'
}

function pruneSelectionForQuery() {
  if (!queryNewOnly) return
  forEachConv((service, conv) => {
    if (!isQueryable(conv)) selection[service].delete(conv.id)
  })
}

function getSelectedIdsForSync() {
  const selected = { claude: [], chatgpt: [] }
  forEachConv((service, conv) => {
    if (selection[service].has(conv.id) && isQueryable(conv)) selected[service].push(conv.id)
  })
  return selected
}

function forEachConv(fn) {
  if (discovery && discovery.claude && discovery.claude.signedIn) {
    for (const org of discovery.claude.orgs) {
      for (const p of org.projects) for (const c of p.conversations) fn('claude', c)
      for (const c of org.unfiled) fn('claude', c)
    }
  }
  if (discovery && discovery.chatgpt && discovery.chatgpt.signedIn) {
    for (const c of discovery.chatgpt.conversations) fn('chatgpt', c)
  }
}

function forEachVisibleConv(fn) {
  for (const entry of getAllEntries()) {
    if (entryMatches(entry)) fn(entry.service, entry.conv)
  }
}

// ─── Sync run ──────────────────────────────────────────────────────────────

async function startSync() {
  const selectedForSync = getSelectedIdsForSync()
  if (selectedForSync.claude.length + selectedForSync.chatgpt.length === 0) return
  resetRunCards()
  show('run')
  setHeaderActions('running')
  subscribeProgress()
  await chrome.runtime.sendMessage({
    type: 'sync-now',
    reason: 'manual',
    filter: {
      claude: selectedForSync.claude,
      chatgpt: selectedForSync.chatgpt,
    },
  })
}

let progressSubscribed = false
function subscribeProgress() {
  if (progressSubscribed) return
  progressSubscribed = true
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'sync-event' && msg.event) consume(msg.event)
  })
}

// ─── Run UI bindings (cards + log) ─────────────────────────────────────────

const cards = {
  claude: makeCardBinding('card-claude'),
  chatgpt: makeCardBinding('card-chatgpt'),
}
const logList = document.getElementById('logList')
const autoscroll = document.getElementById('autoscroll')

const totals = {
  claude: { imported: 0, skipped: 0, errors: 0 },
  chatgpt: { imported: 0, skipped: 0, errors: 0 },
}

function resetRunCards() {
  for (const k of Object.keys(cards)) {
    cards[k].reset()
    totals[k] = { imported: 0, skipped: 0, errors: 0 }
  }
  logList.innerHTML = ''
}

function consume(event) {
  const { stage, service } = event

  if (stage === 'session-start') {
    appendLog(event, 'system', `Sync session started (${event.reason})`)
    return
  }
  if (stage === 'session-end') {
    const r = event.result || {}
    const claude = describeServiceResult(r.claude)
    const chatgpt = describeServiceResult(r.chatgpt)
    appendLog(event, 'done', `Session complete · Claude: ${claude} · ChatGPT: ${chatgpt}`)
    setHeaderActions('done')
    return
  }
  if (stage === 'discover-start') return
  if (stage === 'discover-end') return
  if (stage === 'skipped' && service && cards[service]) {
    cards[service].setState('skipped')
    cards[service].setStatus('idle')
    appendLog(event, 'system', `${labelFor(service)} — skipped (nothing selected)`)
    return
  }

  const card = service && cards[service]
  if (!card) return

  if (stage === 'start') {
    card.setStatus('running')
    card.setState('starting…')
    card.setMetric('—')
    appendLog(event, 'system', `Connecting to ${labelFor(service)}…`)
    return
  }
  if (stage === 'list') {
    card.setState(`scanning (${event.total})`)
    card.setMetric(`0 / ${event.total}`)
    appendLog(event, 'system', `Targeting ${event.total} conversations on ${labelFor(service)}`)
    return
  }
  if (stage === 'item') {
    card.setMetric(`${event.index} / ${event.total}`)
    card.setBar(event.index / Math.max(event.total, 1))
    if (event.outcome === 'queued') {
      appendLog(event, 'queued', `[${event.index}/${event.total}] ${event.title} — ${event.messages} msgs queued`)
    } else if (event.outcome === 'cached') {
      appendLog(event, 'cached', `[${event.index}/${event.total}] ${event.title} — up to date`)
    } else if (event.outcome === 'empty') {
      appendLog(event, 'empty', `[${event.index}/${event.total}] ${event.title} — empty, skipped`)
    } else if (event.outcome === 'error') {
      totals[service].errors++
      card.bumpErrors()
      appendLog(event, 'error', `[${event.index}/${event.total}] ${event.title} — ${event.error}`)
    }
    return
  }
  if (stage === 'post') {
    card.setState(`posting chunk ${event.chunk}/${event.totalChunks}`)
    appendLog(event, 'post', `Sending chunk ${event.chunk}/${event.totalChunks} (${event.size} conversations)`)
    return
  }
  if (stage === 'post-error') {
    totals[service].errors++
    card.bumpErrors()
    appendLog(event, 'error', `Post failed: ${event.error}`)
    return
  }
  if (stage === 'done') {
    if (event.signedIn === false) {
      card.setStatus('warn')
      card.setState('not signed in')
      appendLog(event, 'system', `${labelFor(service)} — you're not signed in on this browser`)
      return
    }
    totals[service].imported = event.imported || 0
    totals[service].skipped = event.skipped || 0
    card.setImported(totals[service].imported)
    card.setSkipped(totals[service].skipped)
    card.setStatus(totals[service].errors > 0 ? 'warn' : 'ok')
    card.setStateBackground('ok')
    card.setState(`done · +${event.imported || 0}`)
    card.setBar(1)
    appendLog(event, 'done', `${labelFor(service)} done — +${event.imported || 0} imported, ${event.skipped || 0} skipped`)
    return
  }
  if (stage === 'fatal') {
    totals[service].errors++
    card.bumpErrors()
    card.setStatus('error')
    card.setStateBackground('error')
    card.setState('failed')
    appendLog(event, 'error', `Fatal error: ${event.error}`)
  }
}

function describeServiceResult(r) {
  if (!r) return '—'
  if (r.skipped === true) return 'skipped'
  if (r.error) return `error (${r.error})`
  if (r.signedIn === false) return 'not signed in'
  return `+${r.imported || 0} new, ${r.skipped || 0} skipped`
}

function labelFor(service) {
  return service === 'claude' ? 'Claude.ai' : service === 'chatgpt' ? 'ChatGPT' : service
}

function appendLog(event, cls, message) {
  const row = document.createElement('div')
  row.className = `entry ${cls}`
  const ts = event.ts ? new Date(event.ts) : new Date()
  const svc = event.service || '·'
  row.innerHTML =
    `<span class="t">${hh(ts)}</span>` +
    `<span class="svc ${svc}">${svc}</span>` +
    `<span class="msg"></span>`
  row.querySelector('.msg').textContent = message
  logList.appendChild(row)
  while (logList.childNodes.length > 2000) logList.removeChild(logList.firstChild)
  if (autoscroll.checked) logList.scrollTop = logList.scrollHeight
}

function hh(d) { return d.toTimeString().slice(0, 8) }

function humanAgo(ms) {
  const sec = Math.floor((Date.now() - ms) / 1000)
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`
  return `${Math.floor(sec / 86400)}d ago`
}

function makeCardBinding(id) {
  const root = document.getElementById(id)
  const dot = root.querySelector('.dot')
  const state = root.querySelector('[data-state]')
  const bar = root.querySelector('[data-bar]')
  const metric = root.querySelector('[data-metric]')
  const imp = root.querySelector('[data-imported]')
  const skip = root.querySelector('[data-skipped]')
  const err = root.querySelector('[data-errors]')
  let errorCount = 0
  return {
    setStatus(s) { dot.dataset.status = s },
    setStateBackground(s) { root.dataset.state = s },
    setState(text) { state.textContent = text },
    setBar(pct) { bar.style.width = `${Math.min(100, Math.max(0, pct * 100))}%` },
    setMetric(text) { metric.textContent = text },
    setImported(n) { imp.textContent = String(n) },
    setSkipped(n) { skip.textContent = String(n) },
    bumpErrors() { errorCount++; err.textContent = String(errorCount) },
    reset() {
      this.setStatus('idle')
      this.setStateBackground('')
      this.setState('idle')
      this.setBar(0)
      this.setMetric('—')
      this.setImported(0)
      this.setSkipped(0)
      errorCount = 0
      err.textContent = '0'
    },
  }
}
