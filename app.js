/* ============================================================
   app.js — BaHALA v2 Application Logic
   - Auth (user vs admin roles)
   - Supabase real-time sync (falls back to localStorage)
   - Interactive Leaflet Hazard Map
   - Auto-delete resolved reports after 24h
   - Admin-only: resolve, delete, status update
   ============================================================ */
'use strict';

// ============================================================
// GLOBALS
// ============================================================
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const App = {
  currentPage: 'home',
  currentUser: null,
  isAdmin: false,
  filters: { severity: 'all', status: 'all', search: '' },
  mapFilters: { severity: 'all' },
  map: null,
  mapMarkers: [],
  mapZones: [],
};

// ============================================================
// HELPERS
// ============================================================
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso), now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60)    return 'Just now';
  if (diff < 3600)  return `${Math.floor(diff/60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
  return d.toLocaleDateString('en-PH', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
}

function timeUntilDelete(resolvedAt) {
  const resolvedMs = new Date(resolvedAt).getTime();
  const deleteAt   = resolvedMs + APP_CONFIG.resolvedDeleteAfterHours * 3600 * 1000;
  const remaining  = deleteAt - Date.now();
  if (remaining <= 0) return 'Deleting soon';
  const h = Math.floor(remaining / 3600000);
  const m = Math.floor((remaining % 3600000) / 60000);
  return `${h}h ${m}m remaining`;
}

function typeLabel(type) {
  const map = {
    'road-flooding':'🌊 Road Flooding','house-flooding':'🏠 House Flooding',
    'blocked-drainage':'🔩 Blocked Drainage','rising-water-level':'📈 Rising Water',
    'landslide':'⛰️ Landslide','structural-damage':'🏗️ Structural',
    'evacuation-needed':'🆘 Evacuation','other':'⚠️ Other',
  };
  return map[type] || type;
}

function sevEmoji(sev) {
  return { low:'🟡', medium:'🟠', high:'🔴', critical:'🆘' }[sev] || '⚪';
}

function showToast(msg, dur = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), dur);
}

// ============================================================
// NAVIGATION
// ============================================================
function navigate(page) {
  if (!page) return;
  $$('.page').forEach(p => p.classList.remove('active'));
  const target = $(`#page-${page}`);
  if (!target) return;
  target.classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  App.currentPage = page;

  // Nav link highlight
  $$('[data-page]').forEach(el => {
    if (el.classList.contains('nav-link') || el.classList.contains('mobile-nav-link')) {
      el.classList.toggle('active', el.dataset.page === page);
    }
  });

  $('#mobileNav').classList.remove('open');
  $('#mobileMenuBtn').classList.remove('open');

  // Page-specific inits
  if (page === 'home')   initHome();
  if (page === 'view')   initView();
  if (page === 'map')    initMap();
  if (page === 'report') resetForm();
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-page]');
  if (!el) return;

  // Don't navigate if clicking login nav btn and already signed in
  if (el.id === 'loginNavBtn' && App.currentUser) return;
  navigate(el.dataset.page);
});

// ============================================================
// AUTH
// ============================================================
async function initAuth() {
  const user = await Database.Auth.getUser();
  if (user) setUser(user);
  else clearUser();
}

function setUser(user) {
  App.currentUser = user;
  App.isAdmin     = Database.Auth.isAdmin(user);
  const name      = user.user_metadata?.full_name || user.email.split('@')[0];
  const initials  = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);

  // Show user menu, hide login btn
  $('#userMenu').style.display    = 'flex';
  $('#loginNavBtn').style.display = 'none';
  $('#mobileLoginLink').style.display = 'none';
  $('#userAvatar').textContent    = initials;
  $('#userNameDisplay').textContent = name;
  $('#userRoleDisplay').textContent = App.isAdmin ? '🛡️ Admin' : '👤 Resident';

  showToast(`✅ Signed in as ${name}${App.isAdmin ? ' (Admin)' : ''}`);
}

function clearUser() {
  App.currentUser = null;
  App.isAdmin     = false;
  $('#userMenu').style.display    = 'none';
  $('#loginNavBtn').style.display = 'block';
  $('#mobileLoginLink').style.display = 'block';
}

// Auth Tab Toggle
$$('.auth-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.auth-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    $('#signinForm').style.display = tab.dataset.tab === 'signin' ? 'flex' : 'none';
    $('#signupForm').style.display = tab.dataset.tab === 'signup' ? 'flex' : 'none';
  });
});

// Sign In
$('#signInBtn').addEventListener('click', async () => {
  const email    = $('#loginEmail').value.trim();
  const password = $('#loginPassword').value;
  if (!email || !password) { showToast('⚠️ Enter email and password.'); return; }
  try {
    $('#signInBtn').textContent = 'Signing in...';
    const { user } = await Database.Auth.signIn(email, password);
    setUser(user);
    navigate('home');
  } catch (err) {
    showToast('❌ ' + err.message);
  } finally {
    $('#signInBtn').textContent = 'Sign In →';
  }
});

// Sign Up
$('#signUpBtn').addEventListener('click', async () => {
  const name     = $('#regName').value.trim();
  const email    = $('#regEmail').value.trim();
  const password = $('#regPassword').value;
  if (!name || !email || !password) { showToast('⚠️ Fill in all fields.'); return; }
  if (password.length < 8) { showToast('⚠️ Password must be at least 8 characters.'); return; }
  try {
    $('#signUpBtn').textContent = 'Creating account...';
    await Database.Auth.signUp(email, password, name);
    showToast('✅ Account created! You can now sign in.');
    $$('.auth-tab')[0].click();
  } catch (err) {
    showToast('❌ ' + err.message);
  } finally {
    $('#signUpBtn').textContent = 'Create Account →';
  }
});

// Logout
$('#logoutBtn').addEventListener('click', async () => {
  await Database.Auth.signOut();
  clearUser();
  $('#userDropdown').style.display = 'none';
  showToast('👋 Signed out.');
  navigate('home');
});

// Avatar dropdown toggle
$('#userAvatar').addEventListener('click', (e) => {
  e.stopPropagation();
  const dd = $('#userDropdown');
  dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
});
document.addEventListener('click', () => {
  if ($('#userDropdown')) $('#userDropdown').style.display = 'none';
});

// ============================================================
// HOME PAGE
// ============================================================
async function initHome() {
  try {
    const s = await Database.stats();
    $('#statTotal').textContent    = s.total;
    $('#statCritical').textContent = s.critical;
    $('#statPending').textContent  = s.pending;
    $('#statResolved').textContent = s.resolved;

    const all = await Database.getAll();
    const recent = all.slice(0, 4);
    const list = $('#recentReportsList');

    if (recent.length === 0) {
      list.innerHTML = '<div class="empty-state-small">No reports yet. Be the first to submit one.</div>';
      return;
    }
    list.innerHTML = recent.map(r => `
      <div class="recent-item sev-${r.severity}" data-id="${r.id}">
        <div style="flex:1">
          <div class="recent-item-title">${r.title}</div>
          <div class="recent-item-meta">${r.street} · ${formatDate(r.date)}</div>
        </div>
        <span class="sev-badge ${r.severity}">${sevEmoji(r.severity)} ${cap(r.severity)}</span>
      </div>
    `).join('');
    list.querySelectorAll('.recent-item').forEach(el => {
      el.addEventListener('click', () => openModal(el.dataset.id));
    });
  } catch (err) {
    console.error('Home init error:', err);
  }
}

// ============================================================
// HAZARD MAP
// ============================================================
let mapInitialized = false;

async function initMap() {
  if (mapInitialized) {
    await refreshMapMarkers();
    return;
  }

  const L = window.L;
  if (!L) { showToast('⚠️ Map library failed to load.'); return; }

  const center = APP_CONFIG.mapCenter;
  const map = L.map('hazardMap', {
    center: [center.lat, center.lng],
    zoom: APP_CONFIG.mapZoom,
    zoomControl: true,
  });
  App.map = map;

  // Tile layer
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(map);

  // Draw hazard zones
  const zoneColors = { critical: '#7C0000', high: '#D62828', medium: '#F97316', low: '#F59E0B' };
  APP_CONFIG.hazardZones.forEach(zone => {
    const color = zoneColors[zone.level] || '#64748B';
    const poly = L.polygon(zone.coordinates, {
      color:       color,
      fillColor:   color,
      fillOpacity: 0.25,
      weight:      2,
      dashArray:   zone.level === 'low' ? '6,4' : null,
    }).addTo(map);
    poly.bindPopup(`
      <div>
        <strong style="color:${color}">${zone.name}</strong><br>
        <span style="font-size:0.78rem;color:#64748B;text-transform:capitalize">${zone.level} risk zone</span><br>
        <p style="margin-top:6px;font-size:0.8rem">${zone.description}</p>
      </div>
    `);
    App.mapZones.push(poly);
  });

  // Evacuation centers
  const evIcon = L.divIcon({ html: '🏫', className: '', iconSize: [24, 24], iconAnchor: [12, 12] });
  APP_CONFIG.evacuationCenters.forEach(ec => {
    L.marker([ec.lat, ec.lng], { icon: evIcon })
      .addTo(map)
      .bindPopup(`<strong>${ec.name}</strong><br>Capacity: ${ec.capacity} persons`);
  });

  // Barangay Hall
  const hallIcon = L.divIcon({ html: '🏛️', className: '', iconSize: [24, 24], iconAnchor: [12, 12] });
  L.marker([center.lat, center.lng], { icon: hallIcon })
    .addTo(map)
    .bindPopup('<strong>Brgy. Marulas Hall</strong><br>Main coordination center');

  mapInitialized = true;

  // Center button
  $('#mapCenterBtn').addEventListener('click', () => {
    map.setView([center.lat, center.lng], APP_CONFIG.mapZoom);
  });

  // Severity filter
  $('#mapSevFilter').addEventListener('click', async (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    $('#mapSevFilter .chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    App.mapFilters.severity = chip.dataset.filter;
    await refreshMapMarkers();
  });

  await refreshMapMarkers();
}

async function refreshMapMarkers() {
  const L = window.L;
  // Clear old markers
  App.mapMarkers.forEach(m => App.map.removeLayer(m));
  App.mapMarkers = [];

  const reports = await Database.query({ severity: App.mapFilters.severity, status: 'all' });
  const active  = reports.filter(r => r.status !== 'resolved');

  const sevColors = { critical:'#7C0000', high:'#D62828', medium:'#F97316', low:'#F59E0B' };

  // Use random offsets around Marulas center since we don't have exact GPS per report
  const center = APP_CONFIG.mapCenter;
  active.forEach((r, i) => {
    // Deterministic offset based on report id hash
    const seed = r.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    const lat  = center.lat + ((seed % 97) - 48) * 0.00015;
    const lng  = center.lng + ((seed % 83) - 41) * 0.00015;
    const color = sevColors[r.severity] || '#64748B';
    const icon  = L.divIcon({
      html: `<div style="background:${color};width:22px;height:22px;border-radius:50%;border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;font-size:10px">${sevEmoji(r.severity)}</div>`,
      className: '', iconSize: [22, 22], iconAnchor: [11, 11],
    });
    const marker = L.marker([lat, lng], { icon })
      .addTo(App.map)
      .bindPopup(`
        <div>
          <strong>${r.title}</strong><br>
          <span style="font-size:0.75rem;color:#64748B">${r.street}</span><br>
          <span style="display:inline-block;margin-top:5px;padding:1px 8px;background:${color};color:white;border-radius:999px;font-size:0.7rem;font-weight:600">${cap(r.severity)}</span>
          <span style="display:inline-block;margin-top:5px;padding:1px 8px;background:#E2E8F0;border-radius:999px;font-size:0.7rem;font-weight:600;margin-left:4px">${cap(r.status)}</span>
          <p style="margin-top:6px;font-size:0.78rem;color:#334155">${(r.description || '').slice(0, 120)}...</p>
          <p style="font-size:0.72rem;color:#64748B;margin-top:4px">${formatDate(r.date)}</p>
        </div>
      `);
    App.mapMarkers.push(marker);
  });

  // Sidebar incident list
  const list = $('#mapIncidentList');
  $('#incidentCount').textContent = active.length;
  if (active.length === 0) {
    list.innerHTML = '<div class="map-incident-empty">No active incidents matching filter.</div>';
    return;
  }
  list.innerHTML = active.map((r, i) => `
    <div class="map-incident-item sev-${r.severity}" data-idx="${i}">
      <div class="map-incident-title">${r.title}</div>
      <div class="map-incident-meta">${r.street} · ${formatDate(r.date)}</div>
    </div>
  `).join('');
  list.querySelectorAll('.map-incident-item').forEach((el, i) => {
    el.addEventListener('click', () => {
      if (App.mapMarkers[i]) {
        App.mapMarkers[i].openPopup();
        App.map.flyTo(App.mapMarkers[i].getLatLng(), 17);
      }
    });
  });
}

// ============================================================
// REPORT FORM
// ============================================================
function resetForm() {
  ['reportTitle','reportType','reportSeverity','reportStreet','reportDescription',
   'reporterName','reporterContact'].forEach(id => {
    const el = $(`#${id}`); if (el) el.value = '';
  });
  if ($('#reportAnonymous')) $('#reportAnonymous').checked = false;
  $$('.sev-btn').forEach(b => b.classList.remove('selected'));
  const s = $('#formSuccess');
  if (s) s.classList.remove('show');
  $('#titleCount').textContent = '0/100';
  $('#descCount').textContent  = '0/600';
  // Show form elements
  $$('.form-section-title, .form-grid, .form-actions').forEach(el => el.style.display = '');
}

$('#reportTitle').addEventListener('input', function() { $('#titleCount').textContent = `${this.value.length}/100`; });
$('#reportDescription').addEventListener('input', function() { $('#descCount').textContent = `${this.value.length}/600`; });

$$('.sev-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.sev-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    $('#reportSeverity').value = btn.dataset.value;
  });
});

$('#submitReportBtn').addEventListener('click', async () => {
  const data = {
    title:           $('#reportTitle').value.trim(),
    type:            $('#reportType').value,
    severity:        $('#reportSeverity').value,
    street:          $('#reportStreet').value.trim(),
    description:     $('#reportDescription').value.trim(),
    reporterName:    $('#reporterName').value.trim(),
    reporterContact: $('#reporterContact').value.trim(),
    anonymous:       $('#reportAnonymous').checked,
    barangay:        'Brgy. Marulas',
  };

  const missing = ['title','type','severity','street','description','reporterName'].filter(k => !data[k]);
  if (missing.length) { showToast('⚠️ Please fill in all required fields.'); return; }
  if (data.anonymous) data.reporterName = 'Anonymous';

  try {
    $('#submitReportBtn').textContent = 'Submitting...';
    const report = await Database.create(data);
    $$('.form-section-title, .form-grid, .form-actions').forEach(el => el.style.display = 'none');
    $('#formSuccess').classList.add('show');
    showToast(`✅ Report ${report.id} submitted! Synced to all users.`);
    // Refresh home stats if open
    mapInitialized = false; // force map refresh next visit
  } catch (err) {
    showToast('❌ Submission failed: ' + err.message);
  } finally {
    $('#submitReportBtn').textContent = '✓ Submit Report';
  }
});

$('#submitAnotherBtn').addEventListener('click', resetForm);

// ============================================================
// VIEW REPORTS PAGE
// ============================================================
async function initView() {
  // Show admin UI
  $('#adminBadge').style.display    = App.isAdmin ? 'inline-flex' : 'none';
  $('#resolveNotice').style.display = App.isAdmin ? 'block' : 'none';

  await loadReports();
}

async function loadReports() {
  try {
    const reports = await Database.query(App.filters);
    renderTable(reports);
    renderCards(reports);
    const empty = reports.length === 0;
    $('#emptyState').style.display    = empty ? 'block' : 'none';
    $('#reportsTableWrap').style.display = empty ? 'none' : 'block';
    $('#reportsCards').style.display  = empty ? 'none' : 'flex';
  } catch (err) {
    showToast('❌ Failed to load reports: ' + err.message);
  }
}

function renderTable(reports) {
  const tbody = $('#reportsTableBody');
  tbody.innerHTML = reports.map(r => {
    const isResolved = r.status === 'resolved';
    const countdown  = (isResolved && r.resolvedAt)
      ? `<span class="countdown-badge">⏱ ${timeUntilDelete(r.resolvedAt)}</span>` : '';

    const adminActions = App.isAdmin ? `
      ${r.status !== 'resolved' ? `
        <button class="action-btn" data-action="responding" data-id="${r.id}">🔵 Respond</button>
        <button class="action-btn resolve-btn" data-action="resolve" data-id="${r.id}">✓ Resolve</button>
      ` : ''}
      <button class="action-btn delete-btn" data-action="delete" data-id="${r.id}">🗑</button>
    ` : '';

    return `<tr>
      <td><code style="font-size:0.72rem;color:var(--gray-500)">${r.id}</code></td>
      <td><strong style="font-size:0.83rem">${r.title}</strong>${countdown}</td>
      <td style="white-space:nowrap;font-size:0.8rem">${typeLabel(r.type)}</td>
      <td><div style="font-size:0.8rem">${r.barangay}</div><div style="font-size:0.72rem;color:var(--gray-500)">${r.street}</div></td>
      <td><span class="sev-badge ${r.severity}">${sevEmoji(r.severity)} ${cap(r.severity)}</span></td>
      <td><span class="status-badge ${r.status}">${cap(r.status)}</span></td>
      <td style="white-space:nowrap;font-size:0.77rem;color:var(--gray-500)">${formatDate(r.date)}</td>
      <td>
        <button class="action-btn" data-action="view" data-id="${r.id}">👁 View</button>
        ${adminActions}
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--gray-500)">No reports found.</td></tr>';
}

function renderCards(reports) {
  const container = $('#reportsCards');
  container.innerHTML = reports.map(r => `
    <div class="report-card sev-${r.severity}" data-id="${r.id}">
      <div class="rc-header">
        <div class="rc-title">${r.title}</div>
        <span class="sev-badge ${r.severity}">${sevEmoji(r.severity)}</span>
      </div>
      <div class="rc-body">${r.street}</div>
      <div class="rc-footer">
        <span class="status-badge ${r.status}">${cap(r.status)}</span>
        <span style="font-size:0.72rem;color:var(--gray-500);margin-left:auto">${formatDate(r.date)}</span>
      </div>
    </div>
  `).join('');
  container.querySelectorAll('.report-card').forEach(el => {
    el.addEventListener('click', () => openModal(el.dataset.id));
  });
}

// Table action delegation
$('#reportsTableBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const { action, id } = btn.dataset;

  if (action === 'view') { openModal(id); return; }

  // Admin-only actions
  if (!App.isAdmin) { showToast('🔒 Admin access required.'); return; }

  if (action === 'responding') {
    await Database.updateStatus(id, 'responding');
    showToast('🔵 Marked as Responding.');
    await loadReports(); await initHome();
  }
  if (action === 'resolve') {
    await Database.updateStatus(id, 'resolved');
    showToast('✅ Report resolved. Auto-deletes in 24 hours.');
    await loadReports(); await initHome();
  }
  if (action === 'delete') {
    if (!confirm('Delete this report permanently?')) return;
    await Database.deleteReport(id);
    showToast('🗑️ Report deleted.');
    await loadReports(); await initHome();
  }
});

// Filters
$('#severityFilter').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip'); if (!chip) return;
  $('#severityFilter .chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  App.filters.severity = chip.dataset.filter;
  loadReports();
});
$('#statusFilter').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip'); if (!chip) return;
  $('#statusFilter .chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  App.filters.status = chip.dataset.filter;
  loadReports();
});
$('#searchReports').addEventListener('input', function() {
  App.filters.search = this.value;
  loadReports();
});
$('#refreshBtn').addEventListener('click', async () => {
  showToast('↻ Refreshing...');
  await loadReports();
  await initHome();
  showToast('✅ Data refreshed.');
});

// ============================================================
// MODAL
// ============================================================
async function openModal(id) {
  const r = await Database.getById(id);
  if (!r) return;

  const adminActions = App.isAdmin ? `
    <div class="modal-actions">
      ${r.status !== 'resolved' ? `
        <button class="action-btn" onclick="modalAction('responding','${r.id}')">🔵 Responding</button>
        <button class="action-btn resolve-btn" onclick="modalAction('resolve','${r.id}')">✓ Resolve</button>
      ` : `<span style="font-size:0.8rem;color:var(--green)">✅ Resolved · ${r.resolvedAt ? timeUntilDelete(r.resolvedAt) : ''}</span>`}
      <button class="action-btn delete-btn" onclick="modalAction('delete','${r.id}')">🗑 Delete</button>
    </div>
  ` : '';

  $('#modalBody').innerHTML = `
    <div class="modal-sev-bar ${r.severity}"></div>
    <div class="modal-title">${r.title}</div>
    <div class="modal-sub">${r.id} · Submitted ${formatDate(r.date)}</div>
    <div class="modal-details">
      <div class="modal-detail-item"><label>Type</label><span>${typeLabel(r.type)}</span></div>
      <div class="modal-detail-item"><label>Severity</label><span><span class="sev-badge ${r.severity}">${sevEmoji(r.severity)} ${cap(r.severity)}</span></span></div>
      <div class="modal-detail-item"><label>Barangay</label><span>${r.barangay}</span></div>
      <div class="modal-detail-item"><label>Location</label><span>${r.street}</span></div>
      <div class="modal-detail-item"><label>Status</label><span><span class="status-badge ${r.status}">${cap(r.status)}</span></span></div>
      <div class="modal-detail-item"><label>Reported By</label><span>${r.anonymous ? '🕵️ Anonymous' : r.reporterName}</span></div>
    </div>
    <div class="modal-desc">${r.description || 'No description provided.'}</div>
    ${adminActions}
  `;
  $('#modalOverlay').classList.add('open');
}

window.modalAction = async function(action, id) {
  if (!App.isAdmin) { showToast('🔒 Admin only.'); return; }
  closeModal();
  if (action === 'responding') {
    await Database.updateStatus(id, 'responding');
    showToast('🔵 Marked as Responding.');
  }
  if (action === 'resolve') {
    await Database.updateStatus(id, 'resolved');
    showToast('✅ Resolved — auto-deletes in 24h.');
  }
  if (action === 'delete') {
    if (!confirm('Delete this report?')) return;
    await Database.deleteReport(id);
    showToast('🗑️ Deleted.');
  }
  if (App.currentPage === 'view') await loadReports();
  await initHome();
};

function closeModal() { $('#modalOverlay').classList.remove('open'); }
$('#modalClose').addEventListener('click', closeModal);
$('#modalOverlay').addEventListener('click', (e) => { if (e.target === $('#modalOverlay')) closeModal(); });

// ============================================================
// MOBILE MENU
// ============================================================


$('#mobileMenuBtn').addEventListener('click', function() {
  $('#mobileNav').classList.toggle('open');
  this.classList.toggle('open');
});

// ============================================================
// REAL-TIME SYNC
// ============================================================
function initRealtime() {
  Database.subscribe(async (payload) => {
    showToast('🔄 Data updated by another user.');
    if (App.currentPage === 'home') await initHome();
    if (App.currentPage === 'view') await loadReports();
  });
}

// ============================================================
// AUTO-DELETE RESOLVED REPORTS (24h)
// ============================================================
async function runAutoPurge() {
  const deleted = await Database.purgeExpiredResolved();
  if (deleted > 0) {
    showToast(`🗑️ ${deleted} expired resolved report(s) auto-deleted.`);
    if (App.currentPage === 'home') await initHome();
    if (App.currentPage === 'view') await loadReports();
  }
}

// ============================================================
// DB INDICATOR
// ============================================================
function updateDbIndicator(online) {
  const el = $('#dbIndicator');
  el.className = 'db-indicator ' + (online ? 'online' : 'offline');
  el.querySelector('.db-label').textContent = online ? 'Live Sync' : 'Local DB';
  el.title = online ? 'Connected to Supabase — real-time sync active' : 'Using localStorage — configure Supabase in config.js for real-time sync';
}

// ============================================================
// BOOT
// ============================================================
async function boot() {
  // Init database
  const online = await Database.init();
  updateDbIndicator(online);

  // Init auth
  await initAuth();

  // Real-time if online
  if (online) initRealtime();

  // Auto-purge every hour
  await runAutoPurge();
  setInterval(runAutoPurge, 3600 * 1000);

  // Refresh stats every 30s
  setInterval(async () => {
    if (App.currentPage === 'home') await initHome();
  }, 30000);

  // Initial page
  navigate('home');

  console.log('%cBaHALA v2 — Brgy. Marulas Flood Warning System', 'color:#005F99;font-size:14px;font-weight:bold');
  console.log('%cSupabase:', 'color:#64748B', online ? '✅ Connected' : '⚠️ Not configured (localStorage mode)');
  console.log('%cAdmin emails:', 'color:#64748B', APP_CONFIG.adminUsers);
}

boot();
