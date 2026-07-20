# Copilot Instructions — GitHub Enterprise Budget & AI Credits Manager

Local-only Node.js/Express app that proxies the GitHub Enterprise billing + Copilot APIs and renders a small vanilla-JS SPA. Read this before making any change.

---

## Project Snapshot

- **Runtime:** Node.js 18+ (uses built-in `fetch`)
- **Server:** Express 4 + Helmet + express-rate-limit — binds strictly to `127.0.0.1:3000`
- **Frontend:** Static vanilla JS/CSS in `public/` — no build step, no framework, no CDN
- **Auth model:** Classic GitHub PAT posted once → stored in server memory → opaque session ID returned to browser (kept in `sessionStorage`)
- **Upstream API:** GitHub REST, header `X-GitHub-Api-Version: 2026-03-10`

---

## File Map

| File | Role |
|---|---|
| `server.js` | Express app, in-memory session store, GitHub proxy endpoints, validation, rate limiting |
| `public/index.html` | SPA shell (Budgets + AI Usage tabs) |
| `public/app.js` | Frontend logic, `api()` helper, session restore, user picker, bulk-create form |
| `public/styles.css` | Dark GitHub-inspired theme |
| `README.md` | Authoritative spec — keep in sync when behaviour changes |
| `package.json` | Only 3 runtime deps: `express`, `helmet`, `express-rate-limit` |

---

## Non-Negotiable Rules

1. **Never persist the PAT.** Not to disk, not to logs, not to cookies, not to `localStorage`. PAT lives only in the server-side `sessions` Map. The client stores only the opaque session ID in `sessionStorage`.
2. **Never send the PAT back to the browser.** Any new endpoint must derive the PAT from `req.session` (looked up via `X-Session-Id`), never echo it.
3. **Never log the PAT or full auth headers.** Use the `dbg(...)` helper (gated by `DEBUG_LOGS=1`) for troubleshooting; log status codes and counts, not payloads.
4. **Bind to `127.0.0.1` only.** Do not change the listen address. No `0.0.0.0`, no `host: '*'`, no reverse-proxy hints.
5. **Do not add external CDN scripts, fonts, or stylesheets.** The app must remain fully self-contained. Helmet CSP is strict on purpose.
6. **Do not weaken CSP.** `img-src` allow-list is `'self'`, `data:`, `https://github.com`, `https://*.githubusercontent.com`. `script-src` is `'self'`. If a new asset origin is genuinely needed, discuss before widening.
7. **Least-privilege PAT scopes.** README documents `manage_billing:enterprise`, `manage_billing:copilot`, `read:enterprise`, `read:org`. Never recommend `admin:enterprise` in code comments, error messages, or docs.
8. **Validate every user-supplied input at the boundary.** Reuse the existing regexes/constants (`GH_LOGIN_RE`, `ENT_SLUG_RE`, `MAX_BULK_USERS`, `MAX_BUDGET_AMOUNT`, `MIN_BUDGET_AMOUNT`). Do not add ad-hoc parsing.
9. **Escape all rendered data.** Frontend must HTML-escape any GitHub-sourced string before inserting into the DOM (use the existing escape helper — no `innerHTML` with raw API data).
10. **Confirm irreversible actions.** Any new mutation (delete, bulk-create, bulk-delete) must go through a modal confirmation on the frontend.

---

## Server-Side Conventions (`server.js`)

- **Session middleware pattern:** authenticated routes look up `req.headers['x-session-id']` in the `sessions` Map, refresh `lastSeen`, and 401 on miss.
- **Session TTL:** 30 minutes. Pruned every 60 seconds. Do not extend without discussion.
- **Session ID:** 32-byte hex from `crypto.randomBytes(32).toString('hex')`. Do not switch to a shorter/predictable form.
- **Debug logging:** always route through `dbg(...)`. New code must not introduce raw `console.log('[...]', ...)` for request/response tracing.
- **Body limit:** `express.json({ limit: '64kb' })`. Keep this; do not raise silently.
- **Rate limit:** 120 req/min applied to `/api/*`. If a new endpoint is high-volume, discuss before excluding it.
- **GitHub API version header:** every outbound call to GitHub must include `Accept: application/vnd.github+json` and `X-GitHub-Api-Version: 2026-03-10`.
- **Error surface:** return `{ error: '<short human message>' }` with an appropriate 4xx/5xx. Do not leak upstream response bodies verbatim to the client.
- **Fallback discovery pattern:** the seat-count and user-listing endpoints deliberately chain multiple GitHub endpoints (see `/api/ai-usage` and `/api/enterprise-members`). Preserve the fallback order; do not shortcut to a single call.

### Existing key constants (do not rename)

```js
const GH_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const ENT_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const MAX_BULK_USERS = 100;
const MAX_BUDGET_AMOUNT = 10_000;
const MIN_BUDGET_AMOUNT = 1;
const SESSION_TTL_MS = 30 * 60 * 1000;
```

---

## Frontend Conventions (`public/app.js`)

- **Single IIFE.** No module system, no bundler. Keep everything in the existing closure.
- **`api(method, path, body)` helper** is the only way to talk to the backend. It attaches `X-Session-Id` automatically. Do not `fetch()` the API directly from new UI code.
- **Session storage key:** `ghbm_session` (holds only the session ID + enterprise slug). Do not add token-like data.
- **Restoration flow:** on load, `restoreSession()` calls `GET /api/session`; only show the dashboard on success. Do not trust `sessionStorage` alone.
- **DOM building:** prefer `document.createElement` + `.textContent`. If a template literal is unavoidable, run every interpolated value through the escape helper.
- **Avatars:** use the raw `avatar_url` returned by GitHub (do not append `&s=...` — it invalidates the signature for some responses). Always set `onerror="this.style.visibility='hidden'"`.

---

## AI Credits Math (Business Rule)

Per-seat rate is plan-aware and date-aware:

| Plan | Before 2026-09-01 UTC | From 2026-09-01 UTC |
|---|---|---|
| Copilot Business | 3,000 | 1,900 |
| Copilot Enterprise | 7,000 | 3,900 |

`Total = (business_seats × business_rate) + (enterprise_seats × enterprise_rate)`

- Cutoff comparison uses `new Date('2026-09-01T00:00:00Z')`. Do not switch to local time.
- 1 AI credit = **$0.01 USD** (used by bulk-create to convert to a USD budget).
- If a rate ever changes, update **all** of: `server.js` constants, README rate table, README changelog, and this file.

---

## Bulk-Create Payload Contract

The bulk-create endpoint sends this exact shape per user to GitHub — do not rename fields:

```json
{
  "budget_scope": "user",
  "user": "<login>",
  "budget_product_sku": "ai_credits",
  "budget_type": "BundlePricing",
  "budget_amount": 50,
  "prevent_further_usage": false
}
```

Historically-tried wrong values that broke the API (do not reintroduce): `budget_product_skus` (plural), `budget_type: "monthly"`, missing `user` field.

---

## When Making Changes

- **Read the file first.** `server.js` is edited outside this chat sometimes; verify before diffing.
- **Prefer small, surgical edits.** No refactors, no re-architecting, no reformatting unrelated code.
- **No new dependencies** without explicit approval. The 3-package baseline is a security posture, not an accident.
- **Update the README** when behaviour, endpoints, PAT scopes, rates, limits, or the security model change. Add a bullet to the Changelog for user-visible changes.
- **Do not add tests, CI configs, Dockerfiles, or lint configs** unless asked — this is an intentionally minimal internal tool.
- **Do not add telemetry, analytics, error-reporting SDKs, or any outbound calls to non-GitHub hosts.**
- **After server-side edits**, run `node --check server.js` and restart to confirm the startup banner prints.

---

## Common Pitfalls Learned The Hard Way

- `fetch(link.url)` — GitHub sometimes returns `link` as a **string** and sometimes as an **object with `.url`**. Always handle both: `const dlUrl = (typeof link === 'string') ? link : link.url;`.
- Enterprise-level `/copilot/billing` returns 404 on many enterprises. Always fall through to `/organizations` walk, then `/copilot/billing/seats`.
- Removing `admin:enterprise` from a PAT does not break this app — do not tell users to add it.
- CSP silently blocks `<img>` avatars. If an image doesn't load and DevTools shows a CSP violation, fix the allow-list, not the URL.
- Session persistence works via a **probe endpoint** (`/api/session`), not by trusting client state. Keep it that way.

---

## Style

- Async/await, no callback style. No `.then().catch()` chains.
- 2-space indent, single quotes, semicolons — match existing files.
- Comments explain **why**, not what. Keep them brief.
- No emojis in code or logs.
