  // ── Theme ──────────────────────────────────────────────────────────────
  const html = document.documentElement;
  const stored = localStorage.getItem('theme');
  if (stored) html.setAttribute('data-theme', stored);

  function isDark() {
    const t = html.getAttribute('data-theme');
    if (t) return t === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function updateThemeIcons() {
    document.getElementById('theme-icon-dark').classList.toggle('hidden', !isDark());
    document.getElementById('theme-icon-light').classList.toggle('hidden', isDark());
  }

  document.getElementById('theme-toggle').addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    updateThemeIcons();
  });

  updateThemeIcons();

  // ── Navigation ─────────────────────────────────────────────────────────
  const viewTitles = {
    dashboard:  'Dashboard',
    candidates: 'Candidates',
    queue:      'Encoding Queue',
    history:    'History',
    settings:   'Settings',
  };

  function measureStickyHeader(view) {
    if (window.innerWidth < 769) return;
    const header = view.querySelector('.section-header');
    if (!header || !view.classList.contains('active')) return;

    // section-header sticks at top: 0 within #content (the scroll container).
    // thead uses top: --section-header-h to stick directly below it.
    const headerHeight = Math.ceil(header.getBoundingClientRect().height);
    view.style.setProperty('--section-header-h', `${headerHeight}px`);
  }

  function updateStickyOffsets() {
    if (window.innerWidth < 769) return;
    // Measure ALL table views, not just active — ensures vars are correct
    // before view becomes visible (avoids brief mis-stick on navigation).
    document.querySelectorAll('#view-candidates, #view-queue, #view-history')
      .forEach(measureStickyHeader);
  }

  // Keep offsets accurate as section-header resizes (e.g. filter row wraps)
  if (window.ResizeObserver) {
    const _headerRO = new ResizeObserver(entries => {
      entries.forEach(e => {
        const view = e.target.closest('.view');
        if (view) measureStickyHeader(view);
      });
    });
    document.querySelectorAll('#view-candidates .section-header, #view-queue .section-header, #view-history .section-header')
      .forEach(h => _headerRO.observe(h));
  }

  // Remeasure after fonts load — Inter font changes section-header height
  // when it swaps in, and the initial measurement uses the fallback font.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { updateStickyOffsets(); updateStickyState(); });
  }

  window.addEventListener('resize', updateStickyOffsets);

  // ── Sticky-stuck detection ──────────────────────────────────────────────
  // When the panel scrolls behind the sticky column header, set data-stuck on
  // the view. CSS uses this to overlay a 13×13 var(--bg) patch at the bottom
  // corners of the section-header — covering the th's transparent border-radius
  // cutouts so the rounded corners are visually revealed against --bg.
  let _stickyRAF = null;
  function updateStickyState() {
    if (window.innerWidth < 769) return;
    document.querySelectorAll('#view-candidates, #view-queue, #view-history').forEach(view => {
      if (!view.classList.contains('active')) return;
      const panel = view.querySelector('.panel');
      const sectionHeader = view.querySelector('.section-header');
      if (!panel || !sectionHeader) return;
      // Section-header is fixed at top: 64px. Panel is stuck when scrolled behind it.
      const headerBottom = sectionHeader.getBoundingClientRect().bottom;
      const panelTop = panel.getBoundingClientRect().top;
      if (panelTop < headerBottom) {
        view.dataset.stuck = 'true';
      } else {
        delete view.dataset.stuck;
      }
    });
  }
  const _contentEl = document.getElementById('content');
  if (_contentEl) {
    _contentEl.addEventListener('scroll', () => {
      if (_stickyRAF) return;
      _stickyRAF = requestAnimationFrame(() => {
        updateStickyState();
        _stickyRAF = null;
      });
    });
  }
  window.addEventListener('resize', updateStickyState);

  // ── Pagination state ───────────────────────────────────────────────────
  const _pag = {
    candidates: { page: 1, size: 50, sort_by: 'date_discovered', sort_order: 'desc' },
    queue:      { page: 1, size: 50, sort_by: 'date_created',    sort_order: 'asc'  },
    history:    { page: 1, size: 50, sort_by: 'date_completed',  sort_order: 'desc' },
  };

  function sortTable(tab, field) {
    const p = _pag[tab];
    if (p.sort_by === field) {
      p.sort_order = p.sort_order === 'asc' ? 'desc' : 'asc';
    } else {
      p.sort_by = field;
      p.sort_order = 'asc';
    }
    p.page = 1;
    if (tab === 'candidates') loadCandidates();
    else if (tab === 'queue') loadQueue();
    else loadHistory();
  }

  function sortTh(tab, field, label, p) {
    const active = p.sort_by === field;
    const arrow = active ? (p.sort_order === 'asc' ? ' ↑' : ' ↓') : '';
    return `<th style="cursor:pointer;user-select:none;white-space:nowrap" onclick="sortTable('${tab}','${field}')">${label}${active ? `<span style="color:var(--accent)">${arrow}</span>` : ''}</th>`;
  }

  function renderPaginationBar(tab, total) {
    const p = _pag[tab];
    const totalPages = Math.max(1, Math.ceil(total / p.size));
    const start = total === 0 ? 0 : (p.page - 1) * p.size + 1;
    const end = Math.min(p.page * p.size, total);
    const el = document.getElementById(`${tab}-pagination`);
    if (!el) return;
    if (total <= 25) { el.innerHTML = ''; return; }
    el.innerHTML = `
      <div class="pagination-bar">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="color:var(--text-muted)">${start}–${end} of ${total}</span>
          <select class="form-select" style="width:auto;padding:4px 24px 4px 8px;font-size:12px" id="${tab}-page-size">
            ${[25,50,100].map(n => `<option value="${n}"${p.size===n?' selected':''}>${n} / page</option>`).join('')}
          </select>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <button class="btn btn-ghost btn-sm" id="${tab}-prev-btn" ${p.page<=1?'disabled':''}>← Prev</button>
          <span style="color:var(--text-muted);white-space:nowrap">Page ${p.page} of ${totalPages}</span>
          <button class="btn btn-ghost btn-sm" id="${tab}-next-btn" ${p.page>=totalPages?'disabled':''}>Next →</button>
        </div>
      </div>`;
    const reload = tab==='candidates' ? loadCandidates : tab==='queue' ? loadQueue : loadHistory;
    document.getElementById(`${tab}-page-size`).addEventListener('change', function() {
      _pag[tab].size = parseInt(this.value); _pag[tab].page = 1; reload();
    });
    document.getElementById(`${tab}-prev-btn`)?.addEventListener('click', () => { _pag[tab].page--; reload(); });
    document.getElementById(`${tab}-next-btn`)?.addEventListener('click', () => { _pag[tab].page++; reload(); });
  }

  // Disable browser scroll restoration (prevents scroll jumping on navigation)
  if ('scrollRestoration' in history) {
    history.scrollRestoration = 'manual';
  }

  let _activeView = null;

  function navigateTo(viewName) {
    _activeView = viewName;
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.nav-item, .bottom-nav-item').forEach(n => {
      n.classList.toggle('active', n.dataset.view === viewName);
    });
    const view = document.getElementById('view-' + viewName);
    if (view) view.classList.add('active');
    document.getElementById('topbar-title').textContent = viewTitles[viewName] || viewName;

    // Reset scroll immediately to prevent carrying over previous view's position
    const contentEl = document.getElementById('content');
    if (contentEl) contentEl.scrollTop = 0;

    if (viewName === 'dashboard')  loadDashboard();
    if (viewName === 'candidates') loadCandidates();
    if (viewName === 'queue')      loadQueue();
    if (viewName === 'history')    loadHistory();
    if (viewName === 'settings')   loadSettings();

    // Measure sticky header heights immediately so CSS vars are set before paint
    updateStickyOffsets();
    requestAnimationFrame(() => { updateStickyState(); });
  }

  // Reset scroll to top after content renders in a table view.
  // Double-RAF ensures this runs after layout AND paint complete.
  function resetViewScroll(viewName) {
    if (_activeView !== viewName) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const contentEl = document.getElementById('content');
        if (contentEl) contentEl.scrollTop = 0;
      });
    });
  }

  document.querySelectorAll('[data-view]').forEach(el => {
    el.addEventListener('click', () => navigateTo(el.dataset.view));
  });

  // ── Sidebar collapse ───────────────────────────────────────────────────
  const sidebar = document.getElementById('sidebar');
  const collapseBtn = document.getElementById('collapse-btn');
  const sidebarCollapsed = localStorage.getItem('sidebarCollapsed') === 'true';
  if (sidebarCollapsed) sidebar.classList.add('collapsed');

  collapseBtn.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
    localStorage.setItem('sidebarCollapsed', sidebar.classList.contains('collapsed'));
  });

  // ── Toast ──────────────────────────────────────────────────────────────
  function toast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    document.getElementById('toast-container').appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  // ── Helpers ────────────────────────────────────────────────────────────
  function basename(path) {
    return (path || '').split(/[\\/]/).pop();
  }

  function fmtBytes(b) {
    if (!b) return '—';
    if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
    if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
    return (b / 1e3).toFixed(0) + ' KB';
  }

  function fmtBitrate(kbps) {
    if (!kbps) return '—';
    if (kbps >= 1000) return (kbps / 1000).toFixed(1) + ' Mbps';
    return kbps + ' Kbps';
  }

  function toUtcDate(d) {
    if (!d) return null;
    const s = String(d);
    return new Date(s.endsWith('Z') ? s : s + 'Z');
  }

  function fmtDate(d) {
    if (!d) return '—';
    return toUtcDate(d).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
  }

  function relTime(d) {
    if (!d) return '';
    const diff = Date.now() - toUtcDate(d).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1)  return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h/24)}d ago`;
  }

  function updateEncodingBanner(data) {
    const bannerEl       = document.getElementById('encoding-banner');
    const bannerContentEl= document.getElementById('encoding-banner-content');
    const startBtn       = document.getElementById('queue-start-btn');
    const pauseBtn       = document.getElementById('queue-pause-btn');
    const stopBtn        = document.getElementById('queue-stop-btn');
    const stateLabel     = document.getElementById('enc-banner-state-label');
    if (!bannerEl) return;

    const encoding = data?.encoding || [];
    const paused   = data?.paused   || [];
    const queued   = data?.queued_count || 0;

    bannerEl.classList.remove('state-encoding', 'state-paused', 'state-queued', 'is-multi');

    // Hidden when nothing active in any state
    if (encoding.length === 0 && paused.length === 0 && queued === 0) {
      bannerEl.classList.add('hidden');
      bannerEl.onclick = null;
      return;
    }

    bannerEl.classList.remove('hidden');
    bannerEl.onclick = () => navigateTo('queue');

    // Determine state and which buttons are visible
    let state, label, items;
    if (encoding.length > 0) {
      state = 'encoding'; label = 'Encoding'; items = [...encoding, ...paused];
      startBtn.style.display = 'none';
      pauseBtn.style.display = '';
      pauseBtn.textContent = 'Pause All';
      stopBtn.style.display = '';
    } else if (paused.length > 0) {
      state = 'paused';   label = 'Paused';   items = paused;
      startBtn.style.display = 'none';
      pauseBtn.style.display = '';
      pauseBtn.textContent = 'Resume All';
      stopBtn.style.display = '';
    } else {
      state = 'queued';   label = `${queued} Queued`; items = [];
      startBtn.style.display = '';
      pauseBtn.style.display = 'none';
      stopBtn.style.display = '';
    }
    bannerEl.classList.add('state-' + state);
    bannerEl.classList.toggle('is-multi', items.length > 1);
    stateLabel.textContent = label;

    if (items.length === 0) {
      bannerContentEl.innerHTML = `<div class="enc-banner-meta" style="opacity:0.85">Ready to dispatch — press Start Encoding</div>`;
    } else {
      bannerContentEl.innerHTML = items.map(j => {
        const progress = Math.round(j.progress_percent ?? 0);
        const eta = j.eta_seconds ? formatSeconds(j.eta_seconds) : '—';
        const isPaused = j.status === 'paused';
        return `<div class="enc-banner-file">
          <div class="enc-banner-filename">${escHtml(j.filename)}</div>
          <div class="enc-banner-progress-wrap"><div class="enc-banner-progress-fill" style="width:${progress}%"></div></div>
          <div class="enc-banner-meta">${isPaused ? 'Paused' : `${progress}% · ${eta} remaining`}</div>
        </div>`;
      }).join('');
    }
  }

  // Poll encoding status globally so banner updates from any tab
  async function pollEncodingBanner() {
    try {
      const data = await apiFetch('/api/encoding-status');
      updateEncodingBanner(data);
    } catch (e) {
      console.error('encoding-status poll failed:', e);
    }
  }
  setInterval(pollEncodingBanner, 5000);
  pollEncodingBanner();

  document.getElementById('queue-pause-btn').addEventListener('click', async function () {
    const btn = this;
    const isResume = btn.textContent.trim() === 'Resume All';
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = isResume ? 'Resuming…' : 'Pausing…';
    try {
      await apiFetch(isResume ? '/api/jobs/resume-all' : '/api/jobs/pause-all', { method: 'POST' });
      pollEncodingBanner();
    } catch (e) {
      toast((isResume ? 'Resume' : 'Pause') + ' failed: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });

  function formatSeconds(seconds) {
    if (!seconds || seconds < 0) return '—';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  function badge(status) {
    const dot = `<span class="badge-dot" style="background:currentColor"></span>`;
    return `<span class="badge badge-${status}">${dot}${status}</span>`;
  }

  function dotColor(status) {
    return {
      pending:  '#a09af8',
      approved: '#7ab4fa',
      queued:   '#9ca3af',
      encoding: '#fbbf24',
      paused:   '#60a5fa',
      complete: '#34d399',
      failed:   '#f87171',
      ignored:  '#9ca3af',
      skipped:  '#9ca3af',
    }[status] || '#8888aa';
  }

  async function apiFetch(url, opts = {}) {
    const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || res.statusText);
    }
    return res.json();
  }

  // ── Scan ───────────────────────────────────────────────────────────────
  document.getElementById('scan-btn').addEventListener('click', async function () {
    const btn = this;
    btn.disabled = true;
    btn.innerHTML = `<div class="spinner"></div> Scanning…`;
    document.getElementById('scan-result').classList.add('hidden');
    try {
      const r = await apiFetch('/api/scan', { method: 'POST' });
      const el = document.getElementById('scan-result');
      el.classList.remove('hidden');
      el.innerHTML = `
        <div class="scan-result">
          <div class="scan-result-item"><div class="scan-result-num">${r.scanned}</div><div class="scan-result-label">Scanned</div></div>
          <div class="scan-result-item"><div class="scan-result-num">${r.added}</div><div class="scan-result-label">Added</div></div>
          <div class="scan-result-item"><div class="scan-result-num">${r.errors}</div><div class="scan-result-label">Errors</div></div>
        </div>`;
      toast(`Scan complete — ${r.added} new candidate(s) found`, 'success');
      loadDashboard();
    } catch (e) {
      toast('Scan failed: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Scan Library`;
    }
  });

  document.getElementById('eval-rules-btn').addEventListener('click', async function () {
    const btn = this;
    const originalHTML = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<div class="spinner"></div> Evaluating…`;
    try {
      const result = await apiFetch('/api/auto-approve/evaluate', { method: 'POST' });
      toast(`Auto-approve: ${result.approved} candidate(s) approved and queued`, result.approved > 0 ? 'success' : 'info');
      loadDashboard();
      loadCandidates();
    } catch (e) {
      toast('Evaluate failed: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalHTML;
    }
  });

  document.getElementById('queue-start-btn').addEventListener('click', async function () {
    const btn = this;
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = 'Starting…';
    try {
      await apiFetch('/api/jobs/dispatch', { method: 'POST' });
      pollEncodingBanner();
      loadDashboard();
    } catch (e) {
      toast('Start failed: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });

  document.getElementById('queue-stop-btn').addEventListener('click', function () {
    document.getElementById('stop-all-confirm-modal').classList.add('open');
  });

  document.getElementById('stop-all-cancel-btn').addEventListener('click', function () {
    document.getElementById('stop-all-confirm-modal').classList.remove('open');
  });

  document.getElementById('stop-all-ok-btn').addEventListener('click', async function () {
    const modal = document.getElementById('stop-all-confirm-modal');
    const btn = this;
    modal.classList.remove('open');
    btn.disabled = true;
    try {
      await apiFetch('/api/jobs/stop-all', { method: 'POST' });
      pollEncodingBanner();
      loadDashboard();
    } catch (e) {
      toast('Stop failed: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  // ── Dashboard ──────────────────────────────────────────────────────────
  async function loadDashboard() {
    try {
      const [status, jobsData] = await Promise.all([
        apiFetch('/api/status'),
        apiFetch('/api/jobs?limit=10'),
      ]);
      const jobs = jobsData.items;
      loadDashboardScanStatus();
      document.getElementById('stat-total').textContent             = status.scan.total ?? '—';
      document.getElementById('stat-encode-candidates').textContent = status.scan.encode_candidates ?? '—';
      document.getElementById('stat-pending').textContent           = status.scan.pending ?? '—';
      const missingCount = status.scan.missing ?? 0;
      const removedCard = document.getElementById('stat-removed-card');
      removedCard.style.display = missingCount > 0 ? '' : 'none';
      document.getElementById('stat-removed').textContent = missingCount;
      document.getElementById('stat-saved').textContent             = fmtBytes(status.queue.total_bytes_saved ?? 0);
      document.getElementById('stat-queued').textContent            = status.queue.queued ?? '—';
      document.getElementById('stat-encoding').textContent          = status.queue.encoding ?? '—';
      document.getElementById('stat-complete').textContent          = status.queue.complete ?? '—';
      document.getElementById('stat-failed').textContent            = status.queue.failed ?? '—';

      // Banner is updated via its own poll — no per-dashboard work needed

      const recent = jobs.slice(0, 10);
      const list = document.getElementById('activity-list');
      if (recent.length === 0) {
        list.innerHTML = `<div class="empty-state">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          <p>No recent activity</p></div>`;
        return;
      }
      list.innerHTML = recent.map(j => `
        <div class="activity-item">
          <div class="activity-dot" style="background:${dotColor(j.status)}"></div>
          <div class="activity-info">
            <div class="activity-name">${escHtml(basename(j.candidate?.file_path || ''))}</div>
            <div class="activity-meta">${j.target_codec?.toUpperCase()} · ${badge(j.status)}</div>
          </div>
          <div class="activity-time">${relTime(j.date_created)}</div>
        </div>`).join('');
    } catch (e) {
      toast('Failed to load dashboard: ' + e.message, 'error');
    } finally {
      fitStatValues();
    }
  }

  async function loadDashboardScanStatus() {
    try {
      const s = await apiFetch('/api/settings');
      const scanEnabled = s.scan_schedule_enabled === 'true';
      const approveEnabled = s.auto_approve_enabled === 'true';
      const cpuLimit = parseInt(s.encode_cpu_limit_percent ?? '100', 10);
      const cpuActive = cpuLimit < 100;

      const dot = (on) => `<span class="scan-status-dot" style="background:${on ? '#34d399' : '#4a4a78'}"></span>`;
      document.getElementById('dash-auto-scan').innerHTML    = dot(scanEnabled) + (scanEnabled ? 'Enabled' : 'Disabled');
      document.getElementById('dash-auto-approve').innerHTML = dot(approveEnabled) + (approveEnabled ? 'Enabled' : 'Disabled');
      document.getElementById('dash-cpu-governor').innerHTML = dot(cpuActive) + (cpuActive ? `Active (${cpuLimit}%)` : 'Off');
      document.getElementById('dash-next-scan').textContent  = s.next_scheduled_scan ? new Date(s.next_scheduled_scan).toLocaleString() : 'N/A';
      document.getElementById('dash-last-scan').textContent  = s.last_scheduled_scan ? new Date(s.last_scheduled_scan).toLocaleString() : 'Never';
    } catch (_) {}
  }

  // ── Resizable columns ──────────────────────────────────────────────────
  // Widths are stored as PERCENTAGES (summing to 100) so the table scales
  // with the panel when the window is resized. localStorage key is `col-pct-*`
  // — old `col-widths-*` (px-based) entries are ignored intentionally.
  function initResizableColumns(tableEl, tabKey) {
    if (window.innerWidth < 768) return;
    const ths = Array.from(tableEl.querySelectorAll('thead th'));
    if (ths.length < 2) return;
    const saved = JSON.parse(localStorage.getItem('col-pct-' + tabKey) || 'null');
    if (saved && saved.length === ths.length) {
      ths.forEach((th, i) => { th.style.width = saved[i] + '%'; });
    } else {
      // Measure natural widths under auto layout, cap each at 400px so a long
      // filename doesn't dominate, then convert to percentages of the total
      // so columns sum to 100% and scale with panel width on window resize.
      const widths = ths.map(th => Math.min(th.offsetWidth, 400));
      const total = widths.reduce((s, w) => s + w, 0) || 1;
      ths.forEach((th, i) => {
        th.style.width = ((widths[i] / total) * 100).toFixed(2) + '%';
      });
    }
    // Fixed layout strictly enforces the th widths and lets .file-name
    // (max-width:100%) truncate at the column boundary instead of expanding
    // the column to fit the full filename.
    tableEl.style.tableLayout = 'fixed';
    ths.slice(0, -1).forEach((th, i) => {
      // Don't set position: relative — it would override position: sticky from the
      // desktop media query and break sticky column headers. Sticky is already a
      // positioned element so absolute children (.col-resizer) use it as their
      // containing block.
      const handle = document.createElement('span');
      handle.className = 'col-resizer';
      handle.addEventListener('click', e => e.stopPropagation());
      handle.addEventListener('mousedown', e => {
        e.preventDefault();
        e.stopPropagation();
        const tableW = tableEl.offsetWidth || 1;
        const startX = e.pageX;
        const startW = ths[i].offsetWidth;
        const onMove = mv => {
          const newW = Math.max(40, startW + mv.pageX - startX);
          ths[i].style.width = ((newW / tableW) * 100).toFixed(2) + '%';
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          const w = tableEl.offsetWidth || 1;
          const pcts = ths.map(t => +((t.offsetWidth / w) * 100).toFixed(2));
          localStorage.setItem('col-pct-' + tabKey, JSON.stringify(pcts));
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
      th.appendChild(handle);
    });
  }

  // ── Candidates ─────────────────────────────────────────────────────────
  async function loadCandidates() {
    const wrap = document.getElementById('candidates-table-wrap');
    const status = document.getElementById('candidates-filter').value;
    const encodeOnly = document.getElementById('candidates-encode-only').checked;
    const search = document.getElementById('candidates-search').value.trim();
    wrap.innerHTML = `<div class="empty-state"><div class="spinner" style="margin:0 auto 12px;"></div><p>Loading…</p></div>`;
    try {
      const p = _pag.candidates;
      const params = new URLSearchParams({
        encode_candidates_only: encodeOnly,
        limit: p.size,
        offset: (p.page - 1) * p.size,
        sort_by: p.sort_by,
        sort_order: p.sort_order,
      });
      if (status) params.set('status', status);
      if (search) params.set('search', search);
      const { items: candidates, total } = await apiFetch(`/api/candidates?${params}`);
      renderPaginationBar('candidates', total);
      if (candidates.length === 0) {
        wrap.innerHTML = `<div class="empty-state">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18"/><line x1="7" y1="2" x2="7" y2="22"/></svg>
          <p>No candidates found</p></div>`;
        return;
      }
      wrap.innerHTML = `
        <table class="data-table">
          <thead><tr>
            <th>File</th>
            <th>Codec</th>
            <th>Bitrate</th>
            <th>Size</th>
            <th>Est. Savings</th>
            <th>Status</th>
            <th>Actions</th>
          </tr></thead>
          <tbody>${candidates.map(c => `
            <tr>
              <td data-label="File">
                <div class="file-name" title="${escHtml(c.file_path)}">${escHtml(basename(c.file_path))}</div>
                <div class="file-path-muted" title="${escHtml(c.file_path)}">${escHtml(c.file_path)}</div>
              </td>
              <td data-label="Codec"><code style="font-size:12px">${escHtml(c.current_codec || '—')}</code></td>
              <td data-label="Bitrate">${fmtBitrate(c.current_bitrate)}</td>
              <td data-label="Size">${fmtBytes(c.file_size_bytes)}</td>
              <td data-label="Est. Savings">${c.estimated_savings_percent != null ? `<span class="savings-pill${c.estimated_savings_percent < 0 ? ' negative' : ''}">~${c.estimated_savings_percent.toFixed(0)}%</span>` : '—'}</td>
              <td data-label="Status">${badge(c.status)}${c.auto_approved_rule_id != null ? '<span class="badge badge-auto" style="margin-left:5px">auto</span>' : ''}</td>
              <td data-label="Actions">
                <div class="action-cell">
                  ${c.status === 'pending' ? `
                    <button class="btn btn-ghost btn-sm" data-fname="${escHtml(basename(c.file_path))}" onclick="openApproveModal(${c.id}, this.dataset.fname)">Approve</button>
                    <button class="btn btn-danger-ghost btn-sm" onclick="skipCandidate(${c.id}, this)">Skip</button>
                  ` : c.status === 'failed' ? `
                    <button class="btn btn-ghost btn-sm" data-fname="${escHtml(basename(c.file_path))}" onclick="openApproveModal(${c.id}, this.dataset.fname, true)">Retry</button>
                    <button class="btn btn-danger-ghost btn-sm" onclick="ignoreCandidate(${c.id}, this)">Ignore</button>
                  ` : '—'}
                </div>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>`;
      const tbl = wrap.querySelector('table');
      if (tbl) {
        initResizableColumns(tbl, 'candidates');
        // Remeasure header heights now that table is rendered
        requestAnimationFrame(() => {
          const view = document.getElementById('view-candidates');
          if (view) measureStickyHeader(view);
        });
      }
    } catch (e) {
      wrap.innerHTML = `<div class="empty-state"><p>Error: ${escHtml(e.message)}</p></div>`;
      toast('Failed to load candidates: ' + e.message, 'error');
    } finally {
      resetViewScroll('candidates');
    }
  }

  document.getElementById('candidates-filter').addEventListener('change', () => { _pag.candidates.page = 1; loadCandidates(); });
  document.getElementById('candidates-encode-only').addEventListener('change', () => { _pag.candidates.page = 1; loadCandidates(); });
  document.getElementById('candidates-refresh').addEventListener('click', loadCandidates);
  document.getElementById('candidates-sort-by').addEventListener('change', function() {
    _pag.candidates.sort_by = this.value; _pag.candidates.page = 1; loadCandidates();
  });
  document.getElementById('candidates-sort-dir').addEventListener('click', function() {
    const p = _pag.candidates;
    p.sort_order = p.sort_order === 'asc' ? 'desc' : 'asc';
    this.textContent = p.sort_order === 'asc' ? '↑' : '↓';
    p.page = 1; loadCandidates();
  });
  let _searchDebounce;
  document.getElementById('candidates-search').addEventListener('input', function() {
    clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(() => { _pag.candidates.page = 1; loadCandidates(); }, 300);
  });

  // ── Skip ───────────────────────────────────────────────────────────────
  async function skipCandidate(id, btn) {
    btn.disabled = true;
    try {
      await apiFetch(`/api/candidates/${id}/skip`, { method: 'POST' });
      toast('Candidate skipped', 'info');
      loadCandidates();
    } catch (e) {
      toast('Skip failed: ' + e.message, 'error');
      btn.disabled = false;
    }
  }

  async function ignoreCandidate(id, btn) {
    btn.disabled = true;
    try {
      await apiFetch(`/api/candidates/${id}/ignore`, { method: 'POST' });
      toast('Candidate ignored', 'success');
      loadCandidates();
      loadDashboard();
    } catch (e) {
      toast('Ignore failed: ' + e.message, 'error');
      btn.disabled = false;
    }
  }

  // ── Retry candidate's failed job ───────────────────────────────────────
  async function retryCandidateJob(candidateId, btn) {
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const { items: failedJobs } = await apiFetch(`/api/jobs?status=failed&limit=1000`);
      const match = failedJobs
        .filter(j => j.candidate_id === candidateId)
        .sort((a, b) => new Date(b.date_created) - new Date(a.date_created))[0];
      if (!match) throw new Error('No failed job found for this candidate');
      await apiFetch(`/api/jobs/${match.id}/retry`, { method: 'POST' });
      toast('Job requeued for encoding', 'success');
      loadCandidates();
    } catch (e) {
      toast('Retry failed: ' + e.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Retry';
    }
  }

  // ── Approve modal ──────────────────────────────────────────────────────
  let pendingApproveId = null;
  let pendingRetryJobId = null;
  let _approveSourceKbps = 0;

  // Estimated HEVC output bitrate as fraction of source — software (x265 CRF) vs hardware (NVENC VBR-CQ)
  const QUALITY_EST_RATIOS = {
    software: { 1: 0.20, 2: 0.35, 3: 0.50, 4: 0.65, 5: 0.82 },
    hardware: { 1: 0.28, 2: 0.45, 3: 0.62, 4: 0.78, 5: 0.92 },
  };

  function _updateQualityEstimates() {
    if (!_approveSourceKbps) return;
    const isHw = document.getElementById('hw-toggle').checked;
    const ratios = isHw ? QUALITY_EST_RATIOS.hardware : QUALITY_EST_RATIOS.software;
    document.querySelectorAll('#quality-btns .quality-btn').forEach(b => {
      const q = parseInt(b.dataset.quality);
      const est = b.querySelector('.quality-est');
      if (!est) return;
      est.textContent = q > 0 ? '~' + fmtBitrate(Math.round(_approveSourceKbps * ratios[q])) : '';
    });
  }

  async function openApproveModal(id, name, isRetry = false) {
    pendingApproveId = id;
    pendingRetryJobId = null;
    _approveSourceKbps = 0;
    document.getElementById('approve-modal-filename').textContent = name;
    document.getElementById('codec-select').value = 'hevc';
    document.getElementById('hw-toggle').checked = false;
    document.getElementById('hw-type-group').style.display = 'none';
    // Reset quality, clear any previous recommendation or estimates
    document.getElementById('approve-bitrate-hint').textContent = '';
    // Fetch settings + hardware in parallel; fire candidate bitrate in background
    const [settingsResult, hwResult] = await Promise.allSettled([
      apiFetch('/api/settings'),
      apiFetch('/api/hardware'),
    ]);
    const sv = settingsResult.status === 'fulfilled' ? settingsResult.value : {};
    const defaultQuality     = String(sv.default_quality_level ?? '0');
    const defaultMode        = sv.default_output_mode ?? 'copy';
    const defaultResolution  = sv.default_resolution ?? '';

    document.querySelectorAll('#quality-btns .quality-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.quality === defaultQuality);
      b.classList.remove('recommended');
      const est = b.querySelector('.quality-est');
      if (est) est.textContent = '';
    });
    document.querySelectorAll('#output-mode-btns .segmented-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === defaultMode));
    document.getElementById('resolution-select').value = defaultResolution;

    // Candidate bitrate — advisory recommendation only, never overrides the default selection
    apiFetch(`/api/candidates/${id}`).then(candidate => {
      const kbps = candidate.current_bitrate;
      if (!kbps) return;
      _approveSourceKbps = kbps;
      // Mirror auto_approve._recommend_quality: HEVC/H265/AV1 sources only
      // reliably shrink at High Compress (2) — anything higher targets a
      // bitrate band the efficient source codec was already in.
      const codec = (candidate.current_codec || '').toLowerCase();
      const alreadyEfficient = codec === 'hevc' || codec === 'h265' || codec === 'av1';
      const rec = alreadyEfficient ? 2
                : kbps > 15000 ? 4
                : kbps > 5000  ? 3
                : kbps > 2000  ? 2
                : 1;
      document.querySelectorAll('#quality-btns .quality-btn').forEach(b => {
        b.classList.toggle('recommended', parseInt(b.dataset.quality) === rec);
      });
      document.getElementById('approve-bitrate-hint').textContent =
        `★ ${QUALITY_LABELS[rec]} recommended · source: ${fmtBitrate(kbps)}`;
      _updateQualityEstimates();
    }).catch(() => {});

    // Apply hardware results using saved defaults
    if (hwResult.status === 'fulfilled') {
      const hw = hwResult.value;
      const hwToggle = document.getElementById('hw-toggle');
      const hwNoneNote = document.getElementById('hw-none-note');
      const hwTypeSelect = document.getElementById('hw-type-select');
      const HW_OPTIONS = [
        { key: 'nvenc',        value: 'nvenc',        label: 'NVENC (NVIDIA)' },
        { key: 'vaapi',        value: 'vaapi',        label: 'VAAPI (Linux/AMD)' },
        { key: 'videotoolbox', value: 'videotoolbox', label: 'VideoToolbox (Apple)' },
      ];
      hwTypeSelect.innerHTML = '';
      HW_OPTIONS.forEach(opt => {
        if (hw[opt.key]) {
          const el = document.createElement('option');
          el.value = opt.value;
          el.textContent = opt.label;
          hwTypeSelect.appendChild(el);
        }
      });
      if (hw.any) {
        hwToggle.disabled = false;
        hwNoneNote.style.display = 'none';
        const useHw = sv.default_use_hardware === 'true';
        hwToggle.checked = useHw;
        document.getElementById('hw-type-group').style.display = useHw ? 'block' : 'none';
        if (useHw) {
          const savedType = sv.default_hardware_type;
          if (savedType && hwTypeSelect.querySelector(`option[value="${savedType}"]`)) {
            hwTypeSelect.value = savedType;
          }
          _updateQualityEstimates();
        }
      } else {
        hwToggle.disabled = true;
        hwNoneNote.style.display = 'block';
      }
    }

    document.getElementById('approve-modal').classList.add('open');

    if (isRetry) {
      document.getElementById('approve-modal').dataset.mode = 'retry';
      try {
        const { items: failedJobs2 } = await apiFetch(`/api/jobs?status=failed&limit=1000`);
        const match = failedJobs2
          .filter(j => j.candidate_id === id)
          .sort((a, b) => new Date(b.date_created) - new Date(a.date_created))[0];
        if (!match) throw new Error('No failed job found for this candidate');
        pendingRetryJobId = match.id;
      } catch (e) {
        toast('Could not find failed job: ' + e.message, 'error');
        document.getElementById('approve-modal').classList.remove('open');
        document.getElementById('approve-modal').dataset.mode = '';
        pendingApproveId = null;
      }
    } else {
      document.getElementById('approve-modal').dataset.mode = 'approve';
    }
  }

  document.getElementById('hw-toggle').addEventListener('change', function () {
    document.getElementById('hw-type-group').style.display = this.checked ? 'block' : 'none';
    _updateQualityEstimates();
  });

  document.getElementById('quality-btns').addEventListener('click', function (e) {
    const btn = e.target.closest('.quality-btn');
    if (!btn) return;
    // Remove active from all but keep recommended ring so the suggestion stays visible
    this.querySelectorAll('.quality-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });

  document.getElementById('output-mode-btns').addEventListener('click', function (e) {
    const btn = e.target.closest('.segmented-btn');
    if (!btn) return;
    this.querySelectorAll('.segmented-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });

  function closeApproveModal() {
    const el = document.getElementById('approve-modal');
    el.classList.remove('open');
    el.dataset.mode = '';
    pendingApproveId = null;
    pendingRetryJobId = null;
  }

  document.getElementById('approve-cancel').addEventListener('click', closeApproveModal);

  document.getElementById('approve-modal').addEventListener('click', function (e) {
    if (e.target === this) closeApproveModal();
  });

  document.getElementById('approve-submit').addEventListener('click', async function () {
    if (!pendingApproveId) return;
    const isRetry = document.getElementById('approve-modal').dataset.mode === 'retry';
    const useHardware = document.getElementById('hw-toggle').checked;
    const activeQuality = document.querySelector('#quality-btns .quality-btn.active');
    const resolutionVal = document.getElementById('resolution-select').value;
    const activeMode = document.querySelector('#output-mode-btns .segmented-btn.active');
    const body = {
      target_codec:  document.getElementById('codec-select').value,
      use_hardware:  useHardware,
      hardware_type: useHardware ? document.getElementById('hw-type-select').value : null,
      quality_level: activeQuality ? parseInt(activeQuality.dataset.quality, 10) : 3,
      resolution:    resolutionVal || null,
      output_mode:   activeMode ? activeMode.dataset.mode : 'replace',
    };
    this.disabled = true;
    this.innerHTML = `<div class="spinner"></div> ${isRetry ? 'Retrying…' : 'Approving…'}`;
    try {
      if (isRetry) {
        if (!pendingRetryJobId) throw new Error('No failed job id available');
        await apiFetch(`/api/jobs/${pendingRetryJobId}/retry`, { method: 'POST', body: JSON.stringify(body) });
        toast('Job requeued for encoding', 'success');
      } else {
        await apiFetch(`/api/candidates/${pendingApproveId}/approve`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        toast('Candidate approved — encoding queued', 'success');
      }
      closeApproveModal();
      loadCandidates();
      loadDashboard();
    } catch (e) {
      toast((isRetry ? 'Retry' : 'Approve') + ' failed: ' + e.message, 'error');
    } finally {
      this.disabled = false;
      this.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Approve`;
    }
  });

  // ── Error detail modal ────────────────────────────────────────────────
  function openErrorModal(err, fname) {
    document.getElementById('error-modal-filename').textContent = fname || '';
    document.getElementById('error-modal-text').value = err || '';
    document.getElementById('error-modal').classList.add('open');
  }

  document.getElementById('error-modal-close').addEventListener('click', () => {
    document.getElementById('error-modal').classList.remove('open');
  });

  document.getElementById('error-modal-copy').addEventListener('click', function () {
    const text = document.getElementById('error-modal-text').value;
    const btn = this;
    const markCopied = () => { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy'; }, 2000); };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(markCopied).catch(() => execCopy(text, markCopied));
    } else {
      execCopy(text, markCopied);
    }
  });

  function execCopy(text, onSuccess) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand('copy');
      onSuccess();
    } catch (_) {
      toast('Copy failed — please select and copy manually', 'error');
    } finally {
      document.body.removeChild(ta);
    }
  }

  document.getElementById('error-modal').addEventListener('click', function (e) {
    if (e.target === this) this.classList.remove('open');
  });

  // ── Retry job ─────────────────────────────────────────────────────────
  async function retryJob(id, btn) {
    btn.disabled = true;
    btn.textContent = '…';
    try {
      await apiFetch(`/api/jobs/${id}/retry`, { method: 'POST' });
      toast('Job requeued for encoding', 'success');
      loadHistory();
      loadDashboard();
    } catch (e) {
      toast('Retry failed: ' + e.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Retry';
    }
  }

  // ── Queue ──────────────────────────────────────────────────────────────
  async function loadQueue() {
    const wrap = document.getElementById('queue-table-wrap');
    wrap.innerHTML = `<div class="empty-state"><div class="spinner" style="margin:0 auto 12px;"></div><p>Loading…</p></div>`;
    try {
      const p = _pag.queue;
      const params = new URLSearchParams({
        status: 'queued,encoding,paused',
        queue_order: true,
        limit: p.size,
        offset: (p.page - 1) * p.size,
      });
      const { items: jobs, total } = await apiFetch(`/api/jobs?${params}`);
      renderPaginationBar('queue', total);
      if (jobs.length === 0) {
        wrap.innerHTML = `<div class="empty-state">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
            <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
          </svg>
          <p>Queue is empty</p></div>`;
        return;
      }
      // Client-side sort for queue (always small)
      const qp = _pag.queue;
      jobs.sort((a, b) => {
        if (a.status === 'encoding' && b.status !== 'encoding') return -1;
        if (a.status !== 'encoding' && b.status === 'encoding') return 1;
        const av = a[qp.sort_by] ?? '', bv = b[qp.sort_by] ?? '';
        return qp.sort_order === 'asc' ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1);
      });
      wrap.innerHTML = renderJobsTable(jobs, false, _pag.queue);
      const tbl = wrap.querySelector('table');
      if (tbl) {
        initResizableColumns(tbl, 'queue');
        requestAnimationFrame(() => {
          const view = document.getElementById('view-queue');
          if (view) measureStickyHeader(view);
        });
      }
    } catch (e) {
      wrap.innerHTML = `<div class="empty-state"><p>Error: ${escHtml(e.message)}</p></div>`;
      toast('Failed to load queue: ' + e.message, 'error');
    } finally {
      resetViewScroll('queue');
    }
  }

  document.getElementById('queue-refresh').addEventListener('click', loadQueue);

  // ── History ────────────────────────────────────────────────────────────
  async function loadHistory() {
    const wrap = document.getElementById('history-table-wrap');
    wrap.innerHTML = `<div class="empty-state"><div class="spinner" style="margin:0 auto 12px;"></div><p>Loading…</p></div>`;
    try {
      const p = _pag.history;
      const params = new URLSearchParams({
        status: 'complete,failed,ignored',
        limit: p.size,
        offset: (p.page - 1) * p.size,
        sort_by: p.sort_by,
        sort_order: p.sort_order,
      });
      const { items: jobs, total } = await apiFetch(`/api/jobs?${params}`);
      renderPaginationBar('history', total);
      if (jobs.length === 0) {
        wrap.innerHTML = `<div class="empty-state">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
          </svg>
          <p>No completed jobs yet</p></div>`;
        return;
      }
      wrap.innerHTML = renderJobsTable(jobs, true, p);
      const tbl = wrap.querySelector('table');
      if (tbl) {
        initResizableColumns(tbl, 'history');
        requestAnimationFrame(() => {
          const view = document.getElementById('view-history');
          if (view) measureStickyHeader(view);
        });
      }
    } catch (e) {
      wrap.innerHTML = `<div class="empty-state"><p>Error: ${escHtml(e.message)}</p></div>`;
      toast('Failed to load history: ' + e.message, 'error');
    } finally {
      resetViewScroll('history');
    }
  }

  document.getElementById('history-refresh').addEventListener('click', loadHistory);
  document.getElementById('history-clear').addEventListener('click', () => {
    openResetConfirmModal(
      '/api/settings/reset-history',
      'Clear Encode History?',
      'This will permanently delete all completed, failed, and ignored encode jobs from history. This cannot be undone.'
    );
  });

  // ── Shared job table renderer ──────────────────────────────────────────
  const QUALITY_LABELS = { 0: 'Auto', 1: 'Max Compress', 2: 'High Compress', 3: 'Balanced', 4: 'High Quality', 5: 'Near Lossless' };

  function renderJobsTable(jobs, showCompleted = false, p = null) {
    const tab = showCompleted ? 'history' : 'queue';
    const sp = p || _pag[tab];
    return `
      <table class="data-table">
        <thead><tr>
          <th>File</th>
          ${sortTh(tab,'target_codec','Codec',sp)}
          <th>Hardware</th>
          ${sortTh(tab,'original_size_bytes','Original',sp)}
          ${showCompleted ? `${sortTh(tab,'final_size_bytes','Final',sp)}<th>Savings</th>` : ''}
          ${sortTh(tab,'quality_level','Quality',sp)}
          ${sortTh(tab,'status','Status',sp)}
          ${sortTh(tab, showCompleted ? 'date_completed' : 'date_created', showCompleted ? 'Completed' : 'Created', sp)}
          ${showCompleted ? '<th>Error</th>' : '<th></th>'}
        </tr></thead>
        <tbody>${jobs.map(j => {
          const fname = basename(j.candidate?.file_path || '');
          const savings = (j.original_size_bytes && j.final_size_bytes)
            ? (((j.original_size_bytes - j.final_size_bytes) / j.original_size_bytes) * 100).toFixed(1)
            : null;
          const qualityLabel = QUALITY_LABELS[j.quality_level] || '—';
          let actionCell = '<td></td>';
          if (!showCompleted) {
            if (j.status === 'encoding') {
              actionCell = `<td style="white-space:nowrap">
                <button class="btn btn-ghost btn-sm" style="margin-right:4px" onclick="pauseJob(${j.id}, this)">Pause</button>
                <button class="btn btn-danger-ghost btn-sm" onclick="cancelJob(${j.id}, this)">Cancel</button>
              </td>`;
            } else if (j.status === 'paused') {
              actionCell = `<td style="white-space:nowrap">
                <button class="btn btn-ghost btn-sm" style="margin-right:4px" onclick="resumeJob(${j.id}, this)">Resume</button>
                <button class="btn btn-danger-ghost btn-sm" onclick="cancelJob(${j.id}, this)">Cancel</button>
              </td>`;
            } else if (j.status === 'queued') {
              actionCell = `<td style="white-space:nowrap">
                <button class="btn btn-ghost btn-sm" style="margin-right:4px" onclick="pauseJob(${j.id}, this)">Pause</button>
                <button class="btn btn-ghost btn-sm" onclick="removeJob(${j.id}, this)">Remove</button>
              </td>`;
            }
          }
          return `<tr>
            <td data-label="File">
              <div class="file-name" title="${escHtml(j.candidate?.file_path || '')}">${escHtml(fname || `Job #${j.id}`)}</div>
            </td>
            <td data-label="Codec"><code style="font-size:12px">${escHtml(j.target_codec?.toUpperCase() || '—')}</code></td>
            <td data-label="Hardware">${j.use_hardware ? `<span class="badge badge-approved">${escHtml(j.hardware_type || 'hw')}</span>` : '<span class="text-muted">software</span>'}</td>
            <td data-label="Original">
              <div>${fmtBytes(j.original_size_bytes)}</div>
              ${j.candidate?.current_bitrate ? `<div style="font-size:11px;color:var(--text-muted)">${fmtBitrate(j.candidate.current_bitrate)}</div>` : ''}
            </td>
            ${showCompleted ? `
              <td data-label="Final">
                <div>${fmtBytes(j.final_size_bytes)}</div>
                ${(j.final_size_bytes && j.candidate?.duration_seconds) ? `<div style="font-size:11px;color:var(--text-muted)">${fmtBitrate(Math.round(j.final_size_bytes * 8 / j.candidate.duration_seconds / 1000))}</div>` : ''}
              </td>
              <td data-label="Savings">${savings != null ? `<span class="savings-pill${savings < 0 ? ' negative' : ''}">${savings > 0 ? '↓' : '↑'}${Math.abs(savings)}%</span>` : '—'}</td>
            ` : ''}
            <td data-label="Quality" style="font-size:12px;color:var(--text-muted)">${escHtml(qualityLabel)}</td>
            <td data-label="Status">${badge(j.status)}${j.candidate?.auto_approved_rule_id != null ? '<span class="badge badge-auto" style="margin-left:5px">auto</span>' : ''}</td>
            <td data-label="${showCompleted ? 'Completed' : 'Created'}" style="font-size:12px;color:var(--text-muted)">${fmtDate(showCompleted ? j.date_completed : j.date_created)}</td>
            ${showCompleted ? `<td data-label="Error" style="font-size:12px;color:var(--badge-failed-text);max-width:300px;word-break:break-word;${j.error_message ? 'cursor:pointer;text-decoration:underline dotted' : ''}" ${j.error_message ? `data-err="${escHtml(j.error_message)}" data-fname="${escHtml(fname || `Job #${j.id}`)}" onclick="openErrorModal(this.dataset.err,this.dataset.fname)"` : ''}>${escHtml(j.error_message || '—')}</td>` : actionCell}
          </tr>`;
        }).join('')}
        </tbody>
      </table>`;
  }

  async function cancelJob(id, btn) {
    btn.disabled = true;
    try {
      await apiFetch(`/api/jobs/${id}/cancel`, { method: 'POST' });
      toast('Encode job cancelled', 'success');
      loadQueue();
      loadDashboard();
    } catch (e) {
      toast('Cancel failed: ' + e.message, 'error');
      btn.disabled = false;
    }
  }

  async function pauseJob(id, btn) {
    btn.disabled = true;
    try {
      await apiFetch(`/api/jobs/${id}/pause`, { method: 'POST' });
      toast('Encode job paused', 'success');
      loadQueue();
      loadDashboard();
    } catch (e) {
      toast('Pause failed: ' + e.message, 'error');
      btn.disabled = false;
    }
  }

  async function resumeJob(id, btn) {
    btn.disabled = true;
    try {
      await apiFetch(`/api/jobs/${id}/resume`, { method: 'POST' });
      toast('Encode job resumed', 'success');
      loadQueue();
      loadDashboard();
    } catch (e) {
      toast('Resume failed: ' + e.message, 'error');
      btn.disabled = false;
    }
  }

  async function removeJob(id, btn) {
    btn.disabled = true;
    try {
      await apiFetch(`/api/jobs/${id}/remove`, { method: 'POST' });
      toast('Job removed from queue', 'success');
      loadQueue();
      loadDashboard();
    } catch (e) {
      toast('Remove failed: ' + e.message, 'error');
      btn.disabled = false;
    }
  }

  // ── XSS guard ──────────────────────────────────────────────────────────
  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Global refresh ─────────────────────────────────────────────────────
  document.getElementById('refresh-btn').addEventListener('click', () => {
    const active = document.querySelector('.view.active');
    if (active?.id === 'view-dashboard')  loadDashboard();
    if (active?.id === 'view-candidates') loadCandidates();
    if (active?.id === 'view-queue')      loadQueue();
    if (active?.id === 'view-history')    loadHistory();
    if (active?.id === 'view-settings')   loadSettings();
  });

  // ── System metrics ─────────────────────────────────────────────────────
  function fitStatValues() {
    document.querySelectorAll('#view-dashboard .stat-value').forEach(el => {
      el.style.fontSize = '32px';
      const card = el.closest('.stat-card');
      if (!card || card.clientWidth === 0) return;
      const label = card.querySelector('.stat-label');
      if (label) label.style.fontSize = '';
      const maxW = card.clientWidth - 40;
      let size = 32, min = 16;
      while (el.scrollWidth > maxW && size > min) {
        size--;
        el.style.fontSize = size + 'px';
      }
      if (size < 32 && label) label.style.fontSize = Math.round(size * 0.375) + 'px';
    });
  }

  function applyMetricColour(el, pct) {
    el.classList.remove('metric-low', 'metric-mid', 'metric-high');
    if (pct < 50)       el.classList.add('metric-low');
    else if (pct < 80)  el.classList.add('metric-mid');
    else                el.classList.add('metric-high');
  }

  async function loadSystemMetrics() {
    try {
      const [s, p] = await Promise.all([
        apiFetch('/api/system'),
        apiFetch('/api/progress'),
      ]);

      // Host CPU
      const cpuEl = document.getElementById('stat-cpu');
      cpuEl.textContent = s.cpu_percent.toFixed(1) + '%';
      applyMetricColour(cpuEl, s.cpu_percent);
      document.getElementById('stat-cpu-subtitle').textContent =
        s.cpu_count + ' thread' + (s.cpu_count !== 1 ? 's' : '');

      // Host Memory
      const memEl = document.getElementById('stat-memory');
      memEl.textContent = s.memory_percent.toFixed(1) + '%';
      applyMetricColour(memEl, s.memory_percent);
      document.getElementById('stat-memory-subtitle').textContent =
        fmtBytes(s.memory_used_bytes) + ' / ' + fmtBytes(s.memory_total_bytes);

      // Encodarr CPU
      const containerCpuEl = document.getElementById('stat-container-cpu');
      containerCpuEl.textContent = s.container_cpu_percent.toFixed(1) + '%';
      applyMetricColour(containerCpuEl, s.container_cpu_percent);
      document.getElementById('stat-container-cpu-subtitle').textContent =
        s.cpu_count + ' thread' + (s.cpu_count !== 1 ? 's' : '');

      // Encodarr Memory
      const containerMemEl = document.getElementById('stat-container-memory');
      containerMemEl.textContent = s.container_memory_percent.toFixed(1) + '%';
      applyMetricColour(containerMemEl, s.container_memory_percent);
      document.getElementById('stat-container-memory-subtitle').textContent =
        fmtBytes(s.container_memory_bytes) + ' / ' + fmtBytes(s.memory_total_bytes);

      // System GPU (if available)
      const gpuCard = document.getElementById('stat-gpu-card');
      if (s.gpu_percent != null) {
        gpuCard.style.display = '';
        const gpuEl = document.getElementById('stat-gpu');
        gpuEl.textContent = s.gpu_percent.toFixed(1) + '%';
        applyMetricColour(gpuEl, s.gpu_percent);
      } else {
        gpuCard.style.display = 'none';
      }

      // Encodarr GPU (if available)
      const containerGpuCard = document.getElementById('stat-container-gpu-card');
      if (s.container_gpu_percent != null) {
        containerGpuCard.style.display = '';
        const containerGpuEl = document.getElementById('stat-container-gpu');
        containerGpuEl.textContent = s.container_gpu_percent.toFixed(1) + '%';
        applyMetricColour(containerGpuEl, s.container_gpu_percent);
      } else {
        containerGpuCard.style.display = 'none';
      }

      const jobPct = p.current_job_percent;
      const jobEl = document.getElementById('stat-job-percent');
      jobEl.textContent = jobPct != null ? jobPct.toFixed(1) + '%' : '—';
      document.getElementById('bar-job-percent').style.width =
        jobPct != null ? Math.min(jobPct, 100).toFixed(1) + '%' : '0%';

      const qPct = p.queue_percent;
      const queueEl = document.getElementById('stat-queue-percent');
      queueEl.textContent = (qPct != null && qPct > 0) ? qPct.toFixed(1) + '%' : '—';
      document.getElementById('bar-queue-percent').style.width =
        (qPct != null && qPct > 0) ? Math.min(qPct, 100).toFixed(1) + '%' : '0%';

      // Queue Depth
      const depth = p.queue_depth ?? 0;
      document.getElementById('stat-queue-depth').textContent = depth > 0 ? depth : '—';
      const enc = p.encoding_count ?? 0;
      const paused = p.paused_count ?? 0;
      const queued = depth - enc - paused;
      const depthParts = [];
      if (queued > 0) depthParts.push(queued + ' queued');
      if (enc > 0)    depthParts.push(enc + ' encoding');
      if (paused > 0) depthParts.push(paused + ' paused');
      document.getElementById('stat-queue-depth-sub').textContent =
        depthParts.length > 0 ? depthParts.join(' · ') : 'idle';

      // Active Encodes
      document.getElementById('stat-active-encodes').textContent = enc > 0 ? enc : '—';
      const encParts = [];
      if (enc > 0)    encParts.push(enc + ' encoding');
      if (paused > 0) encParts.push(paused + ' paused');
      document.getElementById('stat-active-encodes-sub').textContent =
        encParts.length > 0 ? encParts.join(' · ') : 'idle';
    } catch (_) { /* silently ignore — metrics are non-critical */ }
    finally { fitStatValues(); }
  }

  // ── Settings ───────────────────────────────────────────────────────────
  async function saveSetting(key, value) {
    try {
      await apiFetch('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ [key]: value }),
      });
      toast('Saved', 'success');
    } catch (e) {
      toast('Save failed: ' + e.message, 'error');
    }
  }

  function renderLibraries(libraries) {
    const list = document.getElementById('library-list');
    if (!libraries.length) {
      list.innerHTML = '<div style="font-size:13px;color:var(--text-muted);padding:6px 0">No libraries configured</div>';
      return;
    }
    list.innerHTML = libraries.map(lib => `
      <div class="library-item" data-lib-id="${lib.id}">
        <div class="library-item-info">
          <div class="library-item-label">${escHtml(lib.label || lib.path)}</div>
          <div class="library-item-path">${escHtml(lib.path)}</div>
        </div>
        <div class="library-item-toggles">
          <label class="toggle">
            <input type="checkbox" class="lib-enabled-toggle" data-id="${lib.id}" ${lib.enabled ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
        <button class="btn btn-ghost btn-sm" data-lib-scan="${lib.id}" ${lib.enabled ? '' : 'disabled'}>Scan Now</button>
        <button class="btn btn-danger-ghost btn-sm" data-lib-del="${lib.id}">Delete</button>
      </div>`).join('');

    list.querySelectorAll('.lib-enabled-toggle').forEach(cb => {
      cb.addEventListener('change', async () => {
        try {
          await apiFetch(`/api/settings/libraries/${cb.dataset.id}`, {
            method: 'PUT',
            body: JSON.stringify({ enabled: cb.checked }),
          });
          const row = list.querySelector(`[data-lib-id="${cb.dataset.id}"]`);
          const scanBtn = row?.querySelector('[data-lib-scan]');
          if (scanBtn) scanBtn.disabled = !cb.checked;
          toast('Saved', 'success');
        } catch (e) { toast('Save failed: ' + e.message, 'error'); }
      });
    });

    list.querySelectorAll('[data-lib-del]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await apiFetch(`/api/settings/libraries/${btn.dataset.libDel}`, { method: 'DELETE' });
          toast('Library removed', 'success');
          const libs = await apiFetch('/api/settings/libraries');
          renderLibraries(libs);
        } catch (e) { toast('Delete failed: ' + e.message, 'error'); }
      });
    });

    list.querySelectorAll('[data-lib-scan]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Scanning…';
        try {
          const r = await apiFetch(`/api/settings/libraries/${btn.dataset.libScan}/scan`, { method: 'POST' });
          toast(`Library scan complete — ${r.added} new candidate(s) found`, 'success');
          loadDashboard();
          if (document.getElementById('view-candidates')?.classList.contains('active')) loadCandidates();
        } catch (e) {
          toast('Library scan failed: ' + e.message, 'error');
        } finally {
          btn.disabled = false;
          btn.textContent = originalText;
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Governor Windows
  // ---------------------------------------------------------------------------

  async function loadGovernorWindows() {
    const [windows, status] = await Promise.all([
      apiFetch('/api/governor/windows'),
      apiFetch('/api/governor/status'),
    ]);
    const list = document.getElementById('governor-windows-list');
    if (!windows.length) {
      list.innerHTML = '<p style="font-size:13px;color:var(--text-muted);margin:0 0 12px">No scheduled windows configured.</p>';
      return;
    }
    list.innerHTML = windows.map(w => {
      const isActive = status.active && w.enabled;
      const label = w.label || `Window ${w.id}`;
      const timeRange = `${w.start_time} – ${w.end_time}`;
      const limits = `CPU ${w.cpu_limit}% · ${w.max_concurrent} concurrent`;
      return `<div class="library-item" style="margin-bottom:8px${isActive ? ';border-color:var(--accent)' : ''}">
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600">${escHtml(label)} <span style="font-weight:400;color:var(--text-muted)">${timeRange}</span>${isActive ? ' <span style="font-size:11px;color:var(--accent);font-weight:500">● active</span>' : ''}</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:2px">${limits}</div>
          </div>
          <label class="toggle" style="flex-shrink:0" title="${w.enabled ? 'Enabled' : 'Disabled'}">
            <input type="checkbox" ${w.enabled ? 'checked' : ''} onchange="toggleGovernorWindow(${w.id}, this.checked)">
            <span class="toggle-slider"></span>
          </label>
          <button class="btn btn-danger-ghost btn-sm" onclick="deleteGovernorWindow(${w.id})">Delete</button>
        </div>`;
    }).join('');
  }

  window.toggleGovernorWindow = async function(id, enabled) {
    const windows = await apiFetch('/api/governor/windows');
    const w = windows.find(x => x.id === id);
    if (!w) return;
    await apiFetch(`/api/governor/windows/${id}`, { method: 'PUT', body: JSON.stringify({ ...w, enabled }) });
    loadGovernorWindows();
  };

  window.deleteGovernorWindow = async function(id) {
    await apiFetch(`/api/governor/windows/${id}`, { method: 'DELETE' });
    loadGovernorWindows();
  };

  document.getElementById('set-scheduled-windows-enabled').addEventListener('change', function () {
    document.getElementById('scheduled-windows-section').style.display = this.checked ? 'block' : 'none';
    saveSetting('scheduled_windows_enabled', this.checked ? 'true' : 'false');
  });
  document.getElementById('gw-cpu-limit').addEventListener('input', function () {
    document.getElementById('gw-cpu-limit-val').textContent = this.value + '%';
  });
  document.getElementById('gw-add-btn').addEventListener('click', () => {
    document.getElementById('governor-window-form').style.display = 'block';
    document.getElementById('gw-add-btn').style.display = 'none';
  });
  document.getElementById('gw-cancel').addEventListener('click', () => {
    document.getElementById('governor-window-form').style.display = 'none';
    document.getElementById('gw-add-btn').style.display = 'inline-flex';
  });
  document.getElementById('gw-save').addEventListener('click', async () => {
    const body = {
      label: document.getElementById('gw-label').value.trim() || null,
      start_time: document.getElementById('gw-start-time').value,
      end_time: document.getElementById('gw-end-time').value,
      cpu_limit: parseInt(document.getElementById('gw-cpu-limit').value),
      max_concurrent: parseInt(document.getElementById('gw-max-concurrent').value),
      enabled: true,
    };
    if (!body.start_time || !body.end_time) { toast('Start and end time are required', 'error'); return; }
    await apiFetch('/api/governor/windows', { method: 'POST', body: JSON.stringify(body) });
    document.getElementById('governor-window-form').style.display = 'none';
    document.getElementById('gw-add-btn').style.display = 'inline-flex';
    document.getElementById('gw-label').value = '';
    document.getElementById('gw-start-time').value = '00:00';
    document.getElementById('gw-end-time').value = '06:00';
    document.getElementById('gw-cpu-limit').value = 100;
    document.getElementById('gw-cpu-limit-val').textContent = '100%';
    document.getElementById('gw-max-concurrent').value = 2;
    loadGovernorWindows();
    toast('Scheduled window added');
  });

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  let _cachedSettings = {};

  async function loadSettings() {
    loadAutoApproveRules();
    try {
      const [s, libs, hw] = await Promise.all([
        apiFetch('/api/settings'),
        apiFetch('/api/settings/libraries'),
        apiFetch('/api/hardware'),
      ]);
      _cachedSettings = s;

      // Sliders
      const cpuSlider = document.getElementById('set-cpu-limit');
      cpuSlider.value = s.encode_cpu_limit_percent ?? 80;
      document.getElementById('set-cpu-limit-val').textContent = cpuSlider.value + '%';

      // Number
      document.getElementById('set-max-encodes').value = s.max_concurrent_encodes ?? 1;

      // Codec segmented
      const codec = s.default_codec ?? 'hevc';
      document.querySelectorAll('#set-codec-btns .segmented-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.codec === codec));

      // Quality buttons
      const quality = String(s.default_quality_level ?? '3');
      document.querySelectorAll('#set-quality-btns .quality-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.quality === quality));

      // Resolution
      document.getElementById('set-resolution').value = s.default_resolution ?? '';

      // Output mode segmented
      const mode = s.default_output_mode ?? 'replace';
      document.querySelectorAll('#set-output-btns .segmented-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.mode === mode));

      // Hardware encoding defaults
      const hwToggle = document.getElementById('set-hw-enabled');
      const hwTypeGroup = document.getElementById('set-hw-type-group');
      const hwTypeSelect = document.getElementById('set-hw-type');
      const hwNoneNote = document.getElementById('set-hw-none-note');
      const HW_OPTIONS = [
        { key: 'nvenc', value: 'nvenc', label: 'NVENC (NVIDIA)' },
        { key: 'vaapi', value: 'vaapi', label: 'VAAPI (Linux/AMD)' },
        { key: 'videotoolbox', value: 'videotoolbox', label: 'VideoToolbox (Apple)' },
      ];
      hwTypeSelect.innerHTML = '';
      HW_OPTIONS.forEach(opt => {
        if (hw[opt.key]) {
          const el = document.createElement('option');
          el.value = opt.value;
          el.textContent = opt.label;
          hwTypeSelect.appendChild(el);
        }
      });
      if (hw.any) {
        hwToggle.disabled = false;
        hwNoneNote.style.display = 'none';
        const useHw = s.default_use_hardware === 'true';
        hwToggle.checked = useHw;
        hwTypeGroup.style.display = useHw ? 'block' : 'none';
        const savedType = s.default_hardware_type;
        if (savedType && hwTypeSelect.querySelector(`option[value="${savedType}"]`)) {
          hwTypeSelect.value = savedType;
        }
      } else {
        hwToggle.disabled = true;
        hwToggle.checked = false;
        hwTypeGroup.style.display = 'none';
        hwNoneNote.style.display = 'block';
      }

      // Libraries
      renderLibraries(libs);

      // Scheduled windows toggle
      const swEnabled = s.scheduled_windows_enabled === 'true';
      document.getElementById('set-scheduled-windows-enabled').checked = swEnabled;
      document.getElementById('scheduled-windows-section').style.display = swEnabled ? 'block' : 'none';
      if (swEnabled) loadGovernorWindows();

      // Scheduled scan
      const scanEnabled = s.scan_schedule_enabled === 'true';
      const scanInterval = s.scan_schedule_interval_hours ?? '24';
      document.getElementById('set-scan-schedule-enabled').checked = scanEnabled;
      document.getElementById('set-scan-interval').value = scanInterval;
      document.getElementById('scan-interval-group').style.display = scanEnabled ? 'block' : 'none';
      document.getElementById('scan-times-group').style.display = scanEnabled ? 'block' : 'none';

      // Auto-approve master toggle
      const autoApproveEnabled = s.auto_approve_enabled === 'true';
      document.getElementById('set-auto-approve-enabled').checked = autoApproveEnabled;
      document.getElementById('auto-approve-section').style.display = autoApproveEnabled ? 'block' : 'none';
      loadAutoApproveRules(libs);

      // Format and display scan times
      const lastScan = s.last_scheduled_scan ? new Date(s.last_scheduled_scan).toLocaleString() : 'Never';
      const nextScan = s.next_scheduled_scan ? new Date(s.next_scheduled_scan).toLocaleString() : 'N/A';
      document.getElementById('last-scan-time').value = lastScan;
      document.getElementById('next-scan-time').value = nextScan;

      // Output filename
      document.getElementById('set-rename-copy-enabled').checked = s.rename_copy_enabled !== 'false';
      document.getElementById('set-rename-replace-enabled').checked = s.rename_replace_enabled === 'true';
      document.getElementById('set-rename-custom-text-enabled').checked = s.rename_custom_text_enabled !== 'false';
      document.getElementById('set-rename-custom-text').value = s.rename_custom_text ?? 'encodarr';
      document.getElementById('set-rename-include-codec').checked = s.rename_include_codec === 'true';
      document.getElementById('set-rename-include-resolution').checked = s.rename_include_resolution === 'true';
      document.getElementById('set-rename-separator').value = s.rename_separator ?? '_';
      updateRenamePreview();

      // Security
      const authEnabled = !!s.auth_enabled;
      document.getElementById('set-auth-enabled').checked = authEnabled;
      document.getElementById('security-section').style.display = authEnabled ? 'block' : 'none';
      document.getElementById('logout-form').style.display = authEnabled ? 'block' : 'none';
      document.getElementById('set-auth-username').value = s.auth_username ?? '';

      // Notifications
      const notifEnabled = s.notifications_enabled === 'true';
      document.getElementById('set-notifications-enabled').checked = notifEnabled;
      document.getElementById('notifications-section').style.display = notifEnabled ? 'block' : 'none';
      document.getElementById('set-apprise-urls').value = s.apprise_urls ?? '';

    } catch (e) {
      toast('Could not load settings: ' + e.message, 'error');
    }
  }

  // Slider live update + auto-save on release
  document.getElementById('set-cpu-limit').addEventListener('input', function () {
    document.getElementById('set-cpu-limit-val').textContent = this.value + '%';
  });
  document.getElementById('set-cpu-limit').addEventListener('change', function () {
    saveSetting('encode_cpu_limit_percent', this.value);
  });


  document.getElementById('set-max-encodes').addEventListener('change', function () {
    saveSetting('max_concurrent_encodes', this.value);
  });

  document.getElementById('set-resolution').addEventListener('change', function () {
    saveSetting('default_resolution', this.value);
  });

  document.getElementById('set-hw-enabled').addEventListener('change', function () {
    document.getElementById('set-hw-type-group').style.display = this.checked ? 'block' : 'none';
    saveSetting('default_use_hardware', this.checked ? 'true' : 'false');
  });

  document.getElementById('set-hw-type').addEventListener('change', function () {
    saveSetting('default_hardware_type', this.value);
  });

  document.getElementById('set-codec-btns').addEventListener('click', function (e) {
    const btn = e.target.closest('.segmented-btn');
    if (!btn) return;
    this.querySelectorAll('.segmented-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    saveSetting('default_codec', btn.dataset.codec);
  });

  document.getElementById('set-quality-btns').addEventListener('click', function (e) {
    const btn = e.target.closest('.quality-btn');
    if (!btn) return;
    this.querySelectorAll('.quality-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    saveSetting('default_quality_level', btn.dataset.quality);
  });

  document.getElementById('set-output-btns').addEventListener('click', function (e) {
    const btn = e.target.closest('.segmented-btn');
    if (!btn) return;
    this.querySelectorAll('.segmented-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    saveSetting('default_output_mode', btn.dataset.mode);
  });

  // Scheduled scan toggle
  document.getElementById('set-scan-schedule-enabled').addEventListener('change', function () {
    const enabled = this.checked;
    saveSetting('scan_schedule_enabled', enabled ? 'true' : 'false');
    document.getElementById('scan-interval-group').style.display = enabled ? 'block' : 'none';
    document.getElementById('scan-times-group').style.display = enabled ? 'block' : 'none';
  });

  // Scan interval dropdown
  document.getElementById('set-scan-interval').addEventListener('change', function () {
    saveSetting('scan_schedule_interval_hours', this.value);
  });

  // Auto-approve master toggle — auto-saves; the per-rule confirm guards destructive commits
  document.getElementById('set-auto-approve-enabled').addEventListener('change', function () {
    const enabled = this.checked;
    saveSetting('auto_approve_enabled', enabled ? 'true' : 'false');
    document.getElementById('auto-approve-section').style.display = enabled ? 'block' : 'none';
  });

  // Output filename
  function updateRenamePreview() {
    const sep = document.getElementById('set-rename-separator').value || '_';
    const customEnabled = document.getElementById('set-rename-custom-text-enabled').checked;
    const customText = document.getElementById('set-rename-custom-text').value.trim();
    const incCodec = document.getElementById('set-rename-include-codec').checked;
    const incRes = document.getElementById('set-rename-include-resolution').checked;
    const parts = ['{file_name}'];
    if (customEnabled) parts.push(customText || 'encodarr');
    if (incCodec) parts.push('hevc');
    if (incRes) parts.push('1080p');
    document.getElementById('rename-preview').textContent = parts.join(sep) + '.mkv';
  }

  ['set-rename-copy-enabled','set-rename-replace-enabled'].forEach(id => {
    document.getElementById(id).addEventListener('change', function () {
      saveSetting(id.replace('set-', '').replace(/-/g, '_'), this.checked ? 'true' : 'false');
    });
  });

  document.getElementById('set-rename-custom-text-enabled').addEventListener('change', function () {
    saveSetting('rename_custom_text_enabled', this.checked ? 'true' : 'false');
    updateRenamePreview();
  });
  document.getElementById('set-rename-custom-text').addEventListener('input', updateRenamePreview);
  document.getElementById('set-rename-custom-text').addEventListener('blur', function () {
    saveSetting('rename_custom_text', this.value);
  });
  document.getElementById('set-rename-include-codec').addEventListener('change', function () {
    saveSetting('rename_include_codec', this.checked ? 'true' : 'false');
    updateRenamePreview();
  });
  document.getElementById('set-rename-include-resolution').addEventListener('change', function () {
    saveSetting('rename_include_resolution', this.checked ? 'true' : 'false');
    updateRenamePreview();
  });
  document.getElementById('set-rename-separator').addEventListener('change', function () {
    saveSetting('rename_separator', this.value);
    updateRenamePreview();
  });

  // Security toggle
  document.getElementById('set-auth-enabled').addEventListener('change', async function () {
    const enabled = this.checked;
    document.getElementById('security-section').style.display = enabled ? 'block' : 'none';
    if (!enabled) {
      try {
        await apiFetch('/api/auth/clear-password', { method: 'POST' });
        document.getElementById('logout-form').style.display = 'none';
        toast('Password protection disabled', 'success');
      } catch (e) { toast('Failed to disable auth: ' + e.message, 'error'); }
    }
  });

  document.getElementById('save-password-btn').addEventListener('click', async function () {
    const username = document.getElementById('set-auth-username').value.trim();
    const pw = document.getElementById('set-new-password').value;
    const confirm = document.getElementById('set-confirm-password').value;
    if (!username) return toast('Enter a username', 'error');
    if (!pw) return toast('Enter a password', 'error');
    if (pw !== confirm) return toast('Passwords do not match', 'error');
    try {
      await apiFetch('/api/auth/set-credentials', { method: 'POST', body: JSON.stringify({ username, password: pw }) });
      document.getElementById('set-new-password').value = '';
      document.getElementById('set-confirm-password').value = '';
      document.getElementById('logout-form').style.display = 'block';
      toast('Credentials saved', 'success');
    } catch (e) { toast('Failed to save credentials: ' + e.message, 'error'); }
  });

  // Notifications toggle
  document.getElementById('set-notifications-enabled').addEventListener('change', function () {
    const enabled = this.checked;
    saveSetting('notifications_enabled', enabled ? 'true' : 'false');
    document.getElementById('notifications-section').style.display = enabled ? 'block' : 'none';
  });

  // Apprise URLs — save on blur
  document.getElementById('set-apprise-urls').addEventListener('blur', function () {
    saveSetting('apprise_urls', this.value);
  });

  // Test notification button
  document.getElementById('notify-test-btn').addEventListener('click', async function () {
    this.disabled = true;
    try {
      await apiFetch('/api/notifications/test', { method: 'POST' });
      toast('Test notification sent', 'success');
    } catch (e) {
      toast('Test failed: ' + e.message, 'error');
    } finally {
      this.disabled = false;
    }
  });

  // Auto-approve rule form segmented buttons
  document.getElementById('aar-target-codec-btns').addEventListener('click', e => {
    const btn = e.target.closest('.segmented-btn');
    if (!btn) return;
    document.querySelectorAll('#aar-target-codec-btns .segmented-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
  document.getElementById('aar-target-res-btns').addEventListener('click', e => {
    const btn = e.target.closest('.segmented-btn');
    if (!btn) return;
    document.querySelectorAll('#aar-target-res-btns .segmented-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
  document.getElementById('aar-output-mode-btns').addEventListener('click', e => {
    const btn = e.target.closest('.segmented-btn');
    if (!btn) return;
    document.querySelectorAll('#aar-output-mode-btns .segmented-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });

  document.getElementById('aar-quality-btns').addEventListener('click', e => {
    const btn = e.target.closest('.quality-btn');
    if (!btn) return;
    document.querySelectorAll('#aar-quality-btns .quality-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });

  document.getElementById('aar-hardware-btns').addEventListener('click', e => {
    const btn = e.target.closest('.segmented-btn');
    if (!btn) return;
    document.querySelectorAll('#aar-hardware-btns .segmented-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });

  // ── Auto-Approve Rules ─────────────────────────────────────────────────

  // Re-apply rename defaults when output mode changes (copy vs replace affects rename_enabled default)
  document.getElementById('aar-output-mode-btns').addEventListener('click', e => {
    const btn = e.target.closest('.segmented-btn');
    if (!btn) return;
    const s = _cachedSettings;
    const renameKey = btn.dataset.mode === 'copy' ? 'rename_copy_enabled' : 'rename_replace_enabled';
    document.getElementById('aar-rename-enabled').checked = s[renameKey] !== 'false';
    _updateAarRenamePreview();
  });

  ['aar-rename-enabled','aar-rename-custom-text-enabled','aar-rename-include-codec','aar-rename-include-resolution'].forEach(id => {
    document.getElementById(id).addEventListener('change', _updateAarRenamePreview);
  });
  document.getElementById('aar-rename-custom-text').addEventListener('input', _updateAarRenamePreview);
  document.getElementById('aar-rename-separator').addEventListener('change', _updateAarRenamePreview);

  let _aarLibraries = [];

  async function loadAutoApproveRules(libraries) {
    if (libraries) _aarLibraries = libraries;
    const list = document.getElementById('auto-approve-rules-list');
    try {
      const rules = await apiFetch('/api/auto-approve/rules');
      if (rules.length === 0) {
        list.innerHTML = '<p style="font-size:13px;color:var(--text-muted)">No rules configured.</p>';
        return;
      }
      const libMap = Object.fromEntries(_aarLibraries.map(l => [l.id, l.label || l.path]));
      list.innerHTML = rules.map(r => {
        const conditions = [];
        if (r.library_id) conditions.push(`library: ${libMap[r.library_id] || 'Unknown'}`);
        if (r.min_savings_percent != null) conditions.push(`savings ≥ ${r.min_savings_percent}%`);
        if (r.resolutions) conditions.push(`source res: ${r.resolutions}`);
        if (r.source_codecs) conditions.push(`source codec: ${r.source_codecs}`);
        const condStr = conditions.length ? conditions.join(' · ') : 'any file';
        const targetRes = r.target_resolution ? ` → ${r.target_resolution}` : '';
        const outputStr = r.output_mode === 'copy' ? 'copy' : 'replace';
        const qualityStr = QUALITY_LABELS[r.quality_level] ?? 'Auto';
        const targetStr = `→ ${(r.target_codec || 'hevc').toUpperCase()}${targetRes} · ${qualityStr} · ${outputStr}`;
        return `<div class="library-item" style="margin-bottom:8px">
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600">${escHtml(r.name)}</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:2px">${escHtml(condStr)}</div>
            <div style="font-size:12px;color:var(--badge-approved-text);margin-top:2px">${escHtml(targetStr)}</div>
          </div>
          <label class="toggle" style="flex-shrink:0" title="${r.enabled ? 'Enabled' : 'Disabled'}">
            <input type="checkbox" ${r.enabled ? 'checked' : ''} onchange="toggleAutoApproveRule(${r.id}, this.checked)">
            <span class="toggle-slider"></span>
          </label>
          <button class="btn btn-danger-ghost btn-sm" onclick="deleteAutoApproveRule(${r.id})">Delete</button>
        </div>`;
      }).join('');
    } catch (e) {
      list.innerHTML = `<p style="font-size:13px;color:var(--badge-failed-text)">Failed to load rules: ${escHtml(e.message)}</p>`;
    }
  }

  function showAutoApproveForm() {
    const s = _cachedSettings;
    document.getElementById('auto-approve-add-form').style.display = 'block';
    document.getElementById('aar-add-btn').style.display = 'none';
    document.getElementById('aar-name').value = '';
    document.getElementById('aar-savings').value = '';
    ['4k','1080p','720p','480p'].forEach(r => { document.getElementById(`aar-res-${r}`).checked = false; });
    document.querySelectorAll('.aar-codec-cb').forEach(cb => { cb.checked = false; });

    // Inherit from Encoding Defaults
    const codec = s.default_codec || 'hevc';
    document.querySelectorAll('#aar-target-codec-btns .segmented-btn').forEach(b => b.classList.toggle('active', b.dataset.codec === codec));
    const res = s.default_resolution || '';
    document.querySelectorAll('#aar-target-res-btns .segmented-btn').forEach(b => b.classList.toggle('active', b.dataset.res === res));
    const quality = String(s.default_quality_level ?? '0');
    document.querySelectorAll('#aar-quality-btns .quality-btn').forEach(b => b.classList.toggle('active', b.dataset.quality === quality));
    const outMode = s.default_output_mode || 'replace';
    document.querySelectorAll('#aar-output-mode-btns .segmented-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === outMode));

    // Inherit from Resource Governor
    document.querySelectorAll('#aar-hardware-btns .segmented-btn').forEach(b => b.classList.toggle('active', b.dataset.hardware === 'inherit'));

    // Inherit Output Filename settings
    const renameKey = outMode === 'copy' ? 'rename_copy_enabled' : 'rename_replace_enabled';
    document.getElementById('aar-rename-enabled').checked = s[renameKey] !== 'false';
    document.getElementById('aar-rename-custom-text-enabled').checked = s.rename_custom_text_enabled !== 'false';
    document.getElementById('aar-rename-custom-text').value = s.rename_custom_text || 'encodarr';
    document.getElementById('aar-rename-include-codec').checked = s.rename_include_codec === 'true';
    document.getElementById('aar-rename-include-resolution').checked = s.rename_include_resolution === 'true';
    document.getElementById('aar-rename-separator').value = s.rename_separator || '_';
    _updateAarRenamePreview();

    const libSel = document.getElementById('aar-library');
    libSel.innerHTML = '<option value="">All Libraries</option>' +
      _aarLibraries.map(l => `<option value="${l.id}">${escHtml(l.label || l.path)}</option>`).join('');
  }

  function _updateAarRenamePreview() {
    const sep = document.getElementById('aar-rename-separator').value || '_';
    const customEnabled = document.getElementById('aar-rename-custom-text-enabled').checked;
    const customText = document.getElementById('aar-rename-custom-text').value.trim();
    const incCodec = document.getElementById('aar-rename-include-codec').checked;
    const incRes = document.getElementById('aar-rename-include-resolution').checked;
    const parts = ['{file_name}'];
    if (customEnabled) parts.push(customText || 'encodarr');
    if (incCodec) parts.push('hevc');
    if (incRes) parts.push('1080p');
    const enabled = document.getElementById('aar-rename-enabled').checked;
    document.getElementById('aar-rename-preview').textContent = enabled ? parts.join(sep) + '.mkv' : '{file_name}.mkv (no rename)';
  }

  function cancelAutoApproveForm() {
    document.getElementById('auto-approve-add-form').style.display = 'none';
    document.getElementById('aar-add-btn').style.display = '';
  }

  let _pendingRulePayload = null;

  function saveAutoApproveRule() {
    const name = document.getElementById('aar-name').value.trim();
    if (!name) { toast('Rule name is required', 'error'); return; }
    const savingsRaw = document.getElementById('aar-savings').value.trim();
    const min_savings_percent = savingsRaw !== '' ? parseFloat(savingsRaw) : null;
    const checkedRes = ['4k','1080p','720p','480p'].filter(r => document.getElementById(`aar-res-${r}`).checked);
    const resolutions = checkedRes.length ? checkedRes.join(',') : null;
    const checkedCodecs = [...document.querySelectorAll('.aar-codec-cb:checked')].map(cb => cb.value);
    const source_codecs = checkedCodecs.length ? checkedCodecs.join(',') : null;
    const target_codec = document.querySelector('#aar-target-codec-btns .segmented-btn.active')?.dataset.codec || 'hevc';
    const target_resolution = document.querySelector('#aar-target-res-btns .segmented-btn.active')?.dataset.res || null;
    const hardware_mode = document.querySelector('#aar-hardware-btns .segmented-btn.active')?.dataset.hardware || 'inherit';
    const use_hardware = hardware_mode === 'inherit' ? null : hardware_mode === 'hardware';
    const output_mode = document.querySelector('#aar-output-mode-btns .segmented-btn.active')?.dataset.mode || 'replace';
    const quality_level = parseInt(document.querySelector('#aar-quality-btns .quality-btn.active')?.dataset.quality ?? '0');
    const library_id = parseInt(document.getElementById('aar-library').value) || null;
    const rename_enabled = document.getElementById('aar-rename-enabled').checked;
    const rename_custom_text_enabled = document.getElementById('aar-rename-custom-text-enabled').checked;
    const rename_custom_text = document.getElementById('aar-rename-custom-text').value.trim() || 'encodarr';
    const rename_include_codec = document.getElementById('aar-rename-include-codec').checked;
    const rename_include_resolution = document.getElementById('aar-rename-include-resolution').checked;
    const rename_separator = document.getElementById('aar-rename-separator').value || '_';
    _pendingRulePayload = { name, min_savings_percent, resolutions, source_codecs, target_codec, target_resolution: target_resolution || null, use_hardware, output_mode, quality_level, rename_enabled, rename_custom_text_enabled, rename_custom_text, rename_include_codec, rename_include_resolution, rename_separator, library_id };
    document.getElementById('auto-approve-confirm-modal').classList.add('open');
  }

  document.getElementById('auto-approve-confirm-cancel').addEventListener('click', () => {
    document.getElementById('auto-approve-confirm-modal').classList.remove('open');
    _pendingRulePayload = null;
  });

  document.getElementById('auto-approve-confirm-ok').addEventListener('click', async () => {
    document.getElementById('auto-approve-confirm-modal').classList.remove('open');
    if (!_pendingRulePayload) return;
    try {
      await apiFetch('/api/auto-approve/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(_pendingRulePayload),
      });
      toast('Rule saved', 'success');
      cancelAutoApproveForm();
      loadAutoApproveRules();
    } catch (e) {
      toast('Failed to save rule: ' + e.message, 'error');
    } finally {
      _pendingRulePayload = null;
    }
  });

  async function toggleAutoApproveRule(id, enabled) {
    try {
      await apiFetch(`/api/auto-approve/rules/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
    } catch (e) {
      toast('Failed to update rule: ' + e.message, 'error');
      loadAutoApproveRules();
    }
  }

  async function deleteAutoApproveRule(id) {
    if (!confirm('Delete this auto-approve rule?')) return;
    try {
      await apiFetch(`/api/auto-approve/rules/${id}`, { method: 'DELETE' });
      toast('Rule deleted', 'success');
      loadAutoApproveRules();
    } catch (e) {
      toast('Failed to delete rule: ' + e.message, 'error');
    }
  }

  async function triggerAutoApprove() {
    try {
      const result = await apiFetch('/api/auto-approve/evaluate', { method: 'POST' });
      toast(`Auto-approve: ${result.approved} candidate(s) approved and queued`, result.approved > 0 ? 'success' : 'info');
      loadCandidates();
      loadDashboard();
    } catch (e) {
      toast('Evaluate failed: ' + e.message, 'error');
    }
  }

  // Reset confirmation modal
  function openResetConfirmModal(action, title, description) {
    const modal = document.getElementById('reset-confirm-modal');
    const titleEl = document.getElementById('reset-confirm-title');
    const descEl = document.getElementById('reset-confirm-description');
    const cancelBtn = document.getElementById('reset-confirm-cancel');
    const okBtn = document.getElementById('reset-confirm-ok');

    titleEl.textContent = title;
    descEl.textContent = description;

    // Remove any existing listeners
    const newOkBtn = okBtn.cloneNode(true);
    okBtn.parentNode.replaceChild(newOkBtn, okBtn);

    // Add confirm handler
    newOkBtn.addEventListener('click', async () => {
      modal.classList.remove('open');
      try {
        const result = await apiFetch(action, { method: 'POST' });
        const count = result.total_affected || result.deleted || 0;
        toast(`Reset complete: ${count} records affected`, 'success');
        loadSettings();
        loadDashboard();
        if (document.querySelector('.view.active')?.id === 'view-history') loadHistory();
      } catch (e) {
        toast('Reset failed: ' + e.message, 'error');
      }
    });

    // Cancel handler
    cancelBtn.onclick = () => modal.classList.remove('open');

    // Close on overlay click
    modal.onclick = (e) => {
      if (e.target === modal) modal.classList.remove('open');
    };

    modal.classList.add('open');
  }

  // Reset buttons
  document.getElementById('reset-missing-btn').addEventListener('click', () => {
    openResetConfirmModal(
      '/api/settings/reset-missing',
      'Clear Missing Files?',
      'This will remove all candidates currently marked as missing, resetting the missing files counter. They will be re-detected on the next scan if still absent.'
    );
  });

  document.getElementById('clear-metrics-btn').addEventListener('click', () => {
    openResetConfirmModal(
      '/api/settings/reset-history',
      'Clear Metric Counters?',
      'This will reset the Space Saved, Successful Encodes, and Failed Encodes counters on the dashboard by clearing all completed, failed, and ignored job records. This cannot be undone.'
    );
  });

  document.getElementById('reset-scan-btn').addEventListener('click', () => {
    openResetConfirmModal(
      '/api/settings/reset-scan',
      'Reset Scan History?',
      'This will fully purge all scan data and delete all candidates. The next scan will start from baseline and re-detect all files. This cannot be undone.'
    );
  });

  document.getElementById('reset-history-btn').addEventListener('click', () => {
    openResetConfirmModal(
      '/api/settings/reset-history',
      'Reset Encode History?',
      'This will permanently delete all completed, failed, and ignored encode jobs. This cannot be undone.'
    );
  });

  document.getElementById('reset-all-btn').addEventListener('click', () => {
    openResetConfirmModal(
      '/api/settings/reset-all',
      'Reset Everything?',
      'This will completely purge all scan data, encode history, and reset all settings to defaults. This returns Encodarr to a fresh install state. Media library paths will be preserved. This action is irreversible.'
    );
  });

  // Add library form
  document.getElementById('lib-add-btn').addEventListener('click', () => {
    document.getElementById('lib-add-btn').classList.add('hidden');
    document.getElementById('library-add-form').classList.remove('hidden');
    document.getElementById('lib-add-label').value = '';
    document.getElementById('lib-add-path').value = '';
  });

  document.getElementById('lib-add-cancel').addEventListener('click', () => {
    document.getElementById('library-add-form').classList.add('hidden');
    document.getElementById('lib-add-btn').classList.remove('hidden');
  });

  document.getElementById('lib-add-submit').addEventListener('click', async () => {
    const path = document.getElementById('lib-add-path').value.trim();
    if (!path) { toast('Path is required', 'error'); return; }
    const label = document.getElementById('lib-add-label').value.trim() || null;
    try {
      await apiFetch('/api/settings/libraries', {
        method: 'POST',
        body: JSON.stringify({ path, label }),
      });
      document.getElementById('library-add-form').classList.add('hidden');
      document.getElementById('lib-add-btn').classList.remove('hidden');
      toast('Library added', 'success');
      const libs = await apiFetch('/api/settings/libraries');
      renderLibraries(libs);
    } catch (e) {
      toast('Failed to add library: ' + e.message, 'error');
    }
  });

  document.getElementById('settings-scan-all-btn').addEventListener('click', async function () {
    const btn = this;
    const originalHTML = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<div class="spinner"></div> Scanning…`;
    try {
      const r = await apiFetch('/api/scan', { method: 'POST' });
      toast(`Scan complete — ${r.added} new candidate(s) found`, 'success');
      loadDashboard();
      if (document.getElementById('view-candidates')?.classList.contains('active')) loadCandidates();
    } catch (e) {
      toast('Scan failed: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalHTML;
    }
  });

  // ── Filesystem browser ────────────────────────────────────────────────
  let _browseCurrent = '/media';

  async function loadBrowseDir(path) {
    const list = document.getElementById('browse-dir-list');
    list.innerHTML = '<div class="browse-empty">Loading…</div>';
    try {
      const data = await apiFetch('/api/browse?path=' + encodeURIComponent(path));
      _browseCurrent = data.current;
      document.getElementById('browse-breadcrumb').textContent = data.current;
      document.getElementById('browse-up-btn').disabled = data.parent === null;

      if (data.dirs.length === 0) {
        list.innerHTML = '<div class="browse-empty">No subfolders here</div>';
        return;
      }

      list.innerHTML = data.dirs.map(d => `
        <div class="browse-dir-item" data-path="${escHtml(d.path)}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
          ${escHtml(d.name)}
        </div>`).join('');

      list.querySelectorAll('.browse-dir-item').forEach(el => {
        el.addEventListener('click', () => loadBrowseDir(el.dataset.path));
      });

    } catch (e) {
      list.innerHTML = `<div class="browse-empty">Error: ${escHtml(e.message)}</div>`;
    }
  }

  function openBrowseModal() {
    loadBrowseDir('/media');
    document.getElementById('browse-modal').classList.add('open');
  }

  document.getElementById('lib-browse-btn').addEventListener('click', openBrowseModal);
  document.getElementById('lib-add-path').addEventListener('click', openBrowseModal);

  document.getElementById('browse-up-btn').addEventListener('click', async () => {
    try {
      const data = await apiFetch('/api/browse?path=' + encodeURIComponent(_browseCurrent));
      if (data.parent) loadBrowseDir(data.parent);
    } catch (_) {}
  });

  document.getElementById('browse-select').addEventListener('click', () => {
    document.getElementById('lib-add-path').value = _browseCurrent;
    document.getElementById('browse-modal').classList.remove('open');
  });

  document.getElementById('browse-cancel').addEventListener('click', () => {
    document.getElementById('browse-modal').classList.remove('open');
  });

  document.getElementById('browse-modal').addEventListener('click', function (e) {
    if (e.target === this) this.classList.remove('open');
  });

  // ── Init ───────────────────────────────────────────────────────────────
  loadDashboard();
  loadSystemMetrics();
  updateStickyOffsets();
  updateStickyState();

  if (window.ResizeObserver) {
    const _statRO = new ResizeObserver(fitStatValues);
    document.querySelectorAll('.stats-grid').forEach(g => _statRO.observe(g));
  }

  setInterval(() => {
    const active = document.querySelector('.view.active');
    if (active?.id === 'view-dashboard')  loadDashboard();
    if (active?.id === 'view-candidates') loadCandidates();
    if (active?.id === 'view-queue')      loadQueue();
    if (active?.id === 'view-history')    loadHistory();
  }, 30000);

  setInterval(loadSystemMetrics, 5000);
