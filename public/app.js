/* ═══════════════════════════════════════════════════════════
   GitHub Enterprise Budget Manager  •  Frontend Logic
   ════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ── State ────────────────────────────────────
  const STORAGE_KEY = 'ghbm_session';
  let sessionId = null;
  let enterpriseName = '';
  let currentScope = '';
  let budgets = [];

  function persistSession() {
    try {
      if (sessionId && enterpriseName) {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ sessionId, enterpriseName }));
      } else {
        sessionStorage.removeItem(STORAGE_KEY);
      }
    } catch (_) { /* ignore storage errors */ }
  }

  function clearSession() {
    sessionId = null;
    enterpriseName = '';
    try { sessionStorage.removeItem(STORAGE_KEY); } catch (_) {}
  }

  // ── DOM refs ──────────────────────────────────────────────
  const $connectPanel   = document.getElementById('panel-connect');
  const $dashboard      = document.getElementById('panel-dashboard');
  const $formConnect    = document.getElementById('form-connect');
  const $inputPat       = document.getElementById('input-pat');
  const $inputEnt       = document.getElementById('input-enterprise');
  const $connectError   = document.getElementById('connect-error');
  const $connectText    = document.getElementById('connect-text');
  const $connectSpinner = document.getElementById('connect-spinner');
  const $btnConnect     = document.getElementById('btn-connect');
  const $sessionInd     = document.getElementById('session-indicator');
  const $entBadge       = document.getElementById('enterprise-badge');
  const $btnDisconnect  = document.getElementById('btn-disconnect');
  const $btnRefresh     = document.getElementById('btn-refresh');
  const $btnDeleteSel   = document.getElementById('btn-delete-selected');
  const $budgetCount    = document.getElementById('budget-count');
  const $tbody          = document.getElementById('budget-tbody');
  const $tableEmpty     = document.getElementById('table-empty');
  const $tableError     = document.getElementById('table-error');
  const $checkAll       = document.getElementById('check-all');
  const $modalOverlay   = document.getElementById('modal-overlay');
  const $modalMessage   = document.getElementById('modal-message');
  const $modalList      = document.getElementById('modal-budget-list');
  const $modalCancel    = document.getElementById('modal-cancel');
  const $modalConfirm   = document.getElementById('modal-confirm');
  const $toasts         = document.getElementById('toast-container');

  // ── Helpers ───────────────────────────────────────────────
  function api(method, path, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (sessionId) opts.headers['X-Session-Id'] = sessionId;
    if (body) opts.body = JSON.stringify(body);
    return fetch(path, opts).then(async r => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw { status: r.status, ...data };
      return data;
    });
  }

  function toast(msg, type = 'success') {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = msg;
    $toasts.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  function scopeLabel(scope) {
    const labels = {
      enterprise: 'Enterprise',
      user: 'User',
      cost_center: 'Cost Centre',
      multi_user_customer: 'Universal User',
      multi_user_cost_center: 'Universal Cost Centre',
      organization: 'Organization',
      repository: 'Repository',
    };
    return labels[scope] || scope;
  }

  // ── Connect ───────────────────────────────────────────────
  $formConnect.addEventListener('submit', async (e) => {
    e.preventDefault();
    $connectError.style.display = 'none';
    $btnConnect.disabled = true;
    $connectText.style.display = 'none';
    $connectSpinner.style.display = 'inline-block';

    try {
      const data = await api('POST', '/api/connect', {
        pat: $inputPat.value.trim(),
        enterprise: $inputEnt.value.trim(),
      });
      sessionId = data.sessionId;
      enterpriseName = data.enterprise;
      persistSession();

      // Clear PAT from DOM immediately
      $inputPat.value = '';

      showDashboard();
    } catch (err) {
      $connectError.textContent = err.error || 'Connection failed.';
      $connectError.style.display = 'block';
    } finally {
      $btnConnect.disabled = false;
      $connectText.style.display = 'inline';
      $connectSpinner.style.display = 'none';
    }
  });

  // ── Disconnect ────────────────────────────────────────────
  $btnDisconnect.addEventListener('click', async () => {
    await api('POST', '/api/disconnect').catch(() => {});
    clearSession();
    budgets = [];
    $sessionInd.style.display = 'none';
    $dashboard.style.display = 'none';
    $connectPanel.style.display = '';
  });

  // ── Show Dashboard ────────────────────────────────────────
  function showDashboard() {
    $connectPanel.style.display = 'none';
    $dashboard.style.display = '';
    $sessionInd.style.display = 'flex';
    $entBadge.textContent = enterpriseName;
    loadBudgets();
    loadEnterpriseMembers();
  }

  // ── Scope Tabs ────────────────────────────────────────────
  document.querySelectorAll('.scope-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.scope-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentScope = tab.dataset.scope;
      loadBudgets();
    });
  });

  // ── Load Budgets ──────────────────────────────────────────
  async function loadBudgets() {
    $tableError.style.display = 'none';
    $tableEmpty.style.display = 'none';
    $tbody.innerHTML = '<tr><td colspan="8" class="text-muted text-center">Loading…</td></tr>';
    $budgetCount.textContent = 'Loading budgets…';
    $btnDeleteSel.disabled = true;
    $checkAll.checked = false;

    try {
      const query = currentScope ? `?scope=${currentScope}` : '';
      const data = await api('GET', `/api/budgets${query}`);
      budgets = data.budgets || [];
      renderTable();
    } catch (err) {
      $tbody.innerHTML = '';
      $tableError.textContent = err.error || 'Failed to load budgets.';
      $tableError.style.display = 'block';
      $budgetCount.textContent = 'Error';
    }
  }

  // ── Render Table ──────────────────────────────────────────
  function renderTable() {
    $tbody.innerHTML = '';
    if (budgets.length === 0) {
      $tableEmpty.style.display = 'block';
      $budgetCount.textContent = '0 budgets';
      return;
    }
    $tableEmpty.style.display = 'none';
    $budgetCount.textContent = `${budgets.length} budget${budgets.length > 1 ? 's' : ''}`;

    budgets.forEach(b => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><input type="checkbox" class="row-check" data-id="${esc(b.id)}" /></td>
        <td><span class="scope-label scope-${esc(b.budget_scope)}">${esc(scopeLabel(b.budget_scope))}</span></td>
        <td>${esc(b.budget_entity_name || b.user || '—')}</td>
        <td>${esc(b.budget_product_sku || b.budget_product_skus?.join(', ') || '—')}</td>
        <td>${esc(b.budget_type || '—')}</td>
        <td>$${Number(b.budget_amount).toLocaleString()}</td>
        <td class="${b.prevent_further_usage ? 'block-yes' : 'block-no'}">${b.prevent_further_usage ? 'Yes' : 'No'}</td>
        <td><button class="btn btn-sm btn-danger btn-delete-one" data-id="${esc(b.id)}">Delete</button></td>
      `;
      $tbody.appendChild(tr);
    });

    // Wire individual delete buttons
    $tbody.querySelectorAll('.btn-delete-one').forEach(btn => {
      btn.addEventListener('click', () => confirmDelete([btn.dataset.id]));
    });

    // Wire row checkboxes
    updateDeleteBtn();
    $tbody.querySelectorAll('.row-check').forEach(cb => {
      cb.addEventListener('change', updateDeleteBtn);
    });
  }

  function esc(s) {
    if (s == null) return '';
    const el = document.createElement('span');
    el.textContent = String(s);
    return el.innerHTML;
  }

  // ── Check-all ─────────────────────────────────────────────
  $checkAll.addEventListener('change', () => {
    const checked = $checkAll.checked;
    $tbody.querySelectorAll('.row-check').forEach(cb => { cb.checked = checked; });
    updateDeleteBtn();
  });

  function updateDeleteBtn() {
    const selected = $tbody.querySelectorAll('.row-check:checked');
    $btnDeleteSel.disabled = selected.length === 0;
    $btnDeleteSel.textContent = selected.length > 0
      ? `Delete Selected (${selected.length})`
      : 'Delete Selected';
  }

  // ── Delete Selected ───────────────────────────────────────
  $btnDeleteSel.addEventListener('click', () => {
    const ids = [...$tbody.querySelectorAll('.row-check:checked')].map(c => c.dataset.id);
    if (ids.length) confirmDelete(ids);
  });

  // ── Confirm Modal ─────────────────────────────────────────
  let pendingDeleteIds = [];

  function confirmDelete(ids) {
    pendingDeleteIds = ids;
    $modalMessage.textContent = `Are you sure you want to delete ${ids.length} budget${ids.length > 1 ? 's' : ''}? This cannot be undone.`;
    $modalList.innerHTML = '';
    ids.forEach(id => {
      const b = budgets.find(x => x.id === id);
      const div = document.createElement('div');
      div.textContent = b
        ? `${scopeLabel(b.budget_scope)} — ${b.budget_entity_name || b.user || 'N/A'} — $${Number(b.budget_amount).toLocaleString()}`
        : id;
      $modalList.appendChild(div);
    });
    $modalOverlay.style.display = 'flex';
  }

  $modalCancel.addEventListener('click', () => { $modalOverlay.style.display = 'none'; });
  $modalOverlay.addEventListener('click', (e) => { if (e.target === $modalOverlay) $modalOverlay.style.display = 'none'; });

  $modalConfirm.addEventListener('click', async () => {
    $modalConfirm.disabled = true;
    $modalConfirm.textContent = 'Deleting…';
    try {
      if (pendingDeleteIds.length === 1) {
        await api('DELETE', `/api/budgets/${pendingDeleteIds[0]}`);
        toast('Budget deleted successfully.');
      } else {
        const data = await api('POST', '/api/budgets-bulk-delete', { budgetIds: pendingDeleteIds });
        const ok = data.results.filter(r => r.success).length;
        const fail = data.results.filter(r => !r.success).length;
        if (fail === 0) toast(`${ok} budget${ok > 1 ? 's' : ''} deleted.`);
        else toast(`${ok} deleted, ${fail} failed.`, 'error');
      }
      loadBudgets();
    } catch (err) {
      toast(err.error || 'Delete failed.', 'error');
    } finally {
      $modalOverlay.style.display = 'none';
      $modalConfirm.disabled = false;
      $modalConfirm.textContent = 'Delete';
    }
  });

  // ── Refresh ───────────────────────────────────────────────
  $btnRefresh.addEventListener('click', loadBudgets);

  // ══════════════════════════════════════════════════════════
  //  NAV TABS (Budgets / AI Usage)
  // ══════════════════════════════════════════════════════════
  const $panelBudgets  = document.getElementById('panel-budgets');
  const $panelAiUsage  = document.getElementById('panel-ai-usage');

  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const panel = tab.dataset.panel;
      $panelBudgets.style.display  = panel === 'budgets' ? '' : 'none';
      $panelAiUsage.style.display  = panel === 'ai-usage' ? '' : 'none';
      if (panel === 'ai-usage') {
        loadAiUsage();
        loadCopilotMetrics();
      }
    });
  });

  // ══════════════════════════════════════════════════════════
  //  AI CREDITS — per-user consumption
  // ══════════════════════════════════════════════════════════
  const $mcAllocated   = document.getElementById('mc-allocated');
  const $mcConsumed    = document.getElementById('mc-consumed');
  const $mcRemaining   = document.getElementById('mc-remaining');
  const $mcUtilization = document.getElementById('mc-utilization');
  const $usageBarFill  = document.getElementById('usage-bar-fill');
  const $usageBarUsed  = document.getElementById('usage-bar-used');
  const $usageBarTotal = document.getElementById('usage-bar-total');
  const $aiUsersTbody  = document.getElementById('ai-users-tbody');
  const $aiUsersEmpty  = document.getElementById('ai-users-empty');
  const $aiUsersError  = document.getElementById('ai-users-error');
  const $btnRefreshAi  = document.getElementById('btn-refresh-ai');
  const $monthFilter   = document.getElementById('month-filter');

  let currentMonth = new Date().toISOString().substring(0, 7); // Default to current month e.g. '2026-07'

  $btnRefreshAi.addEventListener('click', () => { loadAiUsage(); loadCopilotMetrics(); });

  $monthFilter.addEventListener('change', () => {
    currentMonth = $monthFilter.value;
    loadAiUsage();
    loadCopilotMetrics();
  });

  async function loadAiUsage() {
    $aiUsersError.style.display = 'none';
    $aiUsersEmpty.style.display = 'none';
    $aiUsersTbody.innerHTML = '<tr><td colspan="6" class="text-muted text-center">Loading AI credits…</td></tr>';
    $mcAllocated.textContent = '…';
    $mcConsumed.textContent = '…';
    $mcRemaining.textContent = '…';
    $mcUtilization.textContent = '…';

    try {
      const monthParam = currentMonth ? `?month=${currentMonth}` : '';
      const data = await api('GET', `/api/ai-usage${monthParam}`);
      const {
        totalAllocated, totalConsumed, userStates, availableMonths,
        seatCount, businessSeats, enterpriseSeats, rates, creditsPerSeat,
      } = data;
      const remaining = totalAllocated > 0 ? totalAllocated - totalConsumed : 0;
      const pct = totalAllocated > 0 ? ((totalConsumed / totalAllocated) * 100) : 0;

      // Update month dropdown (preserve selection)
      updateMonthDropdown(availableMonths);

      // Display in credits (not dollars)
      const allocLabel = totalAllocated > 0
        ? `${formatNumber(totalAllocated)} credits`
        : 'No seats';
      $mcAllocated.textContent = allocLabel;
      if (seatCount > 0) {
        const parts = [];
        if (enterpriseSeats > 0 && rates) parts.push(`${enterpriseSeats} Enterprise × ${formatNumber(rates.enterprise)}`);
        if (businessSeats   > 0 && rates) parts.push(`${businessSeats} Business × ${formatNumber(rates.business)}`);
        $mcAllocated.title = parts.length ? parts.join('  +  ') : `${seatCount} seats × ${formatNumber(creditsPerSeat)} credits`;
      } else {
        $mcAllocated.title = '';
      }
      $mcConsumed.textContent = formatCredits(totalConsumed) + ' credits';
      $mcRemaining.textContent = totalAllocated > 0 ? formatNumber(remaining) + ' credits' : '—';
      $mcUtilization.textContent = totalAllocated > 0 ? pct.toFixed(1) + '%' : '—';

      if (totalAllocated > 0) {
        $usageBarFill.style.width = Math.min(pct, 100) + '%';
        $usageBarUsed.textContent = pct.toFixed(1) + '% used';
        $usageBarTotal.textContent = formatNumber(totalAllocated) + ' credits total';
      } else {
        const consumedPct = totalConsumed > 0 ? 100 : 0;
        $usageBarFill.style.width = consumedPct + '%';
        $usageBarUsed.textContent = formatCredits(totalConsumed) + ' credits consumed';
        $usageBarTotal.textContent = currentMonth ? `Month: ${currentMonth}` : '28-day window';
      }

      renderUserStates(userStates);
    } catch (err) {
      $aiUsersTbody.innerHTML = '';
      $aiUsersError.textContent = err.error || 'Failed to load AI usage data.';
      $aiUsersError.style.display = 'block';
    }
  }

  function updateMonthDropdown(months) {
    if (!months || months.length === 0) return;
    const currentVal = $monthFilter.value || currentMonth;
    // Only rebuild if options changed
    const existingVals = [...$monthFilter.options].map(o => o.value).join(',');
    const newVals = ['', ...months].join(',');
    if (existingVals === newVals) return;

    $monthFilter.innerHTML = '<option value="">All (28-day report)</option>';
    months.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m;
      const [year, mo] = m.split('-');
      const monthName = new Date(year, parseInt(mo) - 1).toLocaleString('en', { month: 'short' });
      opt.textContent = `${monthName} ${year}`;
      $monthFilter.appendChild(opt);
    });
    // Set to current month if available, otherwise keep 'all'
    if (months.includes(currentVal)) {
      $monthFilter.value = currentVal;
    } else {
      $monthFilter.value = '';
      currentMonth = '';
    }
  }

  function formatCredits(n) {
    if (n == null || n === 0) return '0';
    if (Number.isInteger(n)) return n.toLocaleString();
    return n.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 2 });
  }

  function renderUserStates(userStates) {
    $aiUsersTbody.innerHTML = '';
    if (!userStates || userStates.length === 0) {
      $aiUsersEmpty.style.display = 'block';
      return;
    }
    $aiUsersEmpty.style.display = 'none';

    // Already sorted descending by ai_credits_used from server
    const maxCredits = userStates[0]?.ai_credits_used || 1;

    userStates.forEach((s, i) => {
      const credits = s.ai_credits_used || 0;
      const pct = maxCredits > 0 ? ((credits / maxCredits) * 100) : 0;
      const isTop7 = i < 7;

      const tr = document.createElement('tr');
      if (isTop7) tr.className = 'row-top-user';

      const barClass = pct > 90 ? 'danger' : pct > 70 ? 'warn' : '';

      tr.innerHTML = `
        <td><span class="user-rank ${isTop7 ? 'rank-top' : 'rank-normal'}">${i + 1}</span></td>
        <td>${esc(s.user || '—')}</td>
        <td>${formatCredits(credits)} credits</td>
        <td>${s.days_active || 0} days</td>
        <td>${pct.toFixed(1)}%</td>
        <td><div class="cell-bar"><div class="cell-bar-fill ${barClass}" style="width:${Math.min(pct, 100)}%"></div></div></td>
      `;
      $aiUsersTbody.appendChild(tr);
    });
  }

  // ══════════════════════════════════════════════════════════
  //  COPILOT METRICS — IDE breakdown & tokens
  // ══════════════════════════════════════════════════════════
  const $mcTokens       = document.getElementById('mc-tokens');
  const $mcSuggestions  = document.getElementById('mc-suggestions');
  const $mcAcceptances  = document.getElementById('mc-acceptances');
  const $mcAcceptRate   = document.getElementById('mc-accept-rate');
  const $copilotError   = document.getElementById('copilot-error');
  const $copilotIdeTbody = document.getElementById('copilot-ide-tbody');
  const $copilotIdeEmpty = document.getElementById('copilot-ide-empty');
  const $copilotPeriod   = document.getElementById('copilot-report-period');
  const $btnRefreshCopilot = document.getElementById('btn-refresh-copilot');

  $btnRefreshCopilot.addEventListener('click', loadCopilotMetrics);

  async function loadCopilotMetrics() {
    $copilotError.style.display = 'none';
    $copilotIdeEmpty.style.display = 'none';
    $copilotIdeTbody.innerHTML = '<tr><td colspan="6" class="text-muted text-center">Loading Copilot metrics…</td></tr>';
    $mcTokens.textContent = '…';
    $mcSuggestions.textContent = '…';
    $mcAcceptances.textContent = '…';
    $mcAcceptRate.textContent = '…';
    $copilotPeriod.textContent = '';

    try {
      const monthParam = currentMonth ? `?month=${currentMonth}` : '';
      const data = await api('GET', `/api/copilot-metrics${monthParam}`);
      const { ideBreakdown, totalTokens, totalCodeGenActivity, totalCodeAcceptActivity, reportPeriod } = data;

      $mcTokens.textContent = formatNumber(totalTokens);
      $mcSuggestions.textContent = formatNumber(totalCodeGenActivity);
      $mcAcceptances.textContent = formatNumber(totalCodeAcceptActivity);
      const rate = totalCodeGenActivity > 0 ? ((totalCodeAcceptActivity / totalCodeGenActivity) * 100) : 0;
      $mcAcceptRate.textContent = rate.toFixed(1) + '%';

      if (reportPeriod && reportPeriod.start) {
        $copilotPeriod.textContent = `Report period: ${reportPeriod.start} to ${reportPeriod.end}`;
      }

      renderIdeBreakdown(ideBreakdown);
    } catch (err) {
      $copilotIdeTbody.innerHTML = '';
      $copilotError.textContent = err.error || 'Failed to load Copilot metrics.';
      $copilotError.style.display = 'block';
      $copilotIdeEmpty.style.display = 'block';
    }
  }

  function renderIdeBreakdown(ideBreakdown) {
    $copilotIdeTbody.innerHTML = '';
    if (!ideBreakdown || ideBreakdown.length === 0) {
      $copilotIdeEmpty.style.display = 'block';
      return;
    }
    $copilotIdeEmpty.style.display = 'none';

    const totalLoc = ideBreakdown.reduce((sum, ide) => sum + (ide.locAdded || 0), 0);

    ideBreakdown.forEach(ide => {
      const share = totalLoc > 0 ? ((ide.locAdded / totalLoc) * 100) : 0;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${esc(ide.name)}</strong></td>
        <td>${formatNumber(ide.locAdded)}</td>
        <td>${formatNumber(ide.codeGen)}</td>
        <td>${formatNumber(ide.codeAccept)}</td>
        <td>${formatNumber(ide.locSuggested)}</td>
        <td>
          <div class="cell-bar" style="width:100px;">
            <div class="cell-bar-fill" style="width:${Math.min(share, 100)}%"></div>
          </div>
          <span style="margin-left:6px;font-size:.8rem;">${share.toFixed(1)}%</span>
        </td>
      `;
      $copilotIdeTbody.appendChild(tr);
    });
  }

  function formatNumber(n) {
    if (n == null || n === 0) return '0';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return n.toLocaleString();
  }

  // ═══════════════════════════════════════════════════════════
  //  BULK BUDGET CREATION (with Enterprise User Picker)
  // ═══════════════════════════════════════════════════════════
  const $formBulkCreate   = document.getElementById('form-bulk-create');
  const $bulkAmount       = document.getElementById('bulk-amount');
  const $bulkBlock        = document.getElementById('bulk-block');
  const $bulkCredits      = document.getElementById('bulk-credits-preview');
  const $bulkError        = document.getElementById('bulk-create-error');
  const $bulkSuccess      = document.getElementById('bulk-create-success');
  const $btnBulkCreate    = document.getElementById('btn-bulk-create');
  const $btnLoadUsers     = document.getElementById('btn-load-users');
  const $userPickerList   = document.getElementById('user-picker-list');
  const $userPickerSearch = document.getElementById('user-picker-search');
  const $selectedCount    = document.getElementById('selected-count');
  const $btnSelectAll     = document.getElementById('btn-select-all');
  const $btnClearSel      = document.getElementById('btn-clear-selection');

  let enterpriseMembers = [];  // { login, avatar_url, name }
  let selectedUsers = new Set();

  // Update credits preview when amount changes
  if ($bulkAmount) {
    $bulkAmount.addEventListener('input', () => {
      const amt = parseFloat($bulkAmount.value) || 0;
      $bulkCredits.textContent = formatCredits(amt * 100);
    });
  }

  // Load enterprise members
  async function loadEnterpriseMembers() {
    if ($btnLoadUsers) {
      $btnLoadUsers.disabled = true;
      $btnLoadUsers.textContent = 'Loading…';
    }
    $userPickerList.innerHTML = '<p class="text-muted text-center" style="padding:16px;">Fetching enterprise users…</p>';

    try {
      const result = await api('GET', '/api/enterprise-members');
      if ($btnLoadUsers) {
        $btnLoadUsers.disabled = false;
        $btnLoadUsers.textContent = 'Reload';
      }

      enterpriseMembers = result.members || [];
      if (enterpriseMembers.length === 0) {
        $userPickerList.innerHTML = '<p class="text-muted text-center" style="padding:16px;">No users found in usage reports.</p>';
        return;
      }

      renderUserList(enterpriseMembers);
    } catch (err) {
      if ($btnLoadUsers) {
        $btnLoadUsers.disabled = false;
        $btnLoadUsers.textContent = 'Reload';
      }
      $userPickerList.innerHTML = `<p class="error-text text-center" style="padding:16px;">${esc(err.error || err.message || 'Failed to load users')}</p>`;
    }
  }

  if ($btnLoadUsers) {
    $btnLoadUsers.addEventListener('click', loadEnterpriseMembers);
  }

  function renderUserList(members) {
    $userPickerList.innerHTML = '';
    members.forEach(m => {
      const item = document.createElement('div');
      item.className = 'user-picker-item' + (selectedUsers.has(m.login) ? ' selected' : '');
      item.dataset.login = m.login;
      item.innerHTML = `
        <input type="checkbox" ${selectedUsers.has(m.login) ? 'checked' : ''} />
        <img class="user-picker-avatar" src="${esc(m.avatar_url)}" alt="" onerror="this.style.visibility='hidden'" />
        <span class="user-picker-login">${esc(m.login)}</span>
      `;
      item.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT') return; // let checkbox handle itself
        toggleUser(m.login, item);
      });
      item.querySelector('input').addEventListener('change', () => {
        toggleUser(m.login, item);
      });
      $userPickerList.appendChild(item);
    });
    updateSelectedCount();
  }

  function toggleUser(login, itemEl) {
    if (selectedUsers.has(login)) {
      selectedUsers.delete(login);
      itemEl.classList.remove('selected');
      itemEl.querySelector('input').checked = false;
    } else {
      selectedUsers.add(login);
      itemEl.classList.add('selected');
      itemEl.querySelector('input').checked = true;
    }
    updateSelectedCount();
  }

  function updateSelectedCount() {
    $selectedCount.textContent = `${selectedUsers.size} selected`;
    $btnBulkCreate.disabled = selectedUsers.size === 0;
  }

  // Search/filter
  if ($userPickerSearch) {
    $userPickerSearch.addEventListener('input', () => {
      const q = $userPickerSearch.value.toLowerCase().trim();
      if (!q) {
        renderUserList(enterpriseMembers);
        return;
      }
      const filtered = enterpriseMembers.filter(m =>
        m.login.toLowerCase().includes(q) || (m.name && m.name.toLowerCase().includes(q))
      );
      renderUserList(filtered);
    });
  }

  // Select All / Clear
  if ($btnSelectAll) {
    $btnSelectAll.addEventListener('click', () => {
      enterpriseMembers.forEach(m => selectedUsers.add(m.login));
      renderUserList(enterpriseMembers);
    });
  }
  if ($btnClearSel) {
    $btnClearSel.addEventListener('click', () => {
      selectedUsers.clear();
      renderUserList(enterpriseMembers);
    });
  }

  // Submit bulk create
  if ($formBulkCreate) {
    $formBulkCreate.addEventListener('submit', async (e) => {
      e.preventDefault();
      $bulkError.style.display = 'none';
      $bulkSuccess.style.display = 'none';

      if (selectedUsers.size === 0) {
        $bulkError.textContent = 'Please select at least one user.';
        $bulkError.style.display = 'block';
        return;
      }

      const budgetAmount = parseFloat($bulkAmount.value);
      if (!budgetAmount || budgetAmount <= 0) {
        $bulkError.textContent = 'Budget amount must be greater than 0.';
        $bulkError.style.display = 'block';
        return;
      }

      const preventFurtherUsage = $bulkBlock.value === 'true';
      const users = [...selectedUsers];

      $btnBulkCreate.disabled = true;
      $btnBulkCreate.textContent = `Creating ${users.length} budget(s)…`;

      try {
        const result = await api('POST', '/api/budgets-bulk-create', {
          users,
          budgetAmount,
          preventFurtherUsage,
          productSkus: ['ai_credits'],
        });

        const succeeded = result.results.filter(r => r.success).length;
        const failed = result.results.filter(r => !r.success);

        if (succeeded > 0) {
          $bulkSuccess.textContent = `✓ Created ${succeeded} budget(s) successfully.`;
          $bulkSuccess.style.display = 'block';
          selectedUsers.clear();
          renderUserList(enterpriseMembers);
          loadBudgets();
        }

        if (failed.length > 0) {
          const failList = failed.map(f => `${f.user}: ${f.detail || 'Unknown error'}`).join('\n');
          $bulkError.textContent = `Failed for ${failed.length} user(s):\n${failList}`;
          $bulkError.style.display = 'block';
          $bulkError.style.whiteSpace = 'pre-wrap';
        }
      } catch (err) {
        $bulkError.textContent = 'Network error: ' + err.message;
        $bulkError.style.display = 'block';
      } finally {
        $btnBulkCreate.disabled = selectedUsers.size === 0;
        $btnBulkCreate.textContent = 'Create Budgets';
      }
    });
  }

  // ── Restore session on page load ──────────────────────────
  (async function restoreSession() {
    let stored = null;
    try { stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null'); } catch (_) {}
    if (!stored || !stored.sessionId) return;

    sessionId = stored.sessionId;
    enterpriseName = stored.enterpriseName || '';

    try {
      const s = await api('GET', '/api/session');
      enterpriseName = s.enterprise || enterpriseName;
      persistSession();
      showDashboard();
    } catch (err) {
      // Session expired or invalid — fall back to connect panel
      clearSession();
    }
  })();
})();
