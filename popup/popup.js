import { getPairToken, setPairToken } from '../lib/vault.js'

const tokenInput = document.getElementById('token')
const saveBtn = document.getElementById('saveBtn')
const pingBtn = document.getElementById('pingBtn')
const pingStatus = document.getElementById('pingStatus')
const syncBtn = document.getElementById('syncBtn')
const fullscreenBtn = document.getElementById('fullscreenBtn')
const lastSync = document.getElementById('lastSync')
const serviceRows = document.getElementById('serviceRows')
const pairBadge = document.getElementById('pairBadge')
const autoSyncToggle = document.getElementById('autoSyncToggle')

init()

async function init() {
  const t = await getPairToken()
  if (t) tokenInput.value = t
  setPairBadge(!!t)
  const { autoSync } = await chrome.storage.local.get('autoSync')
  autoSyncToggle.checked = autoSync === true
  await refreshLastSync()
  await runPing()
}

saveBtn.addEventListener('click', async () => {
  const t = tokenInput.value.trim()
  if (!t) return
  await setPairToken(t)
  setPairBadge(true)
  await runPing()
})

pingBtn.addEventListener('click', runPing)

syncBtn.addEventListener('click', async () => {
  // Sync now: open fullscreen and let the user choose what to import there.
  await chrome.runtime.sendMessage({ type: 'open-progress' })
  window.close()
})

fullscreenBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'open-progress' })
  window.close()
})

autoSyncToggle.addEventListener('change', async () => {
  const enabled = autoSyncToggle.checked
  await chrome.runtime.sendMessage({ type: 'set-autosync', enabled })
})

async function runPing() {
  pingStatus.textContent = 'Checking…'
  const r = await chrome.runtime.sendMessage({ type: 'ping-vault' })
  if (r && r.ok) {
    pingStatus.textContent = 'Reachable on 127.0.0.1:54330'
    pingStatus.style.color = 'var(--success)'
  } else {
    pingStatus.textContent = `Not reachable${r && r.error ? ` — ${r.error}` : ''}`
    pingStatus.style.color = 'var(--danger)'
  }
}

async function refreshLastSync() {
  const { lastSync: ls } = await chrome.storage.local.get('lastSync')
  if (!ls) {
    lastSync.textContent = 'never'
    serviceRows.innerHTML = ''
    return
  }
  const ago = humanAgo(ls.at)
  lastSync.textContent = `${ago} (${ls.elapsedMs} ms)`
  serviceRows.innerHTML = ''
  if (ls.result) {
    serviceRows.appendChild(svcRow('Claude.ai', ls.result.claude))
    serviceRows.appendChild(svcRow('ChatGPT', ls.result.chatgpt))
  }
}

function svcRow(name, r) {
  const el = document.createElement('div')
  el.className = 'svc'
  const v = !r
    ? '—'
    : r.skipped === true
      ? 'skipped'
      : r.error
        ? `error: ${r.error}`
        : r.signedIn === false
          ? 'not signed in'
          : `+${r.imported || 0} new, ${r.skipped || 0} skipped`
  el.innerHTML = `<span class="name">${name}</span><span class="val">${v}</span>`
  return el
}

function setPairBadge(paired) {
  if (paired) {
    pairBadge.textContent = 'paired'
    pairBadge.className = 'badge ok'
  } else {
    pairBadge.textContent = 'unpaired'
    pairBadge.className = 'badge'
  }
}

function humanAgo(ms) {
  const sec = Math.floor((Date.now() - ms) / 1000)
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`
  return `${Math.floor(sec / 86400)}d ago`
}
