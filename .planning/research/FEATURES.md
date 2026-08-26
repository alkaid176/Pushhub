# Features Research

**Project:** PushHub — Webhook 实时通知 + 群聊回复系统
**Dimension:** Features (competitor landscape)
**Researched:** 2026-08-26
**Overall confidence:** HIGH (7/8 competitor data from first-party official docs fetched directly; Telegram Bot API details cross-verified via search, MEDIUM)

---

## Competitor Matrix

| Capability | ntfy | Bark | Gotify | Server酱 (Turbo) | PushDeer | Telegram Bot | Slack Webhook | Discord Webhook |
|---|---|---|---|---|---|---|---|---|
| **Hosting model** | SaaS + self-host | App + self-host server | Self-host | SaaS only | SaaS + self-host (unmaintained) | SaaS | SaaS | SaaS |
| **Channel model** | Topic (created on the fly, topic = password) | Key per device | Application (per-user) | SendKey per user | PushKey per user | chat_id | URL per app+channel | URL per webhook |
| **Payload fields** | title, message, tags[], priority, click, icon, actions[], delay | title, subtitle, body, sound, group, url, icon, level | title, message, priority, extras{} | title (32 chars), desp (md 32KB), short, channel | text, desp, type | text, parse_mode, reply_markup | text, blocks[], attachments[] | content, embeds[] |
| **Markdown** | Opt-in (header/content-type); **web app only** | None (plain text) | Yes (web UI default; `extras client::display contentType: text/markdown` for clients) | Yes (desp, 32KB) | Yes (type=markdown, default) | Yes (parse_mode MarkdownV2/HTML, strict escaping) | mrkdwn (proprietary, not standard md) | Discord-flavour md |
| **Priority levels** | 5 (min→urgent, named + numeric) | 4 iOS interruption levels (active/timeSensitive/passive/critical) | int 0–10 | None | None | None | None | None |
| **Per-message buttons** | Yes: up to 3 actions (view/http/broadcast/copy), client-side execution | None | None | None | None | Yes: InlineKeyboardMarkup, unlimited rows (callback_data ≤64B or url) | Yes: Block Kit buttons, but clicks route to parent app | Only for application-owned webhooks |
| **Two-way (reply back to sender)** | Partial: http action fires one-shot HTTP from device; no identity, no free text | None | None | None | None | **Full** (callback_query + free-text messages) | Only via full app (Interactivity Request URL) | Only via application-owned webhook |
| **Callback receiver registration** | Per-action URL embedded in message | n/a | n/a | n/a | n/a | Pre-registered: setWebhook (per-bot) | Pre-registered: per-app Request URL | Pre-registered: owning application |
| **History/retention** | 12h cache default (self-host configurable; `Cache: no` opt-out) | On-device archive only (isArchive) | Persistent DB until manually deleted | 1 day free / 3 days paid | Message list API (≤100) | Telegram cloud, effectively forever | None via webhook (no delete either) | Edit/delete own messages via token |
| **Offline catch-up** | `since=` replay from cache; `poll=1` | None server-side | Yes (persistent DB + WS) | Message list page | Message list API | Client-side (cloud history) | n/a | n/a |
| **Multi-client same channel** | Yes: many devices subscribe same topic = broadcast group (no member identity) | One key = one device | Yes: all clients of a user | Per-user, multi-device via channel routing | Per-user devices + multi-key push | Native (account multi-device + groups) | Channel = many viewers | Channel = many viewers |
| **Realtime transport** | WS / SSE / JSON stream / raw / polling | APNs push | WebSocket `/stream/websocket` | Vendor push (WeCom/WeChat) | Vendor push | Vendor push + WS-poll | n/a (pull) | n/a (pull) |
| **Key/token management** | Access tokens (tk_...), per-topic ACL, basic auth, query-param auth | Key in URL, copy from app | App token (send) vs Client token (receive); rotation; shown once | Single SendKey, per-channel routing | Key gen/rename/regen/remove API + device registry | Single bot token | Secret URL (revocable via app config) | Secret URL + token endpoints |
| **Free-tier quota** | ntfy.sh: 250 msg/day/visitor, 30 connections | Self-host unbounded | Self-host unbounded | 5 msg/day free | Self-host unbounded (10 keys/push online) | Bot API free | Free with app | Free |
| **Notable extras** | Scheduled delivery, dead-man's-switch (sequence_id), message update/clear/delete, Go-template webhook formatting (GitHub/Grafana/Alertmanager), email/phone-call fan-out, attachments, UnifiedPush, Matrix gateway | Encrypted push (AES ciphertext), critical alerts, scheduled sending, Windows client, CLI | Multi-user, REST admin, extras for client behavior | Multi-channel routing (one request, many possible receivers), 2000+ OSS integrations | App Clip zero-install iOS, IoT devices | editMessageText, answerCallbackQuery, inline mode | Block Kit, threads (thread_ts) | wait=true returns message, Slack/GitHub-compatible endpoints |

Sources: docs.ntfy.sh (publish + subscribe API pages, fetched 2026-08), github.com/Finb/Bark, gotify.net/docs, sct.ftqq.com, github.com/easychen/pushdeer, api.slack.com/messaging/webhooks, discord.com/developers/docs/resources/webhook, core.telegram.org/bots/api (search-corroborated).

---

## Table Stakes Features

Users of this category expect these. Missing any of 1–7 makes the product feel broken; 8–11 are "expected by power users."

| # | Feature | Why Expected | Complexity | Notes |
|---|---|---|---|---|
| 1 | Simple POST send API with key auth | Every competitor is a one-line curl/fetch | Low | `POST /send` with `Authorization: Bearer <SendKey>`; validate and return structured errors (Slack-style error codes are praised) |
| 2 | Title + body separation in payload | ALL 7 products separate title from body; title is the notification headline | Low | PushHub draft payload lacks `title` — add it. ntfy/Gotify/ServerChan prove it is non-negotiable |
| 3 | Markdown body rendering (default on) | Server酱, Gotify, Telegram, PushDeer all render md; only ntfy makes it opt-in (and web-only — a weakness) | Medium (per-client renderer) | Default-on simplifies senders vs ntfy's opt-in; sanitize HTML from md (XSS in web SDK context) |
| 4 | Sub-2s realtime delivery | ntfy/Gotify instant; notification is only useful if immediate | Medium | DO + WebSocket fan-out already planned |
| 5 | Offline catch-up (missed message replay) | ntfy `since=`, Gotify persistent DB, PushDeer/ServerChan message lists; a reconnecting client that loses messages feels broken | Medium | Follow ntfy precedent: client sends last seen message_id / timestamp, server replays from DO storage |
| 6 | Key management UI: create / reset / revoke | Gotify rotation, PushDeer regen, ntfy token page | Low-Medium | Already in Active requirements; per-key reset is the differentiating twist |
| 7 | Message size limit + clear validation errors | ntfy 4KB, Telegram 4096 chars, ServerChan 32KB; limits exist everywhere | Low | Pick a limit (e.g., 32KB body), enforce, document, return descriptive error codes |
| 8 | Notification priority levels (2–3) | ntfy 5 levels, Bark 4, Gotify 0–10; alerting users need "this one wakes me up" | Low (API) / Medium (client mapping) | 3 named levels (low/normal/high) sufficient; map to Android notification channels, Windows toast scenarios |
| 9 | Click-through URL on message | ntfy `Click`, Bark `url`, ServerChan `short` — "view details" pattern | Low | Cheap to add, high sender value |
| 10 | Web management console | Gotify WebUI, ntfy web app, PushDeer key pages | Medium | Already planned (管理页) |
| 11 | Multi-client receive on same channel | ntfy multi-device topic; Gotify multi-client user; this IS the group-chat substrate | Medium | Already planned via DO fan-out |

---

## Differentiator Features

Features no competitor combination currently offers. These are PushHub's reason to exist beyond "yet another ntfy."

### D1. Sender-supplied quick-reply options per message
- **Value:** Telegram's inline keyboards prove the UX; ntfy proves self-hosters want it (its `http` action is the most-requested workaround pattern) — but ntfy actions are client-side one-shots with no identity and no free text. PushHub's model (sender sends `options: ["确认","忽略"]`) is Telegram-grade UX without running a bot.
- **Complexity:** Medium (payload schema trivial; client button rendering per platform is the work)
- **Depends on:** message model with `message_id`; reply relay (D3); answered-state sync (D4)
- **Convention to copy:** cap options at 4 (ntfy caps actions at 3; Telegram rows are 2–3 buttons wide)

### D2. Group channel via shared Channel Key + light member identity
- **Value:** ntfy topics are implicit groups with zero member identity ("someone" reacted). Telegram groups need accounts. PushHub: same Channel Key = same group, plus a display name per client connection = team alert-group semantics with zero registration.
- **Complexity:** Low (identity is just a label sent at connect; no auth backend)
- **Depends on:** channel model; WS connection metadata
- **Watch:** do NOT let member naming drift into accounts (see Anti-features)

### D3. Callback URL delivery of replies to the ORIGINAL sender system
- **Value:** THE unoccupied niche. Verified across all 8: Telegram callbacks go to a pre-registered bot webhook; Slack to a pre-registered app Request URL; Discord to an owning application; ntfy http actions fire from the phone with no reply context. **Nobody lets the sender attach a fresh callback_url per message.** This is the Stripe-webhook model applied to notifications, and it means an automation script with zero always-on server can still close the loop.
- **Complexity:** Medium (server-side POST + retry policy + timeout; needs callback attempt state in DO storage for retry without blocking the reply)
- **Depends on:** message_id persistence; reply API
- **Design guidance from analogs:** POST structured JSON `{message_id, reply_text or selected_option, replier_name, replied_at, channel_id}`; document retry (e.g., 3 attempts with backoff); return delivery status on a `GET /messages/:id/callback-status` endpoint so senders can poll fallback (Telegram's answerCallbackQuery ack pattern)

### D4. Answered-state propagation (all clients see that a message was answered)
- **Value:** Telegram's editMessageText-after-callback is the gold standard: everyone watches the message update to "Alice chose 确认". ntfy has message_clear/message_delete events for the same reason. Without this, group chat devolves into everyone answering the same alert.
- **Complexity:** Medium (a new server→client event type; UI state per message)
- **Depends on:** reply relay; DO broadcast

### D5. Free-text reply (in addition to options)
- **Value:** Only Telegram offers free-text reply today. For approval workflows ("deny because X") it is essential.
- **Complexity:** Medium (client input UI; markdown echo back into channel)
- **Depends on:** D1 message model; D3 callback

### D6. Three-tier key hierarchy (Admin / Send / Channel) with independent reset
- **Value:** Gotify splits send-token vs receive-token (closest analog) but has no admin tier and no per-tier blast-radius isolation. Real trust boundary: cron script only ever holds the Send Key.
- **Complexity:** Low-Medium (KV schema + middleware; no crypto work)
- **Depends on:** key management UI (table stakes #6)

### D7. Zero-dependency embeddable web SDK (`<script src="pushhub.js">`)
- **Value:** ntfy has a web app, not an embeddable SDK; none of the 8 ship a drop-in receiver widget. Unlocks "notification channel inside any internal tool page".
- **Complexity:** Low-Medium (one file, WS + REST + minimal DOM renderer; must stay framework-free)
- **Depends on:** WS protocol; history REST endpoint; reply endpoint (CORS handling)

### D8. Zero-cost serverless hosting (Cloudflare Workers free tier)
- **Value:** ntfy/Gotify self-host need a VPS + TLS + maintenance; PushDeer self-host needs annual push-cert renewal (and is now unmaintained — a cautionary tale). `wrangler deploy` is the lowest-friction self-host story in the category.
- **Complexity:** Low (already the architecture decision) — but DO storage caps mean history retention must be bounded (see pitfalls/implications)

---

## Anti-Features

Deliberately NOT building, with the warning that each will be requested.

| Anti-Feature | Why Avoid | What To Do Instead | Warning |
|---|---|---|---|
| File/image attachments | ntfy/Bark/Slack/Discord have them; requires blob storage (R2 = extra service + quota risk) and multi-client download paths; PROJECT.md already excludes | Markdown image links `![](url)` — sender hosts the file, PushHub renders the link | Highest-frequency feature request incoming; hold the line until post-v1 |
| User accounts / registration | PushDeer and Server酱 built logins (Apple/WeChat) — friction + PII + the unmaintained PushDeer shows account systems rot. Key-as-identity is the differentiator | Channel Key + display name (D2) | Member management requests will try to reintroduce accounts via the back door |
| E2EE | Bark does AES-encrypted push; but PushHub's callback_url means the server must read reply content to relay it — E2EE is architecturally contradictory with D3 | HTTPS transport (already); document the trust model honestly | Do not claim "private like Bark" in marketing; the relay sees payloads |
| Read receipts / message recall | PROJECT.md out of scope; per-member read state multiplies sync traffic for near-zero sender value | Answered-state (D4) covers the real need | Group-chat users will ask; D4 is the answer, not read receipts |
| Email / SMS / phone-call fan-out | ntfy offers all three; every one needs paid third-party providers — violates the zero-cost constraint hard | Sender systems can fan out themselves; PushHub stays realtime-chat-shaped | "Just one SMTP option" is a trojan horse (ntfy's email pipeline is a major abuse surface — they had to gate it) |
| Scheduled delivery / message templating | ntfy has both (delay + Go templates); sender systems (cron, GitHub Actions, ntfy-compat scripts) already have schedulers; server-side scheduling burns Workers free quota while idle-waiting | Document "schedule on the sender side" | Tempting parity feature; skip in v1 |
| FCM / APNs vendor push integration | Every mobile competitor uses it; requires Google/Apple developer credentials, and Apple requires a Mac (project constraint: none) | Android foreground-service persistent WS (planned); iOS via web SDK in Safari (planned) | This is a conscious battery-life tradeoff vs ntfy/Bark — document it, don't hide it |
| Public multi-tenant SaaS hardening | Rate-limit tiers, abuse quotas, signup abuse (Server酱's 5/day free limit exists because of this) eat complexity without serving the personal/small-team target | Per-key basic rate limiting only; free-tier request caps act as natural limits | If PushHub ever goes public-SaaS, this becomes a milestone of its own |
| Matrix gateway / UnifiedPush | ntfy carries both; deep protocol coupling for tiny audiences | Standard WebSocket + JSON only | n/a |

---

## Feature Dependencies Graph

```
Key system (Admin/Send/Channel) ──────────────┐
  │                                            │
  v                                            v
Admin UI (key CRUD)                     Send API (POST /send)
                                                │
                                                v
                                    Message model (id, title, md body,
                                    options[], callback_url?, priority?)
                                       │              │            │
                                       v              │            │
                              Channel (DO instance)   │            │
                                       │              │            │
                          ┌────────────┼──────────┐   │            │
                          v            v          v   │            │
                   WS fan-out     History store  Answered-state  (offline)
                   (multi-client) (DO SQLite)    events          catch-up
                          │            │          ▲               │
                          v            │          │               v
                   Client render  <────┼──── reply event ←── since= replay
                   (md + buttons)      │          ▲
                          │            │          │
                          v            v          │
                    Reply UI ──► Reply API ──► Callback relay ──► sender's
                   (option /      (auth by       (POST + retry,   callback_url
                    free text)     Channel Key)   status tracking)
```

Hard ordering constraints:
1. Key system before Send API before Admin UI content (UI manages what API authenticates with).
2. Message model (with message_id + options) before any reply work — replies reference messages.
3. History store before offline catch-up; both before "reliable product" claims.
4. Reply API before callback relay (relay needs a reply event to trigger).
5. Web SDK last: it is a thin client of WS + REST surface; building it early means rebuilding it on every protocol change.

---

## Implications for PushHub v1

**Payload schema recommendation (from cross-product conventions):**
Adopt `title` as a separate required-or-optional field (universal across all 8); keep `text` as the markdown body, markdown ON by default (differentiates from ntfy's opt-in web-only rendering); keep `options?: string[]` capped at 4 (ntfy caps 3 actions; Telegram rows are 2–3); keep `callback_url?: string`; consider `click_url?` and `priority?: "low"|"normal"|"high"` as cheap table-stakes additions. The reply→callback payload should echo `message_id`, the selected option or free text, replier display name, and timestamp — because ntfy's http action (no identity, no context) is the documented pain point, and Telegram's 64-byte callback_data limit (IDs-not-payloads) shows why structured server-side relay beats cramming state into buttons.

**Phase-sequencing implications:**
1. Core send→fan-out→render loop with title/body/markdown first (validates the ntfy-equivalent baseline).
2. Keys + admin UI early (everything authenticates through them; D6 is cheap if built before clients hardcode assumptions).
3. History/offline replay before public use (every competitor has it; reconnect data loss is the #1 "feels broken" failure).
4. Reply chain (options → reply API → answered-state → callback relay) as the flagship phase — it is the differentiator and the riskiest integration surface; prototype the callback retry semantics against a real automation script early.
5. Web SDK after the protocol stabilizes.
6. Priority levels + click_url are small, can ride along any client phase.

**Open items needing phase-level verification (flagged MEDIUM/LOW confidence):**
- Durable Objects SQLite storage ceiling per DO instance and per-account (drives history retention window; unverified here — check CF docs in stack research).
- Telegram Bot API exact limits (4096-char text, 64-byte callback_data, MarkdownV2 escaping rules) are MEDIUM confidence from search corroboration; if the reply UX spec copies Telegram patterns, verify against core.telegram.org/bots/api directly during that phase.
- Bark `isArchive`/`autoCopy`/`badge` field specifics from the full bark.day.app docs (only README verified).
- Gotify recent versions may have added built-in message-auto-deletion config (search suggests historically cron-based; unverified).

## Sources

- ntfy publish + subscribe API — https://docs.ntfy.sh/publish/ , https://docs.ntfy.sh/subscribe/api/ (HIGH, official, fetched 2026-08)
- Bark — https://github.com/Finb/Bark (HIGH, official repo)
- Gotify — https://gotify.net/docs/pushmsg , https://gotify.net/docs/msgextras (HIGH, official)
- Server酱 — https://sct.ftqq.com/ + docs summary (HIGH, official)
- PushDeer — https://github.com/easychen/pushdeer (HIGH, official; note: project unmaintained per README)
- Telegram Bot API — https://core.telegram.org/bots/api (MEDIUM, search-corroborated, not full-doc fetched)
- Slack incoming webhooks — https://api.slack.com/messaging/webhooks (HIGH, official)
- Discord webhooks — https://discord.com/developers/docs/resources/webhook (HIGH, official)
