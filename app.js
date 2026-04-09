/* ===================================================
   BaHALA — Flood Early Warning System
   app.js — Frontend + "Backend" (localStorage DB)
   =================================================== */

'use strict';

// ============================================================
// DATABASE LAYER (localStorage-backed, simulating a backend)
// ============================================================
const DB = {
  STORE_KEY: 'bahala_reports_v2',

  /** Seed data (shows on first load) */
  seed() {
    const seeded = localStorage.getItem('bahala_seeded');
    if (seeded) return;
    const samples = [
      {
        id: this._genId(),
        title: 'Flooded road along Rizal Ave.',
        type: 'road-flooding',
        severity: 'high',
        barangay: 'Barangay 1 - Poblacion',
        street: 'Rizal Ave. near Palengke',
        description: 'Water level approximately waist-deep. Cars cannot pass. Residents are wading through flood water.',
        reporterName: 'Jose Reyes',
        reporterContact: '09171234567',
        anonymous: false,
        status: 'responding',
        date: new Date(Date.now() - 2 * 3600000).toISOString(),
      },
      {
        id: this._genId(),
        title: 'Blocked drainage causing backflow',
        type: 'blocked-drainage',
        severity: 'medium',
        barangay: 'Barangay 3 - Sta. Cruz',
        street: 'Mabini St. corner Del Pilar',
        description: 'Drainage clogged with debris and garbage. Water is backing up into the street and adjacent houses.',
        reporterName: 'Maria Santos',
        reporterContact: '09281234567',
        anonymous: false,
        status: 'pending',
        date: new Date(Date.now() - 5 * 3600000).toISOString(),
      },
      {
        id: this._genId(),
        title: 'CRITICAL: Evacuation needed — Purok 4',
        type: 'evacuation-needed',
        severity: 'critical',
        barangay: 'Barangay 5 - Bagong Silang',
        street: 'Purok 4 lower area near river',
        description: 'Water level rising rapidly near the river bank. At least 15 families need immediate evacuation. Children and elderly at risk.',
        reporterName: 'Pedro Cruz',
        reporterContact: '09391234567',
        anonymous: false,
        status: 'responding',
        date: new Date(Date.now() - 30 * 60000).toISOString(),
      },
      {
        id: this._genId(),
        title: 'House flooding — Ground floor submerged',
        type: 'house-flooding',
        severity: 'high',
        barangay: 'Barangay 2 - San Jose',
        street: 'Luna St. near Elementary School',
        description: 'Ground floor completely flooded. Family belongings moved to second floor. Electric lines exposed to water.',
        reporterName: 'Anonymous',
        reporterContact: '',
        anonymous: true,
        status: 'pending',
        date: new Date(Date.now() - 8 * 3600000).toISOString(),
      },
      {
        id: this._genId(),
        title: 'Rising water level at creek',
        type: 'rising-water-level',
        severity: 'low',
        barangay: 'Barangay 6 - Kalikasan',
        street: 'Near Sto. Nino Creek bridge',
        description: 'Water level is still manageable but rising. Monitoring situation closely.',
        reporterName: 'Liza Flores',
        reporterContact: '09451234567',
        anonymous: false,
        status: 'resolved',
        date: new Date(Date.now() - 24 * 3600000).toISOString(),
      },
    ];
    localStorage.setItem(this.STORE_KEY, JSON.stringify(samples));
    localStorage.setItem('bahala_seeded', '1');
  },

  _genId() {
    return 'RPT-' + Date.now().toString(36).toUpperCase() + '-' +
      Math.random().toString(36).substr(2, 4).toUpperCase();
  },

  /** READ all reports */
  getAll() {
    try {
      return JSON.parse(localStorage.getItem(this.STORE_KEY) || '[]');
    } catch { return []; }
  },

  /** READ single report by id */
  getById(id) {
    return this.getAll().find(r => r.id === id) || null;
  },

  /** CREATE new report */
  create(data) {
    const reports = this.getAll();
    const report = {
      id: this._genId(),
      ...data,
      status: 'pending',
      date: new Date().toISOString(),
    };
    reports.unshift(report); // newest first
    localStorage.setItem(this.STORE_KEY, JSON.stringify(reports));
    return report;
  },

  /** UPDATE report status */
  updateStatus(id, status) {
    const reports = this.getAll();
    const idx = reports.findIndex(r => r.id === id);
    if (idx === -1) return null;
    reports[idx].status = status;
    reports[idx].updatedAt = new Date().toISOString();
    localStorage.setItem(this.STORE_KEY, JSON.stringify(reports));
    return reports[idx];
  },

  /** DELETE report */
  delete(id) {
    const reports = this.getAll().filter(r => r.id !== id);
    localStorage.setItem(this.STORE_KEY, JSON.stringify(reports));
  },

  /** Query/filter reports */
  query({ severity = 'all', status = 'all', search = '' } = {}) {
    return this.getAll().filter(r => {
      if (severity !== 'all' && r.severity !== severity) return false;
      if (status !== 'all' && r.status !== status) return false;
      if (search) {
        const q = search.toLowerCase();
        return (
          r.title.toLowerCase().includes(q) ||
          r.barangay.toLowerCase().includes(q) ||
          r.street.toLowerCase().includes(q) ||
          r.type.toLowerCase().includes(q)
        );
      }
      return true;
    });
  },

  /** Aggregate stats */
  stats() {
    const all = this.getAll();
    return {
      total:    all.length,
      critical: all.filter(r => r.severity === 'critical').length,
      pending:  all.filter(r => r.status === 'pending').length,
      resolved: all.filter(r => r.status === 'resolved').length,
    };
  },
};

// ============================================================
// APP STATE
// ============================================================
const State = {
  currentPage: 'home',
  filters: { severity: 'all', status: 'all', search: '' },
};

// ============================================================
// HELPERS
// ============================================================
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function formatDate(iso) {
  const d = new Date(iso);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60)   return 'Just now';
  if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
  return d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function typeLabel(type) {
  const map = {
    'road-flooding':    '🌊 Road Flooding',
    'house-flooding':   '🏠 House Flooding',
    'blocked-drainage': '🔩 Blocked Drainage',
    'rising-water-level': '📈 Rising Water',
    'landslide':        '⛰️ Landslide',
    'structural-damage':'🏗️ Structural Damage',
    'evacuation-needed':'🆘 Evacuation',
    'other':            '⚠️ Other',
  };
  return map[type] || type;
}

function sevEmoji(sev) {
  return { low: '🟡', medium: '🟠', high: '🔴', critical: '🆘' }[sev] || '⚪';
}

function showToast(msg, duration = 3000) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), duration);
}

// ============================================================
// ROUTING / PAGE NAVIGATION
// ============================================================
function navigate(page) {
  if (!page) return;
  // Hide all pages
  $$('.page').forEach(p => p.classList.remove('active'));
  // Show target
  const target = $(`#page-${page}`);
  if (!target) return;
  target.classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  State.currentPage = page;

  // Update nav links
  $$('[data-page]').forEach(el => {
    el.classList.toggle('active', el.dataset.page === page);
  });

  // Page-specific init
  if (page === 'home')   refreshHome();
  if (page === 'view')   refreshReports();
  if (page === 'report') resetForm();

  // Close mobile nav
  $('#mobileNav').classList.remove('open');
  $('#mobileMenuBtn').classList.remove('open');
}

// Delegate all [data-page] clicks
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-page]');
  if (el) navigate(el.dataset.page);
});

// ============================================================
// HOME PAGE
// ============================================================
function refreshHome() {
  const stats = DB.stats();
  $('#statTotal').textContent    = stats.total;
  $('#statCritical').textContent = stats.critical;
  $('#statPending').textContent  = stats.pending;
  $('#statResolved').textContent = stats.resolved;

  // Recent reports (last 3)
  const recent = DB.getAll().slice(0, 3);
  const list = $('#recentReportsList');
  if (recent.length === 0) {
    list.innerHTML = '<div class="empty-state-small">No reports yet. Be the first to submit one.</div>';
    return;
  }
  list.innerHTML = recent.map(r => `
    <div class="recent-item sev-${r.severity}" data-id="${r.id}">
      <div>
        <div class="recent-item-title">${r.title}</div>
        <div class="recent-item-meta">${r.barangay} · ${formatDate(r.date)}</div>
      </div>
      <span class="sev-badge ${r.severity}">${sevEmoji(r.severity)} ${cap(r.severity)}</span>
    </div>
  `).join('');

  list.querySelectorAll('.recent-item').forEach(el => {
    el.addEventListener('click', () => openModal(el.dataset.id));
  });
}

function cap(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
}

// ============================================================
// REPORT FORM
// ============================================================
function resetForm() {
  const fields = ['reportTitle','reportType','reportSeverity','reportBarangay','reportStreet','reportDescription','reporterName','reporterContact'];
  fields.forEach(id => { const el = $(`#${id}`); if (el) el.value = ''; });
  $('#reportAnonymous').checked = false;
  $$('.sev-btn').forEach(b => b.classList.remove('selected'));
  $('#formSuccess').classList.remove('show');
  $('#titleCount').textContent = '0/100';
  $('#descCount').textContent  = '0/500';

  // Show form fields (in case they were hidden by success)
  $$('.form-section-title, .form-grid, .form-actions').forEach(el => el.style.display = '');
}

// Char counters
$('#reportTitle').addEventListener('input', function() {
  $('#titleCount').textContent = `${this.value.length}/100`;
});
$('#reportDescription').addEventListener('input', function() {
  $('#descCount').textContent = `${this.value.length}/500`;
});

// Severity picker
$$('.sev-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.sev-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    $('#reportSeverity').value = btn.dataset.value;
  });
});

// Form submit
$('#submitReportBtn').addEventListener('click', () => {
  const data = {
    title:           $('#reportTitle').value.trim(),
    type:            $('#reportType').value,
    severity:        $('#reportSeverity').value,
    barangay:        $('#reportBarangay').value,
    street:          $('#reportStreet').value.trim(),
    description:     $('#reportDescription').value.trim(),
    reporterName:    $('#reporterName').value.trim(),
    reporterContact: $('#reporterContact').value.trim(),
    anonymous:       $('#reportAnonymous').checked,
  };

  // Validation
  const required = ['title','type','severity','barangay','street','description','reporterName'];
  const missing  = required.filter(k => !data[k]);
  if (missing.length) {
    showToast('⚠️ Please fill in all required fields.');
    return;
  }

  if (data.anonymous) data.reporterName = 'Anonymous';

  // Save to DB
  const report = DB.create(data);

  // Show success
  $$('.form-section-title, .form-grid, .form-actions').forEach(el => el.style.display = 'none');
  $('#formSuccess').classList.add('show');
  showToast(`✅ Report ${report.id} submitted successfully!`);
});

// ============================================================
// VIEW REPORTS PAGE
// ============================================================
function refreshReports() {
  const data = DB.query(State.filters);
  renderTable(data);
  renderCards(data);

  const isEmpty = data.length === 0;
  $('#emptyState').style.display    = isEmpty ? 'block' : 'none';
  $('#reportsTableBody').closest('.reports-table-wrap').style.display = isEmpty ? 'none' : 'block';
  $('#reportsCards').style.display  = isEmpty ? 'none' : 'flex';
}

function renderTable(reports) {
  const tbody = $('#reportsTableBody');
  tbody.innerHTML = reports.map(r => `
    <tr>
      <td><code style="font-size:0.75rem;color:var(--gray-500)">${r.id}</code></td>
      <td><strong style="font-size:0.85rem">${r.title}</strong></td>
      <td style="white-space:nowrap">${typeLabel(r.type)}</td>
      <td>
        <div style="font-size:0.82rem">${r.barangay}</div>
        <div style="font-size:0.75rem;color:var(--gray-500)">${r.street}</div>
      </td>
      <td><span class="sev-badge ${r.severity}">${sevEmoji(r.severity)} ${cap(r.severity)}</span></td>
      <td><span class="status-badge ${r.status}">${cap(r.status)}</span></td>
      <td style="white-space:nowrap;font-size:0.8rem;color:var(--gray-500)">${formatDate(r.date)}</td>
      <td>
        <div style="display:flex;gap:6px">
          <button class="action-btn" data-action="view" data-id="${r.id}">View</button>
          ${r.status !== 'resolved' ? `<button class="action-btn resolve-btn" data-action="resolve" data-id="${r.id}">✓ Resolve</button>` : ''}
        </div>
      </td>
    </tr>
  `).join('');
}

function renderCards(reports) {
  const container = $('#reportsCards');
  container.innerHTML = reports.map(r => `
    <div class="report-card sev-${r.severity}" data-id="${r.id}">
      <div class="rc-header">
        <div class="rc-title">${r.title}</div>
        <span class="sev-badge ${r.severity}">${sevEmoji(r.severity)}</span>
      </div>
      <div class="rc-body">${r.barangay} · ${r.street}</div>
      <div class="rc-footer">
        <span class="status-badge ${r.status}">${cap(r.status)}</span>
        <span style="font-size:0.75rem;color:var(--gray-500);margin-left:auto">${formatDate(r.date)}</span>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('.report-card').forEach(el => {
    el.addEventListener('click', () => openModal(el.dataset.id));
  });
}

// Filter chips
$('#severityFilter').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  $('#severityFilter .chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  State.filters.severity = chip.dataset.filter;
  refreshReports();
});

$('#statusFilter').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  $('#statusFilter .chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  State.filters.status = chip.dataset.filter;
  refreshReports();
});

$('#searchReports').addEventListener('input', function() {
  State.filters.search = this.value;
  refreshReports();
});

// Table actions (view / resolve)
$('#reportsTableBody').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const { action, id } = btn.dataset;
  if (action === 'view')    openModal(id);
  if (action === 'resolve') resolveReport(id);
});

function resolveReport(id) {
  DB.updateStatus(id, 'resolved');
  showToast('✅ Report marked as resolved.');
  refreshReports();
  refreshHome();
}

// ============================================================
// MODAL
// ============================================================
function openModal(id) {
  const r = DB.getById(id);
  if (!r) return;

  $('#modalBody').innerHTML = `
    <div class="modal-sev-bar ${r.severity}"></div>
    <div class="modal-title">${r.title}</div>
    <div class="modal-sub">${r.id} · Submitted ${formatDate(r.date)}</div>
    <div class="modal-details">
      <div class="modal-detail-item">
        <label>Type</label>
        <span>${typeLabel(r.type)}</span>
      </div>
      <div class="modal-detail-item">
        <label>Severity</label>
        <span><span class="sev-badge ${r.severity}">${sevEmoji(r.severity)} ${cap(r.severity)}</span></span>
      </div>
      <div class="modal-detail-item">
        <label>Barangay</label>
        <span>${r.barangay}</span>
      </div>
      <div class="modal-detail-item">
        <label>Street / Landmark</label>
        <span>${r.street}</span>
      </div>
      <div class="modal-detail-item">
        <label>Status</label>
        <span><span class="status-badge ${r.status}">${cap(r.status)}</span></span>
      </div>
      <div class="modal-detail-item">
        <label>Reported by</label>
        <span>${r.anonymous ? '🕵️ Anonymous' : r.reporterName}</span>
      </div>
    </div>
    <div class="modal-desc">${r.description || 'No description provided.'}</div>
    ${r.status !== 'resolved' ? `
      <div style="margin-top:16px;display:flex;gap:8px;justify-content:flex-end">
        <button class="action-btn" onclick="updateModalStatus('${r.id}','responding');event.stopPropagation()">🔵 Mark Responding</button>
        <button class="action-btn resolve-btn" onclick="updateModalStatus('${r.id}','resolved');event.stopPropagation()">✓ Resolve</button>
      </div>
    ` : ''}
  `;

  $('#modalOverlay').classList.add('open');
}

// Expose globally for onclick handlers
window.updateModalStatus = function(id, status) {
  DB.updateStatus(id, status);
  showToast(`Report updated to: ${cap(status)}`);
  closeModal();
  if (State.currentPage === 'view') refreshReports();
  refreshHome();
};

function closeModal() {
  $('#modalOverlay').classList.remove('open');
}

$('#modalClose').addEventListener('click', closeModal);
$('#modalOverlay').addEventListener('click', (e) => {
  if (e.target === $('#modalOverlay')) closeModal();
});

// ============================================================
// MOBILE MENU
// ============================================================
$('#mobileMenuBtn').addEventListener('click', function() {
  const nav = $('#mobileNav');
  nav.classList.toggle('open');
  this.classList.toggle('open');
});

// ============================================================
// LOGO NAVIGATION
// ============================================================
$('.logo').addEventListener('click', () => navigate('home'));

// ============================================================
// SIMULATE REAL-TIME: auto-refresh stats every 30s
// ============================================================
setInterval(() => {
  if (State.currentPage === 'home') refreshHome();
  if (State.currentPage === 'view') refreshReports();
}, 30000);

// ============================================================
// BOOT
// ============================================================
DB.seed();
navigate('home');

console.log('%cBaHALA Flood Early Warning System', 'color:#005F99;font-size:16px;font-weight:bold;');
console.log('%cLocalStorage DB active. Data persists across sessions.', 'color:#64748B');
console.log('%cAll reports:', 'color:#16A34A', DB.getAll());
