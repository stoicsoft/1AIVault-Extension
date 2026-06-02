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
// updated as the user clicks. The tree is rendered once after discovery and
// only re-rendered when the search filter changes.

let discovery = null
const selection = {
  claude: new Set(),
  chatgpt: new Set(),
}
let filter = ''

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
const selectAllBtn = document.getElementById('selectAllBtn')
const deselectAllBtn = document.getElementById('deselectAllBtn')
const onlyNewBtn = document.getElementById('onlyNewBtn')
const onlyUpdatedBtn = document.getElementById('onlyUpdatedBtn')
const summaryEl = document.getElementById('summary')
const startBtn = document.getElementById('startBtn')

searchInput.addEventListener('input', () => {
  filter = searchInput.value.trim().toLowerCase()
  renderTree()
})
selectAllBtn.addEventListener('click', () => {
  forEachVisibleConv((service, id) => selection[service].add(id))
  renderTree()
})
deselectAllBtn.addEventListener('click', () => {
  forEachVisibleConv((service, id) => selection[service].delete(id))
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

function selectByStatus(predicate) {
  if (discovery && discovery.claude && discovery.claude.signedIn) {
    selection.claude.clear()
    for (const org of discovery.claude.orgs) {
      for (const p of org.projects) {
        for (const c of p.conversations) if (predicate(c)) selection.claude.add(c.id)
      }
      for (const c of org.unfiled) if (predicate(c)) selection.claude.add(c.id)
    }
  }
  if (discovery && discovery.chatgpt && discovery.chatgpt.signedIn) {
    selection.chatgpt.clear()
    for (const c of discovery.chatgpt.conversations) if (predicate(c)) selection.chatgpt.add(c.id)
  }
  renderTree()
}
startBtn.addEventListener('click', startSync)

function renderTree() {
  tree.innerHTML = ''
  if (discovery && discovery.claude) {
    tree.appendChild(renderClaudeSection(discovery.claude))
  }
  if (discovery && discovery.chatgpt) {
    tree.appendChild(renderChatGPTSection(discovery.chatgpt))
  }
  updateSummary()
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
  const matches = (s) => !filter || (s.title || '').toLowerCase().includes(filter)
  for (const org of data.orgs) {
    // Projects
    for (const proj of org.projects) {
      const visibleChildren = proj.conversations.filter(matches)
      if (filter && visibleChildren.length === 0) continue
      const projNode = projectRow('claude', proj, visibleChildren.length)
      root.appendChild(projNode.row)
      for (const c of visibleChildren) {
        projNode.children.appendChild(convRow('claude', c, true))
      }
      root.appendChild(projNode.children)
    }
    // Unfiled
    const visibleUnfiled = org.unfiled.filter(matches)
    if (visibleUnfiled.length > 0) {
      const unfiledNode = projectRow('claude', { uuid: '__unfiled__', name: 'Unfiled', conversations: org.unfiled }, visibleUnfiled.length)
      root.appendChild(unfiledNode.row)
      for (const c of visibleUnfiled) {
        unfiledNode.children.appendChild(convRow('claude', c, true))
      }
      root.appendChild(unfiledNode.children)
    }
  }
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
  const matches = (s) => !filter || (s.title || '').toLowerCase().includes(filter)
  const list = data.conversations.filter(matches)
  if (list.length === 0) {
    root.appendChild(warn(filter ? 'No conversations match the filter.' : 'No conversations found.'))
    return root
  }
  const container = document.createElement('div')
  container.className = 'children'
  for (const c of list) container.appendChild(convRow('chatgpt', c, false))
  root.appendChild(container)
  return root
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

function projectRow(service, proj, visibleCount) {
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
  title.dataset.count = String(visibleCount)
  const when = document.createElement('span')
  when.className = 'when'
  when.textContent = ''
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
  const childIds = proj.conversations.map((c) => c.id)
  const refreshCheckbox = () => {
    const sel = selection[service]
    let on = 0
    for (const id of childIds) if (sel.has(id)) on++
    checkbox.checked = on === childIds.length && childIds.length > 0
    checkbox.indeterminate = on > 0 && on < childIds.length
  }
  refreshCheckbox()
  checkbox.onclick = (e) => {
    e.stopPropagation()
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

function convRow(service, conv, indented) {
  const status = conv.vaultStatus || 'absent'
  const node = document.createElement('div')
  node.className = 'node status-' + status
  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'
  checkbox.checked = selection[service].has(conv.id)
  const indent = document.createElement('span')
  indent.className = 'indent'
  if (!indented) indent.style.display = 'none'
  const title = document.createElement('span')
  title.className = 'title'
  title.textContent = conv.title || '(untitled)'
  const right = document.createElement('span')
  right.className = 'when'
  right.textContent = conv.updatedAt ? new Date(conv.updatedAt * 1000).toLocaleDateString() : ''
  node.appendChild(checkbox)
  node.appendChild(indent)
  node.appendChild(title)
  node.appendChild(right)
  if (status === 'current') {
    node.appendChild(badge('in vault', 'badge muted'))
  } else if (status === 'stale') {
    node.appendChild(badge('updated', 'badge accent'))
  }

  checkbox.onclick = (e) => {
    e.stopPropagation()
    if (checkbox.checked) selection[service].add(conv.id)
    else selection[service].delete(conv.id)
    updateSummary()
  }
  node.onclick = (e) => {
    if (e.target === checkbox) return
    checkbox.checked = !checkbox.checked
    checkbox.onclick(e)
  }
  return node
}

function updateSummary() {
  const c = selection.claude.size
  const g = selection.chatgpt.size
  // Break the selection down so the user can see whether they're about to
  // re-classify already-imported conversations.
  let newCount = 0
  let updatedCount = 0
  let alreadyCount = 0
  forEachConv((service, conv) => {
    if (!selection[service].has(conv.id)) return
    if (conv.vaultStatus === 'absent') newCount++
    else if (conv.vaultStatus === 'stale') updatedCount++
    else if (conv.vaultStatus === 'current') alreadyCount++
  })
  const parts = [
    `${c + g} selected`,
    `${c} Claude · ${g} ChatGPT`,
  ]
  if (newCount || updatedCount || alreadyCount) {
    parts.push(`${newCount} new · ${updatedCount} updated · ${alreadyCount} unchanged`)
  }
  summaryEl.textContent = parts.join(' · ')
  startBtn.disabled = c + g === 0
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
  const matches = (s) => !filter || (s.title || '').toLowerCase().includes(filter)
  if (discovery && discovery.claude && discovery.claude.signedIn) {
    for (const org of discovery.claude.orgs) {
      for (const p of org.projects) for (const c of p.conversations) if (matches(c)) fn('claude', c.id)
      for (const c of org.unfiled) if (matches(c)) fn('claude', c.id)
    }
  }
  if (discovery && discovery.chatgpt && discovery.chatgpt.signedIn) {
    for (const c of discovery.chatgpt.conversations) if (matches(c)) fn('chatgpt', c.id)
  }
}

// ─── Sync run ──────────────────────────────────────────────────────────────

async function startSync() {
  resetRunCards()
  show('run')
  setHeaderActions('running')
  subscribeProgress()
  await chrome.runtime.sendMessage({
    type: 'sync-now',
    reason: 'manual',
    filter: {
      claude: [...selection.claude],
      chatgpt: [...selection.chatgpt],
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
