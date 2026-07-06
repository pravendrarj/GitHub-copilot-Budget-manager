const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = 3000;

// ---------------------------------------------------------------------------
// Security: In-memory session store for PATs (never persisted to disk)
// ---------------------------------------------------------------------------
const sessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

function pruneExpiredSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.created > SESSION_TTL_MS) sessions.delete(id);
  }
}
setInterval(pruneExpiredSessions, 60_000);

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],   // inline styles for simplicity
      imgSrc: ["'self'", "data:", "https://github.com", "https://*.githubusercontent.com"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
}));

app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate-limit API calls
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', apiLimiter);

// Input-validation helpers
const GH_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;                 // GitHub username
const ENT_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;                     // enterprise slug
const MAX_BULK_USERS      = 100;
const MAX_BUDGET_AMOUNT   = 10_000;   // USD per user budget
const MIN_BUDGET_AMOUNT   = 1;
const DEBUG = process.env.DEBUG_LOGS === '1';
function dbg(...args) { if (DEBUG) console.log(...args); }

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
function getSession(req) {
  const sid = req.headers['x-session-id'];
  if (!sid) return null;
  const session = sessions.get(sid);
  if (!session) return null;
  if (Date.now() - session.created > SESSION_TTL_MS) {
    sessions.delete(sid);
    return null;
  }
  return session;
}

function ghHeaders(pat) {
  return {
    'Accept': 'application/vnd.github+json',
    'Authorization': `Bearer ${pat}`,
    'X-GitHub-Api-Version': '2026-03-10',
    'User-Agent': 'SWO-GH-Budget-Manager/1.0',
  };
}

// ---------------------------------------------------------------------------
// API Routes
// ---------------------------------------------------------------------------

// POST /api/connect  — store PAT in server-side session, return session ID
app.post('/api/connect', async (req, res) => {
  const { pat, enterprise } = req.body;
  if (!pat || !enterprise) {
    return res.status(400).json({ error: 'PAT and enterprise slug are required.' });
  }
  if (typeof pat !== 'string' || pat.length < 20 || pat.length > 512) {
    return res.status(400).json({ error: 'Invalid PAT format.' });
  }
  if (typeof enterprise !== 'string' || !ENT_SLUG_RE.test(enterprise)) {
    return res.status(400).json({ error: 'Invalid enterprise slug. Use only letters, digits and hyphens.' });
  }

  // Validate PAT by calling GitHub
  try {
    const response = await fetch(
      `https://api.github.com/enterprises/${encodeURIComponent(enterprise)}/settings/billing/budgets?per_page=1`,
      { headers: ghHeaders(pat) }
    );
    if (!response.ok) {
      const body = await response.text();
      return res.status(response.status).json({
        error: `GitHub API returned ${response.status}. Check your PAT and enterprise slug.`,
        detail: body,
      });
    }
  } catch (err) {
    return res.status(502).json({ error: 'Failed to reach GitHub API.', detail: err.message });
  }

  const sessionId = crypto.randomBytes(32).toString('hex');
  sessions.set(sessionId, { pat, enterprise, created: Date.now() });

  // Never send PAT back to client
  res.json({ sessionId, enterprise });
});

// POST /api/disconnect — destroy session
app.post('/api/disconnect', (req, res) => {
  const sid = req.headers['x-session-id'];
  if (sid) sessions.delete(sid);
  res.json({ ok: true });
});

// GET /api/session — validate session; returns enterprise slug if still valid
app.get('/api/session', (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Session expired or invalid.' });
  res.json({ enterprise: session.enterprise });
});

// GET /api/budgets?scope=...  — list budgets, optionally filtered by scope
app.get('/api/budgets', async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not connected. Please provide your PAT first.' });

  const { scope } = req.query;
  const allBudgets = [];
  let page = 1;
  let hasNext = true;

  try {
    while (hasNext) {
      const url = new URL(`https://api.github.com/enterprises/${encodeURIComponent(session.enterprise)}/settings/billing/budgets`);
      url.searchParams.set('per_page', '100');
      url.searchParams.set('page', String(page));
      if (scope) url.searchParams.set('scope', scope);

      const response = await fetch(url.toString(), { headers: ghHeaders(session.pat) });
      if (!response.ok) {
        const body = await response.text();
        return res.status(response.status).json({ error: `GitHub API error ${response.status}`, detail: body });
      }
      const data = await response.json();
      allBudgets.push(...(data.budgets || []));
      hasNext = data.has_next_page === true;
      page++;
      // Safety: cap at 50 pages (5000 budgets)
      if (page > 50) break;
    }
    res.json({ budgets: allBudgets, total: allBudgets.length });
  } catch (err) {
    res.status(502).json({ error: 'Failed to fetch budgets.', detail: err.message });
  }
});

// DELETE /api/budgets/:id  — delete a single budget
app.delete('/api/budgets/:id', async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not connected.' });

  const budgetId = req.params.id;

  try {
    const response = await fetch(
      `https://api.github.com/enterprises/${encodeURIComponent(session.enterprise)}/settings/billing/budgets/${encodeURIComponent(budgetId)}`,
      { method: 'DELETE', headers: ghHeaders(session.pat) }
    );
    if (!response.ok) {
      const body = await response.text();
      return res.status(response.status).json({ error: `Delete failed (${response.status})`, detail: body });
    }
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Failed to delete budget.', detail: err.message });
  }
});

// DELETE /api/budgets-bulk  — delete multiple budgets
app.post('/api/budgets-bulk-delete', async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not connected.' });

  const { budgetIds } = req.body;
  if (!Array.isArray(budgetIds) || budgetIds.length === 0) {
    return res.status(400).json({ error: 'budgetIds array is required.' });
  }

  const results = [];
  for (const budgetId of budgetIds) {
    try {
      const response = await fetch(
        `https://api.github.com/enterprises/${encodeURIComponent(session.enterprise)}/settings/billing/budgets/${encodeURIComponent(budgetId)}`,
        { method: 'DELETE', headers: ghHeaders(session.pat) }
      );
      if (response.ok) {
        const data = await response.json();
        results.push({ budgetId, success: true, data });
      } else {
        const body = await response.text();
        results.push({ budgetId, success: false, status: response.status, detail: body });
      }
    } catch (err) {
      results.push({ budgetId, success: false, detail: err.message });
    }
  }
  res.json({ results });
});

// ---------------------------------------------------------------------------
// AI Usage & Copilot Metrics
// ---------------------------------------------------------------------------

// GET /api/ai-usage — AI credit consumption from user-level 28-day metrics report
// Query params: ?month=YYYY-MM (optional, filters by month)
app.get('/api/ai-usage', async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not connected.' });

  const monthFilter = req.query.month || ''; // e.g. '2025-10'

  try {
    // Fetch user-level 28-day report (has ai_credits_used per user per day)
    const metricsUrl = `https://api.github.com/enterprises/${encodeURIComponent(session.enterprise)}/copilot/metrics/reports/users-28-day/latest`;
    const metricsRes = await fetch(metricsUrl, { headers: ghHeaders(session.pat) });

    if (!metricsRes.ok) {
      const body = await metricsRes.text();
      return res.status(metricsRes.status).json({
        error: `Copilot user metrics API returned ${metricsRes.status}. Your PAT may need 'manage_billing:copilot' or 'read:enterprise' scope.`,
        detail: body,
      });
    }
    const metricsData = await metricsRes.json();
    const downloadLinks = metricsData.download_links || [];

    // Download and parse ndjson
    const allUserRecords = [];
    for (const link of downloadLinks) {
      const dlRes = await fetch(link);
      if (!dlRes.ok) continue;
      const text = await dlRes.text();
      const lines = text.trim().split('\n').filter(l => l.trim());
      for (const line of lines) {
        try { allUserRecords.push(JSON.parse(line)); } catch { /* skip */ }
      }
    }

    // Collect available months from data
    const monthsSet = new Set();
    for (const r of allUserRecords) {
      if (r.day) monthsSet.add(r.day.substring(0, 7));
    }
    const availableMonths = [...monthsSet].sort().reverse();

    // Filter records by month if specified
    const filtered = monthFilter
      ? allUserRecords.filter(r => r.day && r.day.startsWith(monthFilter))
      : allUserRecords;

    // Aggregate ai_credits_used by user (already in credits, not dollars)
    const userMap = {};
    for (const record of filtered) {
      const login = record.user_login || record.user_id || 'unknown';
      if (!userMap[login]) {
        userMap[login] = { user: login, ai_credits_used: 0, days_active: 0 };
      }
      userMap[login].ai_credits_used += record.ai_credits_used || 0;
      userMap[login].days_active += 1;
    }

    const userStates = Object.values(userMap)
      .sort((a, b) => b.ai_credits_used - a.ai_credits_used);

    const totalConsumed = userStates.reduce((sum, u) => sum + u.ai_credits_used, 0);

    // ------------------------------------------------------------------
    // Total AI credit allocation is derived from Copilot license count.
    //
    // Rates per licensed seat:
    //                          Copilot Business   Copilot Enterprise
    //   Before Sep 1, 2026        3,000              7,000
    //   From   Sep 1, 2026        1,900              3,900
    // ------------------------------------------------------------------
    const NEW_RATE_CUTOFF = new Date('2026-09-01T00:00:00Z');
    const isNewRate = new Date() >= NEW_RATE_CUTOFF;
    const RATES = {
      business:   isNewRate ? 1900 : 3000,
      enterprise: isNewRate ? 3900 : 7000,
    };

    // Iterate the enterprise's orgs and read each org's copilot/billing so we
    // can correctly split business vs. enterprise licenses. Falls back to the
    // enterprise-level billing endpoint if the org list is unavailable.
    let businessSeats = 0;
    let enterpriseSeats = 0;
    const licenseSources = [];

    try {
      // Try enterprise-level billing first (single plan_type response)
      const entBillingRes = await fetch(
        `https://api.github.com/enterprises/${encodeURIComponent(session.enterprise)}/copilot/billing`,
        { headers: ghHeaders(session.pat) }
      );
      dbg('[ai-usage] Enterprise billing status:', entBillingRes.status);
      if (entBillingRes.ok) {
        const b = await entBillingRes.json();
        const total = b?.seat_breakdown?.total || 0;
        const plan = (b?.plan_type || '').toLowerCase();
        if (total > 0) {
          if (plan === 'business')       businessSeats   += total;
          else if (plan === 'enterprise') enterpriseSeats += total;
          else                            enterpriseSeats += total; // default assumption
          licenseSources.push({ source: 'enterprise', plan_type: plan || 'unknown', seats: total });
        }
      }
    } catch (e) { dbg('[ai-usage] enterprise billing error:', e.message); }

    // If enterprise-level returned nothing, walk the orgs
    if (businessSeats + enterpriseSeats === 0) {
      try {
        const orgsRes = await fetch(
          `https://api.github.com/enterprises/${encodeURIComponent(session.enterprise)}/organizations?per_page=100`,
          { headers: ghHeaders(session.pat) }
        );
        dbg('[ai-usage] enterprise orgs status:', orgsRes.status);
        if (orgsRes.ok) {
          const orgs = await orgsRes.json();
          const orgList = Array.isArray(orgs) ? orgs : (orgs.organizations || []);
          for (const org of orgList) {
            const orgLogin = org.login || org.name;
            if (!orgLogin) continue;
            try {
              const orgBillRes = await fetch(
                `https://api.github.com/orgs/${encodeURIComponent(orgLogin)}/copilot/billing`,
                { headers: ghHeaders(session.pat) }
              );
              if (!orgBillRes.ok) continue;
              const b = await orgBillRes.json();
              const total = b?.seat_breakdown?.total || 0;
              const plan = (b?.plan_type || '').toLowerCase();
              if (total > 0) {
                if (plan === 'business')       businessSeats   += total;
                else if (plan === 'enterprise') enterpriseSeats += total;
                else                            enterpriseSeats += total;
                licenseSources.push({ source: orgLogin, plan_type: plan || 'unknown', seats: total });
              }
            } catch (_) { /* per-org failure ignored */ }
          }
        }
      } catch (e) { dbg('[ai-usage] org walk error:', e.message); }
    }

    // Final fallback: enumerate seats directly. Each seat lists its plan_type.
    if (businessSeats + enterpriseSeats === 0) {
      try {
        let url = `https://api.github.com/enterprises/${encodeURIComponent(session.enterprise)}/copilot/billing/seats?per_page=100`;
        let pageCount = 0;
        while (url && pageCount < 20) {
          const seatsRes = await fetch(url, { headers: ghHeaders(session.pat) });
          dbg('[ai-usage] enterprise seats status:', seatsRes.status);
          if (!seatsRes.ok) break;
          const data = await seatsRes.json();
          const seats = data.seats || data.items || (Array.isArray(data) ? data : []);
          for (const s of seats) {
            const plan = (s.plan_type || s.pending_cancellation_date === null ? s.plan_type : s.plan_type || '').toString().toLowerCase();
            if (plan === 'business')        businessSeats++;
            else if (plan === 'enterprise') enterpriseSeats++;
            else                            enterpriseSeats++; // unknown → assume enterprise
          }
          pageCount++;
          const link = seatsRes.headers.get('link');
          url = null;
          if (link) {
            const m = link.match(/<([^>]+)>;\s*rel="next"/);
            if (m) url = m[1];
          }
        }
        if (businessSeats + enterpriseSeats > 0) {
          licenseSources.push({
            source: 'enterprise-seats',
            plan_type: enterpriseSeats && businessSeats ? 'mixed' : (enterpriseSeats ? 'enterprise' : 'business'),
            seats: businessSeats + enterpriseSeats,
          });
        }
      } catch (e) { dbg('[ai-usage] seats fallback error:', e.message); }
    }

    const seatCount = businessSeats + enterpriseSeats;
    const totalAllocatedCredits =
      (businessSeats   * RATES.business) +
      (enterpriseSeats * RATES.enterprise);

    // Effective rate (weighted) — used only for display context
    const creditsPerSeat = seatCount > 0
      ? Math.round(totalAllocatedCredits / seatCount)
      : (isNewRate ? RATES.enterprise : RATES.enterprise);

    res.json({
      totalAllocated: totalAllocatedCredits,
      totalConsumed,
      seatCount,
      businessSeats,
      enterpriseSeats,
      rates: RATES,
      creditsPerSeat,
      licenseSources,
      userStates,
      availableMonths,
      selectedMonth: monthFilter || 'all',
      reportPeriod: {
        start: metricsData.report_start_day,
        end: metricsData.report_end_day,
      },
    });
  } catch (err) {
    res.status(502).json({ error: 'Failed to fetch AI usage data.', detail: err.message });
  }
});

// GET /api/copilot-metrics — enterprise Copilot metrics (28-day report, parsed)
// Query params: ?month=YYYY-MM (optional, filters by month)
app.get('/api/copilot-metrics', async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not connected.' });

  const monthFilter = req.query.month || ''; // e.g. '2025-10'

  try {
    // Step 1: Get download links for 28-day enterprise report
    const metricsUrl = `https://api.github.com/enterprises/${encodeURIComponent(session.enterprise)}/copilot/metrics/reports/enterprise-28-day/latest`;
    const metricsRes = await fetch(metricsUrl, { headers: ghHeaders(session.pat) });

    if (!metricsRes.ok) {
      const body = await metricsRes.text();
      return res.status(metricsRes.status).json({
        error: `Copilot metrics API returned ${metricsRes.status}. Your PAT may need 'manage_billing:copilot' or 'read:enterprise' scope.`,
        detail: body,
      });
    }
    const metricsData = await metricsRes.json();
    const downloadLinks = metricsData.download_links || [];

    if (downloadLinks.length === 0) {
      return res.json({ ideBreakdown: [], totalTokens: 0, reportPeriod: metricsData, raw: [] });
    }

    // Step 2: Download and parse each ndjson file
    const allRecords = [];
    for (const link of downloadLinks) {
      const dlRes = await fetch(link);
      if (!dlRes.ok) continue;
      const text = await dlRes.text();
      const lines = text.trim().split('\n').filter(l => l.trim());
      for (const line of lines) {
        try { allRecords.push(JSON.parse(line)); } catch { /* skip malformed */ }
      }
    }

    // Step 3: Parse enterprise-level schema with month filtering
    // Each record has: { day_totals: [{ day, totals_by_ide: [{ide, ...}], totals_by_cli: {token_usage: {...}}, ... }] }
    const ideMap = {};
    let totalOutputTokens = 0;
    let totalPromptTokens = 0;
    let totalCodeGenActivity = 0;
    let totalCodeAcceptActivity = 0;
    let totalDailyActiveUsers = 0;
    let dayCount = 0;
    const monthsSet = new Set();

    for (const record of allRecords) {
      const dayTotals = record.day_totals || [record]; // fallback: treat record as flat
      for (const day of dayTotals) {
        // Collect available months
        if (day.day) monthsSet.add(day.day.substring(0, 7));

        // Apply month filter
        if (monthFilter && day.day && !day.day.startsWith(monthFilter)) continue;

        dayCount++;
        totalCodeGenActivity += day.code_generation_activity_count || 0;
        totalCodeAcceptActivity += day.code_acceptance_activity_count || 0;
        totalDailyActiveUsers += day.daily_active_users || 0;

        // IDE breakdown
        const byIde = day.totals_by_ide || [];
        for (const ide of byIde) {
          const name = ide.ide || 'Unknown';
          if (!ideMap[name]) {
            ideMap[name] = { codeGen: 0, codeAccept: 0, locAdded: 0, locSuggested: 0, interactions: 0 };
          }
          ideMap[name].codeGen += ide.code_generation_activity_count || 0;
          ideMap[name].codeAccept += ide.code_acceptance_activity_count || 0;
          ideMap[name].locAdded += ide.loc_added_sum || 0;
          ideMap[name].locSuggested += ide.loc_suggested_to_add_sum || 0;
          ideMap[name].interactions += ide.user_initiated_interaction_count || 0;
        }

        // Token usage from CLI totals
        const cli = day.totals_by_cli || {};
        const tokenUsage = cli.token_usage || {};
        totalOutputTokens += tokenUsage.output_tokens_sum || 0;
        totalPromptTokens += tokenUsage.prompt_tokens_sum || 0;
      }
    }

    const totalTokens = totalOutputTokens + totalPromptTokens;
    const ideBreakdown = Object.entries(ideMap)
      .map(([name, data]) => ({ name, ...data }))
      .sort((a, b) => b.locAdded - a.locAdded);

    const availableMonths = [...monthsSet].sort().reverse();

    res.json({
      ideBreakdown,
      totalTokens,
      totalOutputTokens,
      totalPromptTokens,
      totalCodeGenActivity,
      totalCodeAcceptActivity,
      totalDailyActiveUsers,
      dayCount,
      availableMonths,
      selectedMonth: monthFilter || 'all',
      reportPeriod: {
        start: metricsData.report_start_day,
        end: metricsData.report_end_day,
      },
      recordCount: allRecords.length,
    });
  } catch (err) {
    res.status(502).json({ error: 'Failed to fetch Copilot metrics.', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// Enterprise Members (try multiple sources)
// ---------------------------------------------------------------------------

// GET /api/enterprise-members — list users for bulk budget picker
app.get('/api/enterprise-members', async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not connected.' });

  const enterprise = encodeURIComponent(session.enterprise);
  const headers = ghHeaders(session.pat);

  // Strategy 1: Try enterprise members API
  try {
    const membersUrl = `https://api.github.com/enterprises/${enterprise}/members?per_page=100`;
    dbg('[members] Strategy 1: GET', membersUrl);
    const membersRes = await fetch(membersUrl, { headers });
    dbg('[members] Strategy 1 status:', membersRes.status);

    if (membersRes.ok) {
      const allMembers = [];
      let data = await membersRes.json();
      dbg('[members] Strategy 1 response type:', typeof data, Array.isArray(data) ? `array(${data.length})` : Object.keys(data).slice(0, 5));
      // Handle both array and paginated object responses
      const items = Array.isArray(data) ? data : (data.members || data.items || data.data || []);
      for (const m of items) {
        allMembers.push({
          login: m.login,
          avatar_url: m.avatar_url || `https://github.com/${encodeURIComponent(m.login)}.png`,
          name: m.name || m.login,
        });
      }

      // Follow pagination
      let nextUrl = null;
      const linkHeader = membersRes.headers.get('link');
      if (linkHeader) {
        const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
        if (match) nextUrl = match[1];
      }
      while (nextUrl && allMembers.length < 5000) {
        const nextRes = await fetch(nextUrl, { headers });
        if (!nextRes.ok) break;
        data = await nextRes.json();
        if (!Array.isArray(data) || data.length === 0) break;
        for (const m of data) {
          allMembers.push({
            login: m.login,
            avatar_url: m.avatar_url || `https://github.com/${encodeURIComponent(m.login)}.png`,
            name: m.name || m.login,
          });
        }
        const nl = nextRes.headers.get('link');
        nextUrl = null;
        if (nl) {
          const nm = nl.match(/<([^>]+)>;\s*rel="next"/);
          if (nm) nextUrl = nm[1];
        }
      }

      if (allMembers.length > 0) {
        allMembers.sort((a, b) => a.login.localeCompare(b.login));
        return res.json({ members: allMembers, source: 'enterprise-members' });
      }
    }
  } catch (e1) { dbg('[members] Strategy 1 error:', e1.message); }

  // Strategy 2: Try Copilot usage reports
  try {
    const reportUrl = `https://api.github.com/enterprises/${enterprise}/copilot/metrics/reports/users-28-day/latest`;
    dbg('[members] Strategy 2: GET', reportUrl);
    const reportRes = await fetch(reportUrl, { headers });
    dbg('[members] Strategy 2 status:', reportRes.status);

    if (reportRes.ok) {
      const reportData = await reportRes.json();
      const downloadLinks = reportData.download_links || [];

      const userMap = new Map();
      for (const link of downloadLinks) {
        const dlUrl = (typeof link === 'string') ? link : link.url;
        if (!dlUrl) continue;
        const ndjsonRes = await fetch(dlUrl);
        if (!ndjsonRes.ok) continue;
        const text = await ndjsonRes.text();
        const lines = text.trim().split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const record = JSON.parse(line);
            const login = record.user_login || record.user_id || record.user || record.login || record.github_com_login;
            if (login && login !== 'unknown' && !userMap.has(login)) {
              userMap.set(login, {
                login,
                avatar_url: `https://github.com/${encodeURIComponent(login)}.png`,
                name: record.name || login,
              });
            }
          } catch (_) { /* skip */ }
        }
      }

      if (userMap.size > 0) {
        const members = [...userMap.values()].sort((a, b) => a.login.localeCompare(b.login));
        return res.json({ members, source: 'copilot-reports' });
      }
    }
  } catch (e2) { dbg('[members] Strategy 2 error:', e2.message); }

  // Strategy 3: Try org members from enterprise orgs
  try {
    const orgsUrl = `https://api.github.com/enterprises/${enterprise}/organizations?per_page=10`;
    dbg('[members] Strategy 3: GET', orgsUrl);
    const orgsRes = await fetch(orgsUrl, { headers });
    dbg('[members] Strategy 3 orgs status:', orgsRes.status);

    if (orgsRes.ok) {
      const orgs = await orgsRes.json();
      const userMap = new Map();

      for (const org of orgs.slice(0, 5)) {
        const orgLogin = org.login || org.name;
        if (!orgLogin) continue;
        const orgMembersUrl = `https://api.github.com/orgs/${encodeURIComponent(orgLogin)}/members?per_page=100`;
        const orgMembersRes = await fetch(orgMembersUrl, { headers });
        if (!orgMembersRes.ok) continue;
        const orgMembers = await orgMembersRes.json();
        if (!Array.isArray(orgMembers)) continue;
        for (const m of orgMembers) {
          if (m.login && !userMap.has(m.login)) {
            userMap.set(m.login, {
              login: m.login,
              avatar_url: m.avatar_url || `https://github.com/${encodeURIComponent(m.login)}.png`,
              name: m.login,
            });
          }
        }
      }

      if (userMap.size > 0) {
        const members = [...userMap.values()].sort((a, b) => a.login.localeCompare(b.login));
        return res.json({ members, source: 'org-members' });
      }
    }
  } catch (_) { /* fall through */ }

  res.status(404).json({
    error: 'Could not fetch users. Your PAT may need additional scopes (read:org or read:enterprise).',
  });
});

// ---------------------------------------------------------------------------
// Bulk Budget Creation
// ---------------------------------------------------------------------------

// POST /api/budgets-bulk-create — create budgets for multiple users
app.post('/api/budgets-bulk-create', async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not connected.' });

  const { users, budgetAmount, preventFurtherUsage, productSkus } = req.body;
  if (!Array.isArray(users) || users.length === 0) {
    return res.status(400).json({ error: 'users array is required.' });
  }
  if (users.length > MAX_BULK_USERS) {
    return res.status(400).json({ error: `Too many users (max ${MAX_BULK_USERS} per request).` });
  }
  const amount = Number(budgetAmount);
  if (!Number.isFinite(amount) || amount < MIN_BUDGET_AMOUNT || amount > MAX_BUDGET_AMOUNT) {
    return res.status(400).json({ error: `budgetAmount must be between $${MIN_BUDGET_AMOUNT} and $${MAX_BUDGET_AMOUNT}.` });
  }

  const skus = Array.isArray(productSkus) && productSkus.length > 0 ? productSkus : ['ai_credits'];
  const results = [];

  for (const user of users) {
    if (typeof user !== 'string') {
      results.push({ user: String(user), success: false, detail: 'Invalid username (not a string).' });
      continue;
    }
    const username = user.trim();
    if (!username) continue;
    if (!GH_LOGIN_RE.test(username)) {
      results.push({ user: username, success: false, detail: 'Invalid GitHub username format.' });
      continue;
    }

    try {
      // User-scoped AI credits budget:
      //   budget_type = 'BundlePricing' (AI credits is a bundle of SKUs)
      //   budget_product_sku = 'ai_credits'
      const body = {
        budget_scope: 'user',
        user: username,
        budget_product_sku: skus[0] || 'ai_credits',
        budget_type: 'BundlePricing',
        budget_amount: amount,
        prevent_further_usage: !!preventFurtherUsage,
      };

      const response = await fetch(
        `https://api.github.com/enterprises/${encodeURIComponent(session.enterprise)}/settings/billing/budgets`,
        {
          method: 'POST',
          headers: { ...ghHeaders(session.pat), 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      );

      if (response.ok) {
        const data = await response.json();
        results.push({ user: username, success: true, data });
      } else {
        const detail = await response.text();
        results.push({ user: username, success: false, status: response.status, detail });
      }
    } catch (err) {
      results.push({ user: username, success: false, detail: err.message });
    }
  }

  res.json({ results });
});

// ---------------------------------------------------------------------------
// Fallback — SPA
// ---------------------------------------------------------------------------
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Start (localhost only — not exposed to the network)
// ---------------------------------------------------------------------------
app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  ╔══════════════════════════════════════════════════════════╗`);
  console.log(`  ║   SoftwareOne — GitHub Budget Manager                   ║`);
  console.log(`  ║   Running at  http://127.0.0.1:${PORT}                    ║`);
  console.log(`  ║   Press Ctrl+C to stop                                  ║`);
  console.log(`  ╚══════════════════════════════════════════════════════════╝\n`);
});
