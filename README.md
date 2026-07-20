# GitHub Enterprise Budget & AI Credits Manager.

> **Open-Source Tooling** | Version 2.0

---

## What Is This App (explaination)

- A **locally-hosted web tool** for managing GitHub Enterprise billing budgets and monitoring Copilot AI credits via the GitHub REST API
- This will help you manage the ULB, UULB, and other budgets on a single screen.
- Runs entirely on your machine at `http://127.0.0.1:3000` — no external services. Please feel free to update the port no.
- Two functional areas:
  1. **Budgets** — list, filter, single-delete and bulk-delete budgets across four scope levels
  2. **AI Usage** — visualise Copilot AI-credit consumption vs. the enterprise's licensed allocation, and **bulk-create** per-user AI-credit budgets..

---

## Pain Points It Resolves

- **No bulk delete in GitHub UI** — GitHub's billing console doesn't offer multi-select deletion; this app does
- **No bulk budget creation** — creating a per-user AI-credits budget for every licensed developer through the UI is tedious; the app does it against a picker of enterprise users
- **Opaque AI-credit allocation** — GitHub only shows raw consumption. This app derives the total AI credit allocation from the licensed seat count and pricing tier
- **Scope filtering** — quickly isolate budgets by level instead of scrolling through a flat list
- **Audit before action** — see all budget details before deciding what to delete

---

## Key Capabilities

| Feature | Description |
|---|---|
| **Connect via PAT** | Authenticate using a Classic PAT scoped to enterprise billing. |
| **Session persistence** | Session ID is stored in `sessionStorage` so page refresh doesn't force re-authentication (30-min server TTL still applies). |
| **View Budgets** | List all budgets for a GitHub Enterprise, filterable by scope. |
| **Filter by Scope** | Switch between **Universal User**, **User**, **Enterprise**, and **Cost Centre** views. |
| **Delete Single / Bulk** | Remove one budget or many in a single confirmed batch. |
| **AI Credits Overview** | Enterprise-wide allocated credits, consumed credits, remaining, and utilisation %. |
| **Enterprise User Picker** | Multi-select dropdown of enterprise users (fetched from GitHub) with search, select-all, and clear. |
| **Bulk Create User Budgets** | Assign an AI-credits budget to any number of selected users in one call. |
| **Plan-aware credit maths** | Splits seat count by plan type (Copilot Business vs. Copilot Enterprise) and applies the correct per-seat AI-credit rate for the current billing period. |

---

## How It Authenticates

1. User enters a **Classic PAT** + **enterprise slug** in the browser
2. Server validates the slug format, validates the PAT against GitHub's API (`GET /enterprises/{slug}/settings/billing/budgets`)
3. On success, PAT is stored **server-side in memory** and a random 32-byte **session ID** is returned to the browser
4. All subsequent requests use the session ID header — the **PAT never goes back to the client**
5. Session ID is cached in the browser's `sessionStorage` so a **page reload survives** the connection (server-side session still expires after 30 minutes)
6. Session **auto-expires after 30 minutes**; user can also manually disconnect.
7. On page load, the frontend validates the stored session against a lightweight `GET /api/session` endpoint before showing the dashboard
8. Make sure that you use the minimum role principle

---

## AI Credits Calculation

AI-credit allocation is **not stored** — it is derived from the enterprise's Copilot seat count.

**Per-seat rates:**

| Plan | Before Sep 1, 2026 | From Sep 1, 2026 |
|---|---|---|
| **Copilot Business** | 3,000 credits | 1,900 credits |
| **Copilot Enterprise** | 7,000 credits | 3,900 credits |

**Total = (business_seats × business_rate) + (enterprise_seats × enterprise_rate)**

The server determines seat counts using a three-step fallback:

1. `GET /enterprises/{ent}/copilot/billing` — enterprise-wide `seat_breakdown.total` + `plan_type`
2. If that fails, walk `GET /enterprises/{ent}/organizations` and read each org's `/orgs/{org}/copilot/billing`
3. If both fail, enumerate seats via `GET /enterprises/{ent}/copilot/billing/seats` and count by `plan_type`

The Budget (credits) card tooltip shows the plan breakdown (e.g. *"12 Enterprise × 7,000  +  5 Business × 3,000"*).

> 1 AI credit = $0.01 USD.

---

## Best Practices Included

| Area | Practice |
|------|----------|
| **Least privilege** | Only the scopes actually required (see PAT section) — never `admin:enterprise`. |
| **Localhost-only** | Server binds to `127.0.0.1` — unreachable from the network. |
| **No persistence** | PAT lives in Node.js heap memory only — never written to disk, logs, or cookies. |
| **PAT never logged** | Server never prints the PAT; it is only used in outgoing `Authorization: Bearer` headers to GitHub. |
| **Security headers** | Helmet.js sets a strict Content-Security-Policy plus X-Frame-Options, X-Content-Type-Options, HSTS. |
| **CSP img-src allow-list** | Only `self`, `data:`, `https://github.com`, and `https://*.githubusercontent.com` are permitted image sources (for the enterprise-user avatars). |
| **Rate limiting** | 120 requests/minute on API routes (increased from 60 to accommodate the AI-usage refresh + user-picker workflow). |
| **Body size limit** | `express.json` is capped at 64 KB. |
| **Input validation** | Enterprise slug matches `^[A-Za-z0-9][A-Za-z0-9-]{0,38}$`; usernames match GitHub's login regex; budget amount is bounded (`$1 – $10 000`); bulk creation is capped at **100 users per request**. |
| **Input sanitization** | All rendered data is HTML-escaped before DOM insertion. |
| **No external deps at runtime** | Zero CDN scripts/fonts — fully self-contained. Only GitHub-owned image hosts are allowed by CSP. |
| **Confirmation gate** | Delete actions require explicit modal confirmation. |
| **Session TTL + validation** | 30-minute auto-expiry, periodic pruning of stale sessions, and a `GET /api/session` probe on page reload before restoring the dashboard. |
| **Session-scoped storage** | Only the opaque session ID is stored in `sessionStorage` — never the PAT. `sessionStorage` is cleared automatically when the tab closes. |
| **Short-lived PAT recommendation** | Docs recommend 7-day token expiration. |
| **Silenced debug logs** | Debug output is off by default; enable with `DEBUG_LOGS=1` for troubleshooting. Nothing sensitive is logged even when enabled. |

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                     Browser                         │
│   (http://127.0.0.1:3000)                           │
│                                                     │
│   ┌─────────────────────────────────────────────┐   │
│   │       Themed Frontend SPA                     │   │
│   │   index.html  +  styles.css  +  app.js       │   │
│   │                                              │   │
│   │   Tabs:  Budgets   •   AI Usage              │   │
│   │   sessionStorage: session ID only            │   │
│   └────────────────────┬────────────────────────┘   │
│                        │  fetch() — same origin     │
└────────────────────────┼────────────────────────────┘
                         │
┌────────────────────────┼────────────────────────────┐
│               Express Server (Node.js)              │
│               Listening on 127.0.0.1:3000           │
│                                                     │
│   ┌─────────────────────────────────────────────┐   │
│   │  In-Memory Session Store                     │   │
│   │  PAT stored server-side only                 │   │
│   │  Auto-expires after 30 min                   │   │
│   └─────────────────────────────────────────────┘   │
│                        │                            │
│               GitHub REST API                       │
│   /enterprises/{slug}/settings/billing/budgets      │
│   /enterprises/{slug}/copilot/billing[/seats]       │
│   /enterprises/{slug}/copilot/metrics/reports/...   │
└─────────────────────────────────────────────────────┘
```

---

## Budget Scope Levels

| # | Scope Tab | GitHub API Scope | Description |
|---|---|---|---|
| 1 | **Universal User** | `multi_user_customer` | Per-user cap applied to **all** users in the enterprise. |
| 2 | **User** | `user` | Budget scoped to a **single named user**. |
| 3 | **Enterprise** | `enterprise` | Cap on total spending across the **entire enterprise**. |
| 4 | **Cost Centre** | `cost_center` | Budget tied to a **cost centre** entity. |

> The "All Budgets" tab shows every scope, including `organization` and `repository` budgets if they exist.

Bulk creation writes **User-scoped** AI-credit budgets:

```json
{
  "budget_scope": "user",
  "user": "<login>",
  "budget_product_sku": "ai_credits",
  "budget_type": "BundlePricing",
  "budget_amount": <USD>,
  "prevent_further_usage": <bool>
}
```

---

## Security Model

| Control | Detail |
|---|---|
| **Localhost-only binding** | Server listens on `127.0.0.1` — unreachable from other machines. |
| **PAT never in client** | After the initial connect request, the PAT is discarded from the browser; only a random session ID is returned and stored in `sessionStorage`. |
| **In-memory storage** | PAT lives in Node.js heap memory. Never written to disk, logs, or cookies. |
| **Session TTL** | 30-minute auto-expiry, pruned every 60 seconds. |
| **Helmet.js** | Strict CSP + X-Frame-Options, HSTS, etc. |
| **CSP image allow-list** | `'self'`, `data:`, `https://github.com`, `https://*.githubusercontent.com` — no arbitrary image origins. |
| **Rate limiting** | 120 req/min per source. |
| **Body limit** | 64 KB JSON payload cap. |
| **Input validation** | Slug, username, budget amount, and bulk-user count are all validated against explicit whitelists / bounds before any GitHub call. |
| **Input encoding** | All user-facing data is escaped client-side before DOM insertion. |
| **No external CDN** | Zero external scripts or stylesheets. |

---

## Prerequisites

- **Node.js** 18+ (with built-in `fetch`)
- **npm**
- A **GitHub Personal Access Token (classic)** — see PAT requirements below

---

## PAT Permissions (Least Privilege)

### Token Type

| Type | Supported |
|------|-----------|
| **Classic PAT** | ✅ Required |
| Fine-grained PAT | ❌ Not supported by the budgets API |
| GitHub App tokens | ❌ Not supported by the budgets API |

### Required Classic PAT Scopes

The scopes required depend on which features you use:

| Scope | Feature that needs it |
|---|---|
| `manage_billing:enterprise` | List / create / delete budgets (always required) |
| `manage_billing:copilot` | Read the Copilot seat count + plan type for the AI Credits card |
| `read:enterprise` | Fallback that lets the app discover organizations under the enterprise for seat counting |
| `read:org` (or `admin:org`) | Populate the enterprise-user picker via org-member listing (fallback when the Copilot metrics endpoint doesn't list users) |

> **Do NOT use** `admin:enterprise` — it grants far more than needed. Prefer the granular scopes above.

### Required User Role

| Operation | Minimum Role |
|-----------|-------------|
| List budgets | Enterprise **Billing Manager** or **Enterprise Admin** |
| Delete or create budgets | **Enterprise Admin** |
| View Copilot seat / usage data | **Enterprise Admin** or **Copilot Admin** |

### How to Create the PAT

1. Go to **GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)**
2. Click **Generate new token (classic)**
3. Set a descriptive **Note** (e.g., `GH Budget Manager`)
4. Set **Expiration** to the shortest acceptable period (e.g., 7 days)
5. Under **Select scopes**, check only the ones you need (see table above)
6. Click **Generate token**
7. Copy the token (`ghp_...`) — you won't see it again

### Scope Hierarchy Reference

```
admin:enterprise              ← DO NOT USE (overly broad)
├── manage_billing:enterprise ← ✅ USE (budgets read + write)
├── manage_billing:copilot    ← ✅ USE (seat count / plan type)
└── read:enterprise           ← optional (org discovery fallback)
```

---

## Installation & Running

```bash
# Clone or copy the project folder
cd freecharge

# Install dependencies
npm install

# Start the server
npm start
```

Open **http://127.0.0.1:3000** in your browser.

**Optional debug logging** (prints GitHub response status codes for troubleshooting, never prints PAT or personal data):

```powershell
$env:DEBUG_LOGS = "1"; node server.js
```

---

## Usage Walkthrough

### 1. Connect

1. Enter your **Enterprise slug** (e.g., `my-company`).
2. Paste your **PAT**.
3. Click **Connect**. The app validates the token against GitHub's API.
4. On success, the PAT field is cleared immediately.
5. Your session ID is cached in `sessionStorage` so a page refresh keeps you signed in until the server-side TTL expires.

### 2. Budgets Tab

- Filter with the **scope tabs**.
- Each row shows scope, entity, product/SKU, budget type, amount, and block-on-exceed.
- **Delete** a single row or select multiple + **Delete Selected (N)**.

### 3. AI Usage Tab

- **AI Credits — Enterprise Overview** cards show allocated, consumed, remaining, and utilisation.
- Hover the **Budget (credits)** card for the seat-breakdown tooltip.
- Change the **month** filter to inspect a specific report window.

### 4. Bulk-Create User Budgets

1. Scroll to **Bulk Create User Budgets** on the AI Usage tab.
2. The **enterprise user picker** loads real users from your GitHub Enterprise.
3. Search / **Select All** / individually tick users.
4. Enter the **AI-credits budget amount** (USD) and toggle **prevent further usage** if desired.
5. Click **Create Budgets**. Each user gets a `user`-scope, `BundlePricing`, `ai_credits` budget.

### 5. Disconnect

Click **Disconnect** to destroy your session on the server and clear `sessionStorage`.

---

## API Endpoints (Internal)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/connect` | Validate slug + PAT, create session |
| `GET`  | `/api/session` | Validate the current session (used on page reload) |
| `POST` | `/api/disconnect` | Destroy session |
| `GET`  | `/api/budgets?scope=` | List budgets (paginated, up to 5000) |
| `DELETE` | `/api/budgets/:id` | Delete one budget |
| `POST` | `/api/budgets-bulk-delete` | Delete multiple budgets |
| `POST` | `/api/budgets-bulk-create` | Create user-scoped AI-credit budgets for up to 100 users |
| `GET`  | `/api/ai-usage?month=YYYY-MM` | Aggregated Copilot AI-credit consumption + seat/allocation math |
| `GET`  | `/api/copilot-metrics` | Raw Copilot metrics passthrough |
| `GET`  | `/api/enterprise-members` | Enterprise user list (multi-strategy discovery) |

---

## GitHub API Reference

This tool uses API version `2026-03-10`.

| Endpoint | Method | Used For |
|---|---|---|
| `/enterprises/{ent}/settings/billing/budgets` | `GET` / `POST` | List and create budgets |
| `/enterprises/{ent}/settings/billing/budgets/{id}` | `DELETE` | Delete a budget |
| `/enterprises/{ent}/copilot/billing` | `GET` | Enterprise-wide Copilot seat breakdown + plan type |
| `/enterprises/{ent}/copilot/billing/seats` | `GET` | Per-seat listing (fallback for seat counting) |
| `/enterprises/{ent}/copilot/metrics/reports/users-28-day/latest` | `GET` | Signed download links for AI-credit consumption ndjson |
| `/enterprises/{ent}/organizations` | `GET` | Enterprise → organizations walk (fallback) |
| `/orgs/{org}/copilot/billing` | `GET` | Per-org seat count + plan type (fallback) |
| `/orgs/{org}/members` | `GET` | Enterprise user discovery (fallback for the picker) |

---

## Troubleshooting

| Issue | Solution |
|---|---|
| **403 Forbidden** | The PAT lacks the required scope for the endpoint. Add `manage_billing:enterprise` (budgets) and/or `manage_billing:copilot` (Copilot seats/metrics). Never grant `admin:enterprise` unless absolutely required. |
| **404 Not Found on `/api/connect`** | Wrong enterprise slug. It is the URL-friendly name, not the display name. |
| **AI Credits card shows "No seats"** | The PAT is missing `manage_billing:copilot` (or the enterprise has no Copilot seats). Set `DEBUG_LOGS=1` and check the terminal for the three fallback status codes. |
| **User picker empty** | The PAT can't reach the enterprise members endpoint. Add `read:org` or `read:enterprise`. |
| **Connection refused** | Node.js 18+ isn't installed or `npm install` didn't complete. |
| **Session expired** | Sessions expire after 30 minutes. Reconnect with your PAT. |
| **`EADDRINUSE`** | Port 3000 already in use — stop the previous node process (`Get-Process node \| Stop-Process -Force`). |

---

## Project Structure

```
freecharge/
├── server.js              # Express backend — API proxy, session mgmt, validation
├── package.json           # Dependencies
├── public/
│   ├── index.html         # Single-page app shell
│   ├── styles.css         # GitHub-inspired dark theme
│   └── app.js             # Frontend logic (tabs, picker, api helper)
└── README.md              # This document
```

---

## ⚠️ Risks, Liability & Disclaimer

> **READ THIS SECTION CAREFULLY BEFORE USING THE APP.**
> All responsibility and liability for the use of this tool lies **exclusively with the user**. The developer provides this tool "as-is" without warranty of any kind.

---

### Onus & Liability (User Bears All Responsibility)

| Area | User's Responsibility |
|------|----------------------|
| **PAT creation & scope** | You are solely responsible for creating the PAT, choosing its scope, and ensuring least privilege. |
| **Token security** | Safeguarding the PAT before, during, and after use. Clipboard, screen-share, screenshots, shoulder-surfing — all your responsibility. |
| **Budget deletions are irreversible** | GitHub does not provide an "undo" for deleted budgets. |
| **Budget creations are cost-controls** | An incorrectly-sized bulk create either over- or under-caps users. Verify the amount before confirming. |
| **Enterprise impact** | Removing budgets removes spending caps → uncapped charges are possible. |
| **Correct enterprise slug** | Verify before performing any action. |
| **Running on shared machines** | Other local users may reach `127.0.0.1:3000` during your session. |
| **Compliance & authorisation** | Ensure you have written authorisation from the enterprise owner/billing admin. |
| **Token expiration management** | Revoke or let the PAT expire after use. |

---

### Security Risks of Running This App Locally

| # | Risk | Description | Mitigation (User Action) |
|---|------|-------------|--------------------------|
| 1 | **PAT in process memory** | While never written to disk, the PAT resides in Node.js heap memory until session expiry or disconnect. | Disconnect immediately after use. |
| 2 | **Clipboard exposure** | The PAT may remain in the OS clipboard / clipboard history. | Clear your clipboard after pasting. |
| 3 | **Screen capture / recording** | Keystroke or screen capture could expose the token. | Do not screen-share or record while entering the PAT. |
| 4 | **Browser dev-tools / extensions** | Extensions can intercept the initial connect request body. | Use a clean browser profile with DevTools closed. |
| 5 | **Shared localhost access** | Multi-user systems may expose port 3000 to other local accounts. | Ensure no other users are logged in. |
| 6 | **No HTTPS (localhost)** | Plain HTTP on localhost. Do not proxy or port-forward. | Never expose this app externally. |
| 7 | **Process crash = session lost** | No persistence — active workflows interrupt on crash. | Save budget data before bulk operations. |
| 8 | **No audit log** | Deletions/creations not logged locally. | Rely on GitHub's enterprise audit log. |
| 9 | **Rate limits** | 120 req/min limit. Rapid clicking may temporarily lock you out. | Use as intended. |
| 10 | **Dependency supply-chain** | `npm install` fetches packages from the public registry. | Run `npm audit`; verify `package-lock.json`. |
| 11 | **Stale session window** | 30-min TTL means the PAT is in memory for up to 30 minutes if you walk away. | Always click Disconnect when done. |
| 12 | **`sessionStorage` XSS surface** | The session ID (not the PAT) is in `sessionStorage`. Any successful XSS could steal it and impersonate the session until it expires. | Do not paste unsafe HTML into the app; do not install untrusted browser extensions. |
| 13 | **No MFA on the tool** | The app has no built-in MFA. Anyone with a valid session ID can act. | Lock your workstation (`Win+L`). |

---

### Potential Operational Risks

| Risk | Impact | User Action |
|------|--------|-------------|
| **Accidental bulk delete** | All selected budgets are deleted in one batch — no per-item confirmation in bulk mode. | Review the modal summary before confirming. |
| **Accidental bulk create** | All selected users receive the same budget instantly. | Review the picker + amount before confirming. Max 100 users per request. |
| **Budget re-creation cost** | Deleted budgets must be manually re-created. | Document existing budgets before deleting. |
| **Spending surge** | Removing a budget removes spending caps. | Coordinate with finance/billing before removing caps. |
| **AI credits rate change (Sep 1, 2026)** | Per-seat rates drop from 7,000 → 3,900 (Enterprise) and 3,000 → 1,900 (Business). The app switches automatically based on system date. | If your system clock is wrong, the wrong rate will apply. |
| **API version deprecation** | Tool uses API version `2026-03-10`. | Monitor GitHub API changelog. |
| **GitHub rate limits** | Bulk operations may hit GitHub's rate limits. | Use smaller batches for very large enterprises. |

---

### Developer Disclaimer

```
THIS SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
FOR ANY CLAIM, DAMAGES, OR OTHER LIABILITY ARISING FROM THE USE OF THIS TOOL.

THE USER ACCEPTS ALL RISK ASSOCIATED WITH:
  • Token leakage due to local machine compromise
  • Irreversible deletion of billing budgets
  • Financial impact from removed or over-generous spending caps
  • Unauthorized use on shared systems
  • Any violation of organisational policy

BY USING THIS TOOL, YOU ACKNOWLEDGE THAT YOU HAVE READ, UNDERSTOOD, AND
ACCEPTED THE RISKS OUTLINED ABOVE.
```

---

## Changelog

### v2.0 — 2026-07
- **New:** AI Usage tab with allocated / consumed / remaining / utilisation cards
- **New:** Plan-aware AI-credit allocation math (Business vs Enterprise seat rates; automatic Sep 1, 2026 rate switch)
- **New:** Enterprise-user multi-select picker with search + select-all
- **New:** Bulk-create user AI-credit budgets (up to 100 users per request)
- **New:** Session persistence across page reloads via `sessionStorage` + `/api/session` validation
- **Sec:** Explicit input validation for enterprise slug, username, budget amount, and bulk user count
- **Sec:** Request-body size limit (64 KB) and rate-limit bump (120 req/min)
- **Sec:** Debug logging is off by default (`DEBUG_LOGS=1` to enable) and never prints the PAT
- **Sec:** CSP `img-src` explicitly allow-lists only `github.com` and `*.githubusercontent.com`

### v1.0
- Initial release — list, filter, single- and bulk-delete of GitHub Enterprise billing budgets

---

## Author

**Pravendra** — Developer & Creator

---

## License

Released under the MIT License — see [LICENSE](LICENSE).

---

<p align="center">
  <strong>GitHub Enterprise Budget & AI Credits Manager</strong><br/>
  <em>Simplifying GitHub Enterprise budget & AI credit management.</em><br/>
  <em>Developed by Pravendra</em>
</p>
