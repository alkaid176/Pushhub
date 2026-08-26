# Architecture Research — PushHub

**Domain:** Cloudflare Worker + Durable Object realtime webhook-notification / group-chat system
**Researched:** 2026-08-26
**Mode:** Ecosystem (architecture dimension)
**Overall confidence:** MEDIUM-HIGH (official Cloudflare demo source read directly = HIGH; CF docs findings cross-checked = MEDIUM; client-side patterns = MEDIUM)

Primary anchor: full source of the official [cloudflare/workers-chat-demo](https://github.com/cloudflare/workers-chat-demo) (`src/chat.mjs`) was read directly — the canonical CF reference for "chat over Durable Objects". All server-side patterns below trace to it or to current CF docs.

---

## System Overview

```
                        ┌──────────────────────────────────────────────────────────────┐
                        │                 Cloudflare Worker (pushhub)                  │
                        │  Stateless entry: routing, key auth, static assets           │
                        │                                                              │
  Webhook sender ──POST─┼─▶ /api/send          (Send Key in Authorization header)     │
  (script / CI / bot)   │     │ verify Send Key via KV (cacheTtl 60s, edge-cached)    │
                        │     │ resolve channelId: KV ch:<send_key> → channelId       │
                        │     ▼                                                      │
                        │  env.CHANNELS.idFromName(channelId).fetch(...)  ────────────┼──┐
                        │                                                              │  │ internal
  Admin browser ────────┼─▶ /api/admin/*       (Admin Key = Worker secret)            │  │ DO fetch()
  (management page)     │                                                              │  │ (trusted,
                        │  Static Assets (free, unlimited):                            │  │  not public)
                        │   /            admin SPA                                    │  │
                        │   /pushhub.js  web SDK (single file)                        │  │
                        └──────────────────────────────────────────────────────────────┘  │
                                                                                        ▼
                        ┌──────────────────────────────────────────────────────────────┐
                        │            Channel Durable Object (one per channel)         │
                        │            id = idFromName(channelId) — immutable           │
                        │                                                            │
                        │  • Hibernating WebSockets (acceptWebSocket + tags)          │
                        │  • Fan-out broadcast to all members                         │
                        │  • SQLite history (messages + replies + callback status)    │
                        │  • Outbound fetch(callback_url) on reply (fire & track)     │
                        │  • Alarm-based callback retry queue                          │
                        │  • Retention compaction (alarm)                             │
                        └────────────┬───────────────────────────────┬────────────────┘
                                     │ WebSocket (WSS)               │ outbound POST
                                     ▼                               ▼
                     ┌──────────────┬──────────────┬─────────┐   sender's callback_url
                     │ Tauri 2      │ Android      │ web     │   (their server)
                     │ Rust core WS │ Foreground   │ pushhub │
                     │ + tray +     │ Service +    │ .js     │
                     │ notification │ OkHttp WS    │ (pure)  │
                     └──────────────┴──────────────┴─────────┘
```

One Worker script owns three planes: **API plane** (`/api/*`), **static plane** (admin SPA + pushhub.js via Workers Static Assets), and the **DO namespace** (channels). Everything lives on one `workers.dev` (or custom) domain — no CORS, no second product.

---

## Component Breakdown

### Server: Worker entry (stateless router + auth gate)

| Responsibility | Detail |
|---|---|
| Route `/api/send` | Verify Send Key → resolve channelId → forward payload to DO via stub fetch |
| Route `/api/ws/:channelKey` | Verify Channel Key (KV) → forward WS upgrade to DO with verified identity header |
| Route `/api/admin/*` | Verify Admin Key (Worker secret, `wrangler secret put ADMIN_KEY`) → KV CRUD on keys; reset additionally pings the DO to kick sessions |
| Serve static assets | Admin SPA at `/`, `pushhub.js` served as asset — free, unlimited, no Worker invocation |
| Never holds state | No memory between requests; all state in KV + DOs |

Evidence: the official demo's Worker does exactly this stateless routing — parse path, `idFromName(name)` (≤32 chars) or `idFromString(64-hex)`, `env.rooms.get(id)`, rewrite URL, `roomObject.fetch(newUrl, request)`. Confidence: HIGH (source read).

**Routing decision — idFromName(immutable channelId), NOT idFromName(channel key):**
`idFromName(x)` is deterministic; routing directly on the public Channel Key would work, **but a key reset would derive a different DO id and orphan all history**. Therefore KV stores `ch:<channel_key> → { channelId, name, ... }` and the DO is always addressed by the immutable `channelId` created once at channel creation. Key reset = rewrite the KV pointer; the DO (and its history) is untouched. This is the one place the KV-key→DO-id mapping indirection earns its keep.

### Server: Channel Durable Object (one per channel = one group)

| Responsibility | Detail |
|---|---|
| WebSocket termination | `WebSocketPair` + `state.acceptWebSocket(ws, [tags])` → hibernation: DO unloads from memory while sockets stay open; wakes on message |
| Session metadata | `ws.serializeAttachment({ clientId, name, connectedAt })` — survives hibernation; restore in constructor via `state.getWebSockets()` + `deserializeAttachment()` |
| Fan-out | On new message: `for (const ws of this.state.getWebSockets()) ws.send(envelope)` — prune sockets that throw |
| History | SQLite table `messages`; catch-up query `WHERE id > ?since ORDER BY id LIMIT n` |
| Reply handling | Validate → persist → broadcast answered-state → fire callback POST (promise kept alive; DO stays active during pending I/O — `waitUntil` NOT needed in DOs) |
| Callback retry | Failed callbacks recorded in SQLite `pending_callbacks`; DO `alarm()` retries with backoff |
| Retention | Alarm-driven compaction: `DELETE FROM messages WHERE id < max(id) - 500` (or age-based) |
| Rate limiting (optional) | Per-connection simple in-memory counter; official demo uses a separate RateLimiter DO keyed by IP — overkill for v1 |

Hibernation limits (official docs): max **1 MiB per message**, **32,768 simultaneous sockets per DO** — far beyond PushHub scale (a group is tens of clients). Hibernation only applies when the DO is the WS *server* (PushHub's case). Confidence: MEDIUM (docs, cross-checked).

Free-tier fit (2025-04 changelog + pricing docs): DOs on Workers Free = ~100k DO requests/day, 13k GB-s duration/day. Hibernating sockets make idle duration ≈ 0 (this is *the* reason to use the Hibernation API — with plain WebSockets an idle DO burns duration 24/7 and the 13k GB-s/day budget dies within hours). Confidence: MEDIUM.

### Server: KV namespace (key registry only)

| Key | Value | Purpose |
|---|---|---|
| `ch:<channel_key>` | `{ channelId, name, createdAt }` | Channel Key verification + key→DO routing |
| `sk:<send_key>` | `{ channelId }` | Send Key verification (a Send Key may target exactly one channel) |
| (index) `id:<channelId>` | `{ channelKey, sendKey, name }` | Reverse index for admin listing & reset (old-key cleanup) |

Only admin operations write KV. Free tier: 100k reads/day (and hot reads are edge-cached for 60s `cacheTtl` default, min 30s — cached reads don't count against quota), 1k writes/day — key CRUD is nowhere near that. Confidence: MEDIUM.

**KV vs DO SQLite for keys:** KV wins for the verification *path* (edge cache = ~free, reads from any Worker invocation without waking a DO). A singleton "registry DO" (CF docs mention this pattern for room lists) would add a serialization point and consume DO requests for every verification. Do NOT put the hot verification path on a DO.

Key revocation propagation: KV writes propagate globally in **up to 60s** (edge cache expiry). Acceptable for PushHub: a revoked Channel Key could still connect for ≤60s via a stale edge cache. For immediate revocation, Admin reset also calls the DO's internal `/kick-all` endpoint — existing sessions die now; only *new* handshakes have the 60s window. Document this; it is a non-issue at v1 threat model.

### Server: Static assets

Workers Static Assets (not Pages — Pages is in maintenance-first mode; CF's own guidance migrates Pages→Workers). Asset requests are **free and unlimited** and don't invoke the Worker. Config: `[assets] directory=./public, run_worker_first = ["/api/*"]` so API paths always hit the Worker; SPA fallback via `not_found_handling = "single-page-application"` if admin is an SPA (or just ship plain files — admin page is small enough to be one HTML file + pushhub.js). Confidence: MEDIUM (docs).

### Desktop client: Tauri 2 (Windows)

**Architecture: WS connection lives in the Rust core, not the webview.**

| Piece | Choice | Why |
|---|---|---|
| WS + reconnect | Rust, `tokio` + `tokio-tungstenite`, exponential backoff + jitter | Connection must survive **window close** (tray-only mode). A webview `WebSocket` dies with the window; a Rust task in the Tauri process keeps running |
| Core → UI | `app_handle.emit("ph:message", payload)` → frontend `listen()` | Official Tauri pattern; window becomes an optional consumer of the connection |
| Tray | `tray-icon` plugin | Resident entry, show-window on message |
| Notifications | `tauri-plugin-notification` (or `notify-rust` in core — decide in phase research; core-side works even with window closed) | Windows native toasts |
| History | Rust-side small SQLite (or in-memory; server is source of truth) | Keep v1 thin: fetch `since=` on start, cache in memory, persist optionally |
| Reply UI | Webview window (Markdown render of message, option buttons + free-text) | Matches PROJECT.md message model |

The middle-ground `tauri-plugin-websocket` (Rust client, JS API) still drives from JS and doesn't fix the window-close problem. Confidence: MEDIUM (Tauri v2 docs/plugin landscape; pattern widely used).

### Android client: native Kotlin

| Piece | Choice | Why |
|---|---|---|
| Connection owner | `Service` with `foregroundServiceType="dataSync"` + persistent notification channel | Only reliable way to hold a socket in background post-Doze; Android 13+ requires FOREGROUND_SERVICE permission + typed declaration |
| WS client | OkHttp `WebSocket`, `pingInterval(30s)` | Built-in heartbeat detects half-dead connections |
| Reconnect | `onFailure` → backoff; `ConnectivityManager.NetworkCallback` → reconnect on network available | Standard pattern |
| Local cache | Room (messages table, key = server message id) | Offline UI + instant cold start; server `since=` cursor still authoritative |
| Notifications | `NotificationChannel` per channel-key + Markdown-to-styled text | Quick-tap reply options as notification actions (v1: tap-to-open; Direct Reply/RemoteInput can be v2) |
| Process death | Service restarted by START_STICKY; re-pull `since=` from Room's max id | Catch-up converges |

Known risk to flag for phases: Chinese OEM battery managers (MIUI/HarmonyOS etc.) kill foreground services regardless — app needs a "whitelist me" onboarding hint. Confidence: MEDIUM (community + Android docs patterns).

### Web SDK: pushhub.js (single file, zero deps)

```js
const hub = new PushHub("https://pushhub.example.workers.dev", "ch_key_xxx");
hub.on("message", (m) => { ... });     // render markdown
hub.on("reply", (r) => { ... });       // someone answered
hub.reply(messageId, { option: "确认" }); // or { text: "..." }
hub.connect();                          // auto-reconnect with backoff + since-cursor catch-up
```

Implementation notes: browser `WebSocket` (no custom headers possible — see auth below), Markdown rendering left to the embedder or a tiny built-in formatter (keep zero-dep), reconnect = close event → setTimeout backoff → new WS → server replays missed via `since`. The SDK is a natural fit to be served *from the Worker itself* as a static asset (same origin as its default server URL → zero config).

---

## Data Flows

### 1. Send flow (webhook → clients)

```
POST /api/send  { text, options?, callback_url? }
  Authorization: Bearer <Send Key>
   │
   ▼ Worker
   1. KV get "sk:<send_key>" {cacheTtl:60} → channelId  (miss → 401)
   2. stub = CHANNELS.idFromName(channelId); stub.fetch("https://do/publish", POST json)
   │
   ▼ Channel DO (wakes if hibernating)
   3. Validate/normalize (length caps, options ≤ 10, callback_url scheme https?)
   4. INSERT INTO messages (...); id = last_insert_rowid (monotonic cursor)
   5. Broadcast to all hibernating sockets:
        for ws of state.getWebSockets(): ws.send({type:"message", ...})
      (prune sockets that throw — demo's `quitters` pattern)
   6. Respond 200 { id, created_at } → Worker → sender
```
Cost: 1 Worker request + 1 KV read (edge-cached) + 1 DO request + N WS messages (DO requests). Budget-safe at personal scale.

### 2. Reply flow (client → callback)

```
client ws.send({type:"reply", message_id, option?|text?})
   │
   ▼ DO webSocketMessage(ws, msg)
   1. Identify sender from ws.getAttachment() (no re-auth needed — socket was authed at upgrade)
   2. Enforce answered-once (message row already has replied_by? → still accept? v1: allow multiple
      members to reply, first reply triggers callback; later replies also forwarded — decide in spec)
   3. UPDATE messages SET replied_by=?, reply_text=?, replied_at=? WHERE id=?
   4. Broadcast {type:"message_state", message_id, replied_by, reply} to all sockets
   5. Callback delivery:
        const p = fetch(callback_url, {method:"POST", body: JSON.stringify(replyPayload)})
                  .then(ok → mark delivered)
                  .catch(→ INSERT INTO pending_callbacks, alarm in 1min)
      p is NOT awaited before responding to sender-side flow; DO stays alive while I/O pending
      (ctx.waitUntil is explicitly NOT for DOs — CF docs)
   6. alarm(): retry pending_callbacks with backoff 1m/5m/30m → give up + mark failed
```
Subrequest budget: free plan = 50 external subrequests/invocation — a reply triggers 1 callback; even a burst of replies stays far under. Retries run in alarm invocations (fresh budget). Confidence: MEDIUM (docs).

### 3. History / catch-up flow

```
WS connect → auth ok → client sends {type:"sync", since: <last known id> | null}
   │ null → last 100 messages (new member / first run)
   │ id   → SELECT ... WHERE id > ? ORDER BY id ASC LIMIT 200  (keyset pagination)
   ▼
{type:"history", messages:[...], latest: <max id>}   (possibly multiple batches)
then live {type:"message"} events resume.
```
Keyset on monotonically increasing integer id is the pattern CF's own docs/examples use for SQL-backed DOs (result sets are cursors; avoid OFFSET). No gap/dup risk: DO is single-threaded — the sync query and subsequent inserts serialize naturally.

### 4. Reconnect flow (all clients)

```
disconnect → client backoff (1s,2s,4s.. max 60s, jitter) → reconnect → auth → sync since=<last id>
```
Server never tracks "offline clients"; catch-up is purely cursor-based. Idempotent by design: if a message arrives both via replay and live (race between sync query and broadcast), client dedups on message id.

---

## Storage Design

### KV namespace `pushhub_keys` (1GB free, plenty)

| Key | Value (JSON) | Written by |
|---|---|---|
| `ch:<channel_key>` | `{ channelId, name, createdAt }` | Admin create/reset |
| `sk:<send_key>` | `{ channelId }` | Admin create/reset |
| `id:<channelId>` | `{ channelKey, sendKey, name, createdAt }` | Admin create/reset (reverse index for list/reset cleanup) |

Read path always `{ cacheTtl: 60 }` (default; cached reads are free). Keys are generated server-side: `crypto.randomUUID()` or 32-char base62 — unguessable is the security model (keys ARE the auth).

### Channel DO SQLite (per-channel database)

```sql
CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,  -- cursor
  wid           TEXT NOT NULL,                      -- server-side nanoid exposed to clients (unguessable message id for callback dedup)
  sender        TEXT,                               -- 'webhook' (v1: no sender identity beyond channel)
  text          TEXT NOT NULL,                      -- markdown
  options       TEXT,                               -- JSON array string or NULL
  callback_url  TEXT,                               -- or NULL
  replied_by    TEXT, replied_text TEXT, replied_at INTEGER,  -- first/last reply snapshot
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

CREATE TABLE IF NOT EXISTS pending_callbacks (
  message_id    INTEGER NOT NULL,
  callback_url  TEXT NOT NULL,
  payload       TEXT NOT NULL,                      -- exact body to POST
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_try_at   INTEGER NOT NULL,
  last_error    TEXT
);
```

Queries: catch-up `SELECT ... WHERE id > ?1 ORDER BY id ASC LIMIT 200`; recent `SELECT ... ORDER BY id DESC LIMIT 100` then reverse; compaction `DELETE FROM messages WHERE id <= (SELECT MAX(id)-500 FROM messages)` run by weekly alarm + `PRAGMA` housekeeping not needed (SQLite in DO is managed).

Retention rationale: free DO storage is limited (reported 5GB/account across DOs — verify at deploy); 500 messages/channel × small text rows = a few hundred KB per channel. Configurable later. DO storage is transactional + instantly consistent (vs KV's 60s) — correct choice for message history. Confidence: MEDIUM.

---

## Message Protocol (JSON over WS + HTTP)

All frames are JSON with a `type` discriminator. Kept deliberately minimal — the official demo ships untyped `{name, message, timestamp}` frames plus `{joined}/{quit}/{error}/{ready}` control events and nothing more.

### Server → client

```jsonc
// connection accepted after auth
{ "type": "hello", "channel": "alerts", "you": "client-7f3a", "latest": 1042 }

// webhook message arrived
{ "type": "message", "id": "m_nanoid", "seq": 1043, "text": "**部署完成** ✅", 
  "options": ["确认", "重试", "忽略"], "callback": true, "created_at": 1724600000000 }

// another member replied (also how the sender's own client sees group activity)
{ "type": "reply", "message_id": "m_nanoid", "by": "client-9c2d",
  "option": "确认", "text": null, "at": 1724600030000 }

// answered-state broadcast (for UI to freeze the option buttons)
{ "type": "message_state", "message_id": "m_nanoid", "answered": true,
  "replied_by": "client-9c2d", "reply": "确认" }

// catch-up response (batched)
{ "type": "history", "messages": [ /* message+reply merged rows, ASC */ ], "latest": 1042 }

{ "type": "error", "code": "rate_limited", "message": "too fast" }
{ "type": "pong" }
```

### Client → server

```jsonc
{ "type": "sync", "since": 1040 }          // null → last 100
{ "type": "reply", "message_id": "m_nanoid", "option": "重试" }   // or "text": "custom markdown"
{ "type": "ping" }
```

### Auth: how the Channel Key travels on WS connect

Browsers **cannot set custom headers on a WebSocket handshake** (documented limitation driving every auth-pattern article). Options weighed:

| Pattern | Verdict |
|---|---|
| Query param `wss://…/api/ws/:channelKey` | **Chosen.** Over TLS the token isn't interceptable; appears in server logs (own logs — acceptable); Tauri/Android/web uniform; server rejects *at handshake* with 401 — no zombie sockets |
| First-message auth (demo's `blockedMessages` pattern) | Workable but adds queued-state complexity in DO; reject-after-accept wastes a DO wake |
| Sec-WebSocket-Protocol header | Clever but flaky across non-browser clients; skip |

Key nuance: since the channel key is already a path segment (`/api/ws/:channelKey`), it doubles as the routing parameter — the Worker verifies it via KV, derives channelId, then forwards the upgrade to the DO **with a trusted internal header** (`X-PH-Client: ok`). DOs are only reachable through the Worker's binding, so the DO can trust that header. Tauri/Android *could* set headers but web can't — one uniform pattern wins. Confidence: MEDIUM.

### HTTP API

```
POST /api/send                 Authorization: Bearer <Send Key>
  { "text": "md", "options": ["确认","忽略"], "callback_url": "https://…" }
  → 200 { "id": "m_nanoid", "seq": 1043 }   | 401 | 413 (too large) | 429

POST /api/admin/channels       Authorization: Bearer <Admin Key>   → create → { channelKey, sendKey }
GET  /api/admin/channels       → list (from KV id:* index)
POST /api/admin/channels/:id/reset  { "which": "channel" | "send" | "both" } → new keys + DO kick-all
DELETE /api/admin/channels/:id
```

---

## Key Management Flow

```
creation:  Admin → Worker /api/admin/channels
             channelId = nanoid()                      (immutable, forever)
             channelKey = "phc_" + 32 rand, sendKey = "phs_" + 32 rand
             KV put ch:<channelKey>, sk:<sendKey>, id:<channelId>   (prefix-coded, 3 writes)
             DO created lazily on first message (idFromName(channelId))

verify send:  Worker reads sk:<key> {cacheTtl:60}  → cached at edge ≈ free
verify ws:    Worker reads ch:<key> {cacheTtl:60}  → ditto
admin ops:    constant-time compare of Admin Key against Worker secret (no KV read)

reset channel key:
  1. KV: read id:<channelId> → put ch:<newKey> (same channelId), delete ch:<oldKey>, update index
  2. DO: stub.fetch("/admin/kick-all") → every attached socket closed(4001,"key rotated")
  3. Old key window: ≤60s at other edges (KV cache TTL) — stale handshakes may still verify.
     Kicked clients must re-auth with the new key anyway; window is cosmetic at v1 scale.

reset send key: KV only; senders' old key dies within ≤60s; no DO involvement.
```

Independent reset per tier (Admin secret / Send key / Channel key) satisfies the PROJECT.md security requirement: leaking a Send Key never exposes channel control; leaking a Channel Key can't send or administer.

---

## Build Order (dependency-ordered)

| # | Component | Depends on | Rationale |
|---|-----------|------------|-----------|
| 1 | **Server core**: Worker skeleton + Static Assets + KV key model + Channel DO (WS auth-by-path, hibernation, fan-out, SQLite history, sync/since) + `POST /api/send` | nothing | Everything else consumes this contract. Testable with curl + any WS client — no native toolchains unblocked yet |
| 2 | **pushhub.js + test page** | 1 | Cheapest possible E2E validation of the entire protocol in a browser; the SDK *is* the reference client implementation other clients port |
| 3 | **Admin page + key lifecycle** (create/list/reset/delete + kick-all) | 1 | Needed before real clients: you can't configure a client without generated keys; also finalizes the reset-propagation semantics |
| 4 | **Reply + callback delivery** (reply persist, answered-state broadcast, callback POST, pending_callbacks + alarm retry) | 1 (2 to test) | Splits cleanly out of core; needs a live client (web SDK from step 2) to exercise |
| 5 | **Tauri desktop client** (Rust WS core + tray + notifications + reply window) | 1–4 contract | User has proven Tauri 2 experience → fastest native win; reuses protocol validated via web SDK |
| 6 | **Android client** (FGS + OkHttp + Room + notifications) | 1–4 contract | Heaviest toolchain (ADB, OEM quirks); do last so it ports a frozen, battle-tested protocol |

Ordering principle: **freeze the wire contract early** (steps 1–2), then every client is a pure port with zero server changes. Step 4 before clients because replies change the protocol (message_state frames) — clients shouldn't be built against a moving protocol.

Retention/compaction and rate limiting ride along inside step 1 or 4 (alarm handlers) — small, not phase-worthy.

---

## Open Questions (flag for phase research)

1. **DO storage free-tier exact GB cap** — pricing pages suggest 5GB account-level for DO storage on free; verify in dashboard at first deploy. (MEDIUM)
2. **DO alarms on free plan** — docs indicate alarms are generally available with DOs; confirm behavior/limits (min 1 alarm granularity) when implementing retry queue. (MEDIUM)
3. **Multiple replies semantics** — does a second member's reply on an answered message trigger another callback POST, or is callback first-reply-wins? Product decision; affects `messages` UPDATE logic. (spec-level)
4. **Tauri notification route** — `tauri-plugin-notification` vs core-side `notify-rust` (works with window closed). Phase 5 spike. (LOW-MEDIUM)
5. **Android OEM battery whitelisting** — Chinese ROMs (MIUI etc.) kill FGS anyway; needs onboarding UX + documented workaround. Phase 6. (MEDIUM)
6. **WS message counting** — whether each WS frame to a hibernating DO counts as a "DO request" against the 100k/day (believed yes; irrelevant at personal scale but worth confirming for group-size planning). (LOW)

---

## Sources

- [cloudflare/workers-chat-demo (source read directly)](https://github.com/cloudflare/workers-chat-demo) — HIGH
- [Use WebSockets — Durable Objects best practices](https://developers.cloudflare.com/durable-objects/best-practices/websocket/) — MEDIUM
- [WebSocket Hibernation server example](https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/) — MEDIUM
- [Durable Object State API (waitUntil guidance)](https://developers.cloudflare.com/durable-objects/api/state/) + [Workers ctx.waitUntil docs](https://developers.cloudflare.com/workers/runtime-apis/context/) — MEDIUM
- [Workers platform limits (subrequests)](https://developers.cloudflare.com/workers/platform/limits/) — MEDIUM
- [Durable Objects pricing / free tier](https://developers.cloudflare.com/durable-objects/platform/pricing/) + [DO free-tier changelog 2025-04](https://developers.cloudflare.com/changelog/post/2025-04-07-durable-objects-free-tier/) — MEDIUM
- [KV pricing/limits](https://developers.cloudflare.com/kv/platform/pricing/), [How KV works (60s propagation)](https://developers.cloudflare.com/kv/concepts/how-kv-works/), [cacheTtl min 30s changelog](https://developers.cloudflare.com/changelog/post/2026-01-30-kv-reduced-minimum-cachettl/) — MEDIUM
- [SQLite-backed DO Storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) — MEDIUM
- [Static Assets docs](https://developers.cloudflare.com/workers/static-assets/) + [billing (free assets)](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) — MEDIUM
- [Tauri 2 WebSocket plugin](https://v2.tauri.app/plugin/websocket/), [Calling frontend from Rust](https://v2.tauri.app/develop/calling-frontend/) — MEDIUM
- [WebSocket auth patterns (websocket.org guide)](https://websocket.org/guides/authentication/), [Ably guide](https://ably.com/blog/websocket-authentication) — MEDIUM
- Android: [SO background WS](https://stackoverflow.com/questions/78979033/how-to-keep-alive-web-socket-connection-in-background-app), [Ably Android WS topic](https://ably.com/topic/websockets-android), [Reddit FGS discussion](https://www.reddit.com/r/androiddev/comments/y0onje/websockets_in_foreground_service_how_to_maintain/) — MEDIUM/LOW
