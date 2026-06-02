// Service worker — orchestrates discovery + filtered syncs, broadcasts
// progress events to any open extension UI.

import { syncClaude } from './lib/claude.js'
import { syncChatGPT } from './lib/chatgpt.js'
import { discoverClaude, discoverChatGPT } from './lib/discover.js'
import { pingVault } from './lib/vault.js'

const ALARM = '1aivault-sync'
const PERIOD_MIN = 5

let inFlight = null

chrome.runtime.onInstalled.addListener(reconcileAlarm)
chrome.runtime.onStartup.addListener(reconcileAlarm)

async function reconcileAlarm() {
  const { autoSync } = await chrome.storage.local.get('autoSync')
  if (autoSync === true) {
    chrome.alarms.create(ALARM, { periodInMinutes: PERIOD_MIN })
  } else {
    chrome.alarms.clear(ALARM)
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM) return
  const { autoSync } = await chrome.storage.local.get('autoSync')
  // Belt-and-braces: even if a stale alarm fires (e.g. from a previous
  // session before the user disabled the toggle), honor the current state
  // *and* purge the alarm so it can't fire again until autoSync flips on.
  if (autoSync !== true) {
    chrome.alarms.clear(ALARM)
    return
  }
  // Passive: never open a claude.ai tab to do a background sync. If the user
  // doesn't have claude.ai open, we just skip — they'll get a real sync the
  // next time they're already on the site, or whenever they click Sync.
  await runSync({ reason: 'alarm', filter: null, allowOpenTab: false })
})

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false
  if (msg.type === 'set-autosync') {
    chrome.storage.local.set({ autoSync: msg.enabled === true }).then(async () => {
      await reconcileAlarm()
      sendResponse({ ok: true, autoSync: msg.enabled === true })
    })
    return true
  }
  if (msg.type === 'discover') {
    runDiscovery(msg.services, { allowOpenTab: true }).then(sendResponse)
    return true
  }
  if (msg.type === 'sync-now') {
    runSync({
      reason: msg.reason || 'manual',
      filter: msg.filter || null, // { claude: string[] | null, chatgpt: string[] | null }
      allowOpenTab: true, // user-initiated — OK to open a background claude.ai tab if needed
    }).then(sendResponse)
    return true
  }
  if (msg.type === 'ping-vault') {
    pingVault().then(sendResponse)
    return true
  }
  if (msg.type === 'open-progress') {
    openProgressTab().then(sendResponse)
    return true
  }
  if (msg.type === 'progress-state') {
    sendResponse({ inFlight: inFlight !== null, lastEvents: recentEvents.slice() })
    return false
  }
  return false
})

const recentEvents = []
const MAX_RECENT = 1000

function emit(event) {
  const stamped = { ...event, ts: Date.now() }
  recentEvents.push(stamped)
  if (recentEvents.length > MAX_RECENT) recentEvents.shift()
  chrome.runtime.sendMessage({ type: 'sync-event', event: stamped }).catch(() => {})
}

/** services: array of 'claude'|'chatgpt' — selective discovery. Defaults to both. */
async function runDiscovery(services, { allowOpenTab = true } = {}) {
  const want = Array.isArray(services) && services.length > 0
    ? new Set(services)
    : new Set(['claude', 'chatgpt'])
  emit({ stage: 'discover-start', services: [...want] })
  const result = { claude: null, chatgpt: null }
  const jobs = []
  if (want.has('claude')) jobs.push(discoverClaude({ allowOpenTab }).then((r) => (result.claude = r)))
  if (want.has('chatgpt')) jobs.push(discoverChatGPT().then((r) => (result.chatgpt = r)))
  await Promise.all(jobs)
  emit({ stage: 'discover-end' })
  return result
}

async function runSync({ reason, filter, allowOpenTab = true }) {
  if (inFlight) return inFlight
  inFlight = (async () => {
    const start = Date.now()
    recentEvents.length = 0
    emit({ stage: 'session-start', reason })

    const claudeIds = filter && Array.isArray(filter.claude) ? new Set(filter.claude) : null
    const chatgptIds = filter && Array.isArray(filter.chatgpt) ? new Set(filter.chatgpt) : null

    const result = { reason, claude: null, chatgpt: null }
    // If filter explicitly says "no Claude conversations", skip the service.
    const runClaude = !filter || claudeIds === null || claudeIds.size > 0
    const runChatgpt = !filter || chatgptIds === null || chatgptIds.size > 0

    if (runClaude) {
      try {
        result.claude = await syncClaude(emit, { selectedIds: claudeIds, allowOpenTab })
      } catch (err) {
        const message = err && err.message ? err.message : String(err)
        emit({ stage: 'fatal', service: 'claude', error: message })
        result.claude = { error: message }
      }
    } else {
      emit({ stage: 'skipped', service: 'claude' })
      result.claude = { skipped: true }
    }

    if (runChatgpt) {
      try {
        result.chatgpt = await syncChatGPT(emit, { selectedIds: chatgptIds })
      } catch (err) {
        const message = err && err.message ? err.message : String(err)
        emit({ stage: 'fatal', service: 'chatgpt', error: message })
        result.chatgpt = { error: message }
      }
    } else {
      emit({ stage: 'skipped', service: 'chatgpt' })
      result.chatgpt = { skipped: true }
    }

    const elapsed = Date.now() - start
    emit({ stage: 'session-end', elapsedMs: elapsed, result })
    // Don't pollute the "last sync" line with no-op passive runs — the auto-
    // sync alarm exits cleanly when there's no claude.ai tab to fetch from,
    // and we don't want every quiet skip overwriting the real last-sync time.
    const passive = result.claude && result.claude.passiveSkipped
    if (!passive) {
      await chrome.storage.local.set({
        lastSync: { at: Date.now(), elapsedMs: elapsed, result },
      })
    }
    return result
  })()
  try {
    return await inFlight
  } finally {
    inFlight = null
  }
}

async function openProgressTab() {
  const url = chrome.runtime.getURL('progress/progress.html')
  const tabs = await chrome.tabs.query({ url })
  if (tabs.length > 0) {
    const tab = tabs[0]
    await chrome.tabs.update(tab.id, { active: true })
    if (tab.windowId !== undefined) {
      await chrome.windows.update(tab.windowId, { focused: true })
    }
    return { tabId: tab.id, focused: true }
  }
  const tab = await chrome.tabs.create({ url })
  return { tabId: tab.id, focused: false }
}
