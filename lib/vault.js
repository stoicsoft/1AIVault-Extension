// Local-only HTTP receiver in the 1AIVault desktop app.
// Token is paired by the user once via the popup.

const VAULT_URL = 'http://127.0.0.1:54330/v1/conversations'
const STATUS_URL = 'http://127.0.0.1:54330/v1/conversations/status'
const PING_URL = 'http://127.0.0.1:54330/v1/ping'

export async function getPairToken() {
  const { pairToken } = await chrome.storage.local.get('pairToken')
  return pairToken || null
}

export async function setPairToken(token) {
  await chrome.storage.local.set({ pairToken: token })
}

/** Verify the desktop app is reachable. */
export async function pingVault() {
  try {
    const res = await fetch(PING_URL, { method: 'GET' })
    if (!res.ok) return { ok: false, error: `status ${res.status}` }
    const body = await res.json()
    return { ok: body && body.ok === true }
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) }
  }
}

/**
 * Ask the desktop vault which of these conversation IDs it already has, and
 * what each one's stored updatedAt is. Returns {} on any failure (unpaired /
 * vault offline / endpoint missing on older desktops) so the caller can fall
 * back to treating everything as new.
 *
 * @param {'claude_desktop'|'chatgpt'} source
 * @param {string[]} externalIds
 * @returns {Promise<Record<string, { inVault: boolean, updatedAt?: number, messageCount?: number }>>}
 */
export async function getVaultStatuses(source, externalIds) {
  if (!Array.isArray(externalIds) || externalIds.length === 0) return {}
  const token = await getPairToken()
  if (!token) return {}
  try {
    const res = await fetch(STATUS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ source, externalIds }),
    })
    if (!res.ok) return {}
    const body = await res.json()
    return body && body.statuses && typeof body.statuses === 'object' ? body.statuses : {}
  } catch {
    return {}
  }
}

/** POST a batch of conversations. */
export async function postConversations(source, conversations) {
  if (conversations.length === 0) return { imported: 0, skipped: 0 }
  const token = await getPairToken()
  if (!token) throw new Error('not paired — open the popup and paste your token')

  const res = await fetch(VAULT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ source, conversations }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`vault returned ${res.status}: ${text || 'no body'}`)
  }
  return res.json()
}
