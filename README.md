# 1AIVault Sync

A browser extension that mirrors your **own** Claude.ai and ChatGPT conversations into the [1AIVault](https://1aivault.com) desktop app running on the same machine. Everything stays on your computer — the extension only talks to `claude.ai`, `chatgpt.com`, and `http://127.0.0.1:54330`.

> **Status:** open source, MIT licensed. Listed on the Chrome Web Store *(pending review)*. Until the store listing is live, use the "Load unpacked" instructions below.

---

## Why this exists

The 1AIVault desktop app is a local memory vault for your AI tools — your decisions, preferences, skills, and conversation history, indexed in a SQLite database and exposed to Claude Code / Claude Desktop / Cursor / Cline via MCP.

To populate the vault from the cloud chats you already have, the desktop app needs a way to read them. Anthropic and OpenAI both provide official **export** flows (Settings → Privacy → Export), but those are slow, manual, and email-delivered. This extension is a faster path: while you are already signed in to claude.ai / chatgpt.com in your browser, it uses your session cookies to fetch your conversations and POST them to the desktop app over loopback.

If you don't want to use this extension, the official exports work fine — the desktop app can import them too.

---

## What it does (and doesn't)

**Does:**

- Reads conversations from Claude.ai and ChatGPT **for the account you are signed in as**.
- Sends them to `http://127.0.0.1:54330` — a loopback receiver that only the 1AIVault desktop app on your machine listens on.
- Caches a per-conversation `updated_at` timestamp so unchanged conversations are skipped on the next sync.
- Optionally runs in the background every 5 minutes (opt-in toggle).

**Doesn't:**

- Talk to any server other than `claude.ai`, `chatgpt.com`, and `127.0.0.1`.
- Read other people's data, organisations you're not a member of, or anything you can't already see in your own browser tab.
- Train any model, send telemetry, or analyse your conversations.
- Modify pages on claude.ai / chatgpt.com — there are no content scripts.

---

## Install

### Chrome / Edge / Brave / Arc (Load unpacked)

1. Clone or download this repo.
2. Open `chrome://extensions` and toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and choose this folder.
4. Click the puzzle-piece icon in the toolbar and pin **1AIVault Sync**.

### Firefox

1. `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…**
2. Select `manifest.json` in this folder.

Note: Firefox unloads temporary add-ons on restart. For permanent install, package + sign via [AMO](https://addons.mozilla.org/).

### Safari

Safari requires Xcode's *Safari Web Extension Converter* against this folder, followed by signing + install of the resulting `.app`.

---

## Pair with the desktop app

The extension needs a one-time pair token so the desktop app knows it's you.

1. Open the **1AIVault** desktop app.
2. `Settings (⌘ ,) → General → Browser extension` → click **Copy pair token**.
3. Click the **1AIVault Sync** icon in the browser toolbar.
4. Paste the token, click **Save**.
5. The badge should switch to **paired** and Connection should read *"Reachable on 127.0.0.1:54330"*.

Lost / leaked your token? Regenerate it in the desktop app and paste the new one.

---

## Use it

There are two ways to sync:

- **Sync now (fullscreen)** — opens a tab with a list of every conversation grouped by org / project. Pick what to import, click **Start import →**.
- **Auto-sync** — toggle in the popup. The service worker runs every 5 minutes and imports anything new / changed since the last tick. No UI, no notifications.

Either way, conversations are de-duplicated by `externalId` (the original UUID from claude.ai / chatgpt.com), so re-syncing is safe.

---

## How it works

```
┌──────────────────┐    cookies     ┌──────────────┐
│ claude.ai API    │ ◀──────────── │ Service      │
│ chatgpt.com API  │                │ worker       │
└──────────────────┘ ──── JSON ───▶ │ (background) │
                                    └──────┬───────┘
                                           │  POST + Bearer pair-token
                                           ▼
                                  ┌────────────────────┐
                                  │ 127.0.0.1:54330    │
                                  │ 1AIVault desktop   │
                                  │ → SQLite vault.db  │
                                  └────────────────────┘
```

### Claude.ai

1. `GET /api/organizations` — list orgs the signed-in user belongs to.
2. For each org: `GET /api/organizations/<uuid>/projects` (best-effort — some tiers don't expose this) and `GET /api/organizations/<uuid>/chat_conversations`.
3. For each conversation: `GET /api/organizations/<uuid>/chat_conversations/<id>?rendering_mode=raw` to fetch the full transcript.
4. Auth = your existing Claude.ai cookies (`credentials: 'include'`).

### ChatGPT

1. `GET https://chatgpt.com/api/auth/session` to retrieve the short-lived access token.
2. `GET /backend-api/conversations?offset=0&limit=100&order=updated`.
3. For each conversation: `GET /backend-api/conversation/<id>` to fetch the full `mapping` tree.
4. Auth = `Authorization: Bearer <accessToken>`.

### Header rewriting

Both APIs reject XHRs whose `Origin` is `chrome-extension://…` (Cloudflare same-origin check). The extension uses [`declarativeNetRequest`](rules.json) to rewrite `Origin`, `Referer`, and the `Sec-Fetch-*` headers on outbound requests to `claude.ai/api/*` and `chatgpt.com/*` so the API sees a same-origin request. No request data is modified.

### Local receiver

`POST http://127.0.0.1:54330/v1/conversations`

```json
{
  "source": "claude_desktop" | "chatgpt",
  "conversations": [
    {
      "externalId": "uuid",
      "title": "...",
      "createdAt": 1730000000,
      "updatedAt": 1730009999,
      "messages": [
        { "role": "user" | "assistant", "text": "..." }
      ],
      "extraTags": ["project:my-side-project"]
    }
  ]
}
```

Headers: `Authorization: Bearer <pair-token>`.
The desktop app dedups by `externalId`, inserts new entries into the vault, and updates existing ones.

---

## Privacy

- The extension communicates **only** with the hosts listed in `manifest.json`:
  - `claude.ai` / `*.claude.ai`
  - `chatgpt.com` / `chat.openai.com`
  - `127.0.0.1:54330` (loopback only)
- The desktop app's receiver binds to `127.0.0.1` — it is not reachable from other devices on your network.
- The pair token is the sole authentication for the receiver. Regenerating it from the desktop app invalidates the previous one.
- No analytics, telemetry, or remote logging. Sync events are written to `chrome.storage.local` only.

---

## Permissions explained

| Permission | Why |
|---|---|
| `storage` | Persist pair token, last-sync log, per-conversation `updated_at` cache. |
| `alarms` | 5-minute background sync tick (only when Auto-sync is on). |
| `declarativeNetRequestWithHostAccess` | Rewrite `Origin` / `Referer` on requests to claude.ai and chatgpt.com so their APIs treat the extension's XHRs as same-origin. |
| `host_permissions: claude.ai`, `*.claude.ai` | Fetch your conversations from Claude.ai. |
| `host_permissions: chatgpt.com`, `chat.openai.com` | Fetch your conversations from ChatGPT. |
| `host_permissions: 127.0.0.1:54330` | POST conversations to the local desktop receiver. |

No `<all_urls>`, no content scripts, no `tabs`, no `webRequest`.

---

## Terms of service

You should know:

- **Anthropic** Consumer Terms §3.7 prohibits accessing claude.ai "through automated or non-human means … except via an Anthropic API key."
- **OpenAI** Consumer Terms prohibit "automatically or programmatically extract[ing] data or Output" from ChatGPT.

This extension does both — on **your own** account, against **your own** data. Neither vendor has a published carve-out for self-data export; GDPR/CCPA rights are against the vendor, not via third-party tooling. Use at your own discretion. If you want a strictly ToS-clean path, use each vendor's official export (`Settings → Data Controls / Privacy → Export`) and import the result in the desktop app.

The extension may stop working at any time if either vendor changes their API or tightens bot detection.

---

## Repo layout

```
manifest.json              MV3 manifest
rules.json                 declarativeNetRequest rules (header rewriting)
background.js              Service worker — alarm + message router
lib/
  claude.js                Claude.ai sync logic
  chatgpt.js               ChatGPT sync logic
  discover.js              Lightweight metadata listing for the picker UI
  net.js                   getJson() — pacing + 429/503 retry
  vault.js                 POST to local receiver
popup/
  popup.{html,css,js}      Toolbar popup: pair, ping, auto-sync toggle
progress/
  progress.{html,css,js}   Fullscreen picker + live progress log
icons/                     128 / 48 / 16 px PNGs
```

---

## Development

There is no build step — the extension is plain ES modules, loaded directly by Chrome's MV3 runtime.

```bash
# Edit any file, then click "Reload" on the chrome://extensions card.
# To inspect the service worker logs:
#   chrome://extensions → 1AIVault Sync → "service worker" link
# To inspect the popup logs:
#   right-click the extension icon → Inspect popup
```

### Common errors

| Symptom | Cause / fix |
|---|---|
| `claude conversations: …: 403` | Cloudflare rejected the request. Reload the extension after enabling the `declarativeNetRequest` rules (manifest change requires a full reload). |
| `not paired — open the popup and paste your token` | Pair token missing. Copy it from the desktop app's Settings → General → Browser extension. |
| `Not reachable` in the popup | Desktop app is not running, or its loopback receiver is bound elsewhere. Start the app and click **Test**. |
| Conversations not updating | Check the cache: `chrome.storage.local.get(null)` in the service worker console. Each entry under `claude:<uuid>` / `chatgpt:<id>` is the cached `updated_at`. Delete those keys to force a re-sync. |

---

## Contributing

Issues and PRs welcome at <https://github.com/stoicsoft/1AIVault-Extension>. Please keep changes small and tightly scoped — the extension intentionally avoids dependencies, build tooling, and any code that runs in a page context.

If you're filing a sync issue, please include:

- Browser + version
- Service-worker console log (full sync session)
- Whether the 1AIVault desktop app's receiver responds to `curl http://127.0.0.1:54330/v1/ping`

---

## License

MIT © StoicSoft. See [LICENSE](LICENSE).
