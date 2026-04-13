/* ============================================================
   app.js — BaHALA v2 Application Logic
   - Auth (user vs admin roles) + Profile management
   - Image capture/upload on report form
   - Password strength & change password
   - Email verification toast notification
   - Supabase real-time sync (falls back to localStorage)
   - Interactive Leaflet Hazard Map
   - Auto-delete resolved reports after 24h
   - Admin-only: resolve, delete, status update
   - Low bandwidth detection → lite mode suggestion
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
  pendingImageFile: null,
  pendingImageUrl: null,
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

function showHazardNotification(title, body, actionLabel = 'View on Map', onAction = null) {
  const el = $('#hazardNotification');
  if (!el) return;
  
  $('#hnTitle').textContent = title;
  $('#hnBody').textContent  = body;
  const actionBtn = $('#hnAction');
  
  actionBtn.textContent = actionLabel;
  actionBtn.onclick = () => {
    if (onAction) onAction();
    el.classList.remove('show');
  };

  el.classList.add('show');

  // Auto-hide after 12 seconds
  if (el._timer) clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.classList.remove('show');
  }, 12000);
}

$('#hnClose').addEventListener('click', () => {
  const el = $('#hazardNotification');
  el.classList.remove('show');
  if (el._timer) clearTimeout(el._timer);
});

// ============================================================
// NAVIGATION
// ============================================================
function navigate(page, pushHash = true) {
  if (!page) return;
  
  // Persistence: Stay on current page on refresh by using URL Hash
  if (pushHash) {
    if (window.location.hash.slice(1) !== page) {
      window.location.hash = page;
    }
  }

  $$('.page').forEach(p => p.classList.remove('active'));
  const target = $(`#page-${page}`);
  if (!target) return;
  target.classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  App.currentPage = page;
  
  if ($('#adminDrawToolbar')) {
    $('#adminDrawToolbar').style.display = (App.isAdmin && page === 'map') ? 'flex' : 'none';
  }

  $$('[data-page]').forEach(el => {
    if (el.classList.contains('nav-link') || el.classList.contains('mobile-nav-link')) {
      el.classList.toggle('active', el.dataset.page === page);
    }
  });

  $('#mobileNav').classList.remove('open');
  $('#mobileMenuBtn').classList.remove('open');

  if (page === 'home')    initHome();
  if (page === 'view')    initView();
  if (page === 'map')     initMap();
  if (page === 'report')  resetForm();
  if (page === 'profile') initProfile();
  if (page === 'notifications') initNotifications();
}

window.addEventListener('hashchange', () => {
  const page = window.location.hash.slice(1) || 'home';
  if (page !== App.currentPage) navigate(page, false);
});

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-page]');
  if (!el) return;
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

  $('#userMenu').style.display    = 'flex';
  $('#loginNavBtn').style.display = 'none';
  $('#mobileLoginLink').style.display = 'none';
  $('#userAvatar').textContent    = initials;
  $('#userNameDisplay').textContent = name;
  $('#userRoleDisplay').textContent = App.isAdmin ? '🛡️ Admin' : '👤 Resident';
  if ($('#adminDrawToolbar')) {
    $('#adminDrawToolbar').style.display = (App.isAdmin && App.currentPage === 'map') ? 'flex' : 'none';
  }

  showToast(`✅ Signed in as ${name}${App.isAdmin ? ' (Admin)' : ''}`);
}

function clearUser() {
  App.currentUser = null;
  App.isAdmin     = false;
  if ($('#adminDrawToolbar')) $('#adminDrawToolbar').style.display = 'none';
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

// Password strength meter on register form
$('#regPassword').addEventListener('input', function() {
  const pwd = this.value;
  const { score, label, cls } = Database.checkPasswordStrength(pwd);
  const bars = $$('#pwStrengthBars .pw-strength-bar');
  bars.forEach((bar, i) => {
    bar.className = 'pw-strength-bar';
    if (i < score && pwd.length > 0) bar.classList.add(cls);
  });
  $('#pwStrengthLabel').textContent = label;
  $('#pwStrengthLabel').style.color = cls === 'weak' ? '#EF4444' : cls === 'fair' ? '#F59E0B' : '#16A34A';
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

// Sign Up — shows floating toast for email verification
$('#signUpBtn').addEventListener('click', async () => {
  const name     = $('#regName').value.trim();
  const email    = $('#regEmail').value.trim();
  const password = $('#regPassword').value;
  const confirmPw = $('#regConfirmPassword').value;

  if (!name || !email || !password || !confirmPw) { showToast('⚠️ Fill in all fields.'); return; }
  if (password !== confirmPw) { showToast('⚠️ Passwords do not match.'); return; }

  const { score } = Database.checkPasswordStrength(password);
  if (score < 2) { showToast('⚠️ Password too weak — add uppercase letters, numbers, or symbols.'); return; }

  try {
    $('#signUpBtn').textContent = 'Creating account...';
    await Database.Auth.signUp(email, password, name);

    // ✉️ Email verification floating message
    showToast('✅ Account created! A verification email has been sent to ' + email + '. Please check your inbox.', 6000);

    // Switch to sign-in tab
    $$('.auth-tab')[0].click();
    $('#loginEmail').value = email;
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

// Profile from dropdown
$('#profileBtn').addEventListener('click', () => {
  $('#userDropdown').style.display = 'none';
  navigate('profile');
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

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(map);

  App.renderHazardZones = async () => {
    App.mapZones.forEach(poly => map.removeLayer(poly));
    App.mapZones = [];
    let zones = await Database.getZones();
    
    // Apply Filter
    if (App.mapFilters.severity !== 'all') {
      zones = zones.filter(z => z.level === App.mapFilters.severity);
    }

    const zoneColors = { critical: '#7C0000', high: '#D62828', medium: '#F97316', low: '#F59E0B' };
    
    zones.forEach(zone => {
      const color = zoneColors[zone.level] || '#64748B';
      if (!zone.coordinates || zone.coordinates.length < 3) return;
      const poly = L.polygon(zone.coordinates, {
        color, fillColor: color, fillOpacity: 0.25,
        weight: 2, dashArray: zone.level === 'low' ? '6,4' : null,
      }).addTo(map);
      
      let popupHtml = `
        <div>
          <strong style="color:${color}">${zone.name}</strong><br>
          <span style="font-size:0.78rem;color:#64748B;text-transform:capitalize">${zone.level} risk zone</span><br>
          <p style="margin-top:6px;font-size:0.8rem">${zone.description}</p>
      `;
      if (App.isAdmin) {
         popupHtml += `
           <div style="display:grid; grid-template-columns:1fr 1fr; gap:4px; margin-top:8px;">
             <button class="btn-submit" style="padding:4px; font-size:0.7rem;" onclick="App._editZone('${zone.id}')">📝 Edit Info</button>
             <button class="btn-primary" style="padding:4px; font-size:0.7rem; background:var(--blue-600)" onclick="App._reshapeZone('${zone.id}')">📏 Reshape</button>
             <button class="btn-cancel" style="padding:4px; font-size:0.7rem; grid-column:span 2" onclick="App._deleteZone('${zone.id}')">🗑️ Delete Zone</button>
           </div>
         `;
      }
      popupHtml += `</div>`;
      
      poly.bindPopup(popupHtml);
      App.mapZones.push(poly);
    });
  };

  App._editZone = async (id) => {
    try {
      const zones = await Database.getZones();
      const zone = zones.find(z => z.id === id);
      if (!zone) return;
      
      App.editingZoneId = id;
      $('#zoneModalTitle').textContent = 'Edit Risk Zone';
      $('#zoneSaveBtn').textContent = 'Update Zone';
      $('#zoneName').value = zone.name;
      $('#zoneSeverity').value = zone.level;
      $('#zoneDesc').value = zone.description || '';
      
      // Select severity button
      $$('#zoneSeverityPicker .sev-btn').forEach(btn => {
        btn.classList.toggle('selected', btn.dataset.value === zone.level);
      });
      
      $('#zoneModalOverlay').classList.add('open');
      App.map.closePopup();
    } catch(e) {
      alert('Error loading zone: ' + e.message);
    }
  };

  App._reshapeZone = async (id) => {
    const zones = await Database.getZones();
    const zone = zones.find(z => z.id === id);
    if (!zone) return;
    
    App.reshapingZoneId = id;
    App.editingZoneId = id; // Also set this for the save logic
    
    // Start drawing mode
    isDrawing = true;
    currentPoints = [];
    $('#btnDrawStart').style.display = 'none';
    $('#btnDrawCancel').style.display = 'block';
    $('#btnDrawFinish').style.display = 'block';
    $('#drawInstructions').innerHTML = `Reshaping: <strong>${zone.name}</strong><br>Click map to redraw points`;
    $('#drawInstructions').style.display = 'block';
    $('#hazardMap').style.cursor = 'crosshair';
    
    App.map.closePopup();
    
    // Hide the actual zone layer temporarily to avoid confusion (or keep as ghost by styling)
    // For now, let's just draw on top.
  };

  App._deleteZone = async (id) => {
    if (!confirm('Are you sure you want to delete this zone?')) return;
    try {
      await Database.deleteZone(id);
      showToast('🗑️ Zone deleted');
      App.renderHazardZones();
    } catch(e) {
      alert('Error deleting zone: ' + e.message);
    }
  };

  await App.renderHazardZones();

  // Drawing Logic
  let isDrawing = false;
  let currentPolyline = null;
  let currentPoints = [];

  $('#btnDrawStart').addEventListener('click', () => {
    isDrawing = true;
    currentPoints = [];
    $('#btnDrawStart').style.display = 'none';
    $('#btnDrawCancel').style.display = 'block';
    $('#btnDrawFinish').style.display = 'block';
    $('#drawInstructions').style.display = 'block';
    $('#hazardMap').style.cursor = 'crosshair';
  });

  const stopDrawing = () => {
    isDrawing = false;
    App.reshapingZoneId = null;
    App.editingZoneId = null;
    if (currentPolyline) { map.removeLayer(currentPolyline); currentPolyline = null; }
    $('#btnDrawStart').style.display = 'block';
    $('#btnDrawCancel').style.display = 'none';
    $('#btnDrawFinish').style.display = 'none';
    $('#drawInstructions').style.display = 'none';
    $('#drawInstructions').textContent = 'Click map to add points';
    $('#hazardMap').style.cursor = '';
  };

  $('#btnDrawCancel').addEventListener('click', stopDrawing);

  map.on('click', (e) => {
    if (!isDrawing) return;
    currentPoints.push([e.latlng.lat, e.latlng.lng]);
    if (!currentPolyline) {
      currentPolyline = L.polygon(currentPoints, {
        color: '#D62828', fillColor: '#D62828', fillOpacity: 0.3, weight: 2, dashArray: '4'
      }).addTo(map);
    } else {
      currentPolyline.setLatLngs(currentPoints);
    }
  });

  $('#btnDrawFinish').addEventListener('click', () => {
    if (currentPoints.length < 3) { showToast('⚠️ Draw at least 3 points to form a polygon.'); return; }
    
    if (App.reshapingZoneId) {
      // If we're just reshaping, we don't necessarily need the modal if the info is the same,
      // but let's open the modal to allow confirming name/risk too.
      App._editZone(App.reshapingZoneId);
    } else {
      $('#zoneModalTitle').textContent = 'Save Risk Zone';
      $('#zoneSaveBtn').textContent = 'Save Zone';
      $('#zoneModalOverlay').classList.add('open');
    }
  });

  // Zone Modal Handlers
  $$('#zoneSeverityPicker .sev-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('#zoneSeverityPicker .sev-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      $('#zoneSeverity').value = btn.dataset.value;
    });
  });

  $('#zoneCancelBtn').addEventListener('click', () => {
    $('#zoneModalOverlay').classList.remove('open');
    if (!isDrawing) {
       App.editingZoneId = null;
    }
  });

  $('#zoneSaveBtn').addEventListener('click', async () => {
    const name = $('#zoneName').value.trim();
    const severity = $('#zoneSeverity').value;
    const desc = $('#zoneDesc').value.trim();
    if (!name || !severity) { showToast('⚠️ Name and Risk Level are required.'); return; }
    
    $('#zoneSaveBtn').textContent = 'Saving...';
    try {
      const zoneData = {
        name, level: severity, description: desc
      };
      
      // Add coordinates if we just drew/reshaped them
      if (currentPoints.length >= 3) {
        zoneData.coordinates = currentPoints;
      }
      
      if (App.editingZoneId) {
        await Database.updateZone(App.editingZoneId, zoneData);
        showToast('✅ Zone updated');
      } else {
        await Database.createZone(zoneData);
        showToast('✅ Saved risk zone');
      }
      
      $('#zoneModalOverlay').classList.remove('open');
      stopDrawing();
      App.renderHazardZones();
    } catch(e) {
      alert('Error saving zone: ' + e.message);
    } finally {
      $('#zoneSaveBtn').textContent = App.editingZoneId ? 'Update Zone' : 'Save Zone';
      if (!App.editingZoneId) {
        $('#zoneName').value = '';
        $('#zoneSeverity').value = '';
        $('#zoneDesc').value = '';
        $$('#zoneSeverityPicker .sev-btn').forEach(b => b.classList.remove('selected'));
      }
    }
  });

  const evIcon = L.divIcon({ html: '🏫', className: '', iconSize: [24, 24], iconAnchor: [12, 12] });
  APP_CONFIG.evacuationCenters.forEach(ec => {
    L.marker([ec.lat, ec.lng], { icon: evIcon })
      .addTo(map)
      .bindPopup(`<strong>${ec.name}</strong><br>Capacity: ${ec.capacity} persons`);
  });

  const hallIcon = L.divIcon({ html: '🏛️', className: '', iconSize: [24, 24], iconAnchor: [12, 12] });
  L.marker([center.lat, center.lng], { icon: hallIcon })
    .addTo(map)
    .bindPopup('<strong>Brgy. Marulas Hall</strong><br>Main coordination center');

  $('#mapCenterBtn').addEventListener('click', () => {
    map.setView([center.lat, center.lng], APP_CONFIG.mapZoom);
  });

  initMapFilters();

  await refreshMapMarkers();
  if (typeof App.renderHazardZones === 'function') {
    await App.renderHazardZones();
  }

  mapInitialized = true;
}

// Global Map Filter initialization
function initMapFilters() {
  const filterGroup = $('#mapSevFilter');
  if (!filterGroup) return;

  filterGroup.addEventListener('click', async (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;

    // UI Update
    $$('#mapSevFilter .chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');

    // Filter Logic
    App.mapFilters.severity = chip.dataset.filter;
    
    if (App.map && mapInitialized) {
      try {
        await refreshMapMarkers();
        if (typeof App.renderHazardZones === 'function') {
          await App.renderHazardZones();
        }
      } catch (err) {
        console.error('Filter update error:', err);
      }
    }
  });
}

async function refreshMapMarkers() {
  const L = window.L;
  App.mapMarkers.forEach(m => App.map.removeLayer(m));
  App.mapMarkers = [];

  const reports = await Database.query({ severity: App.mapFilters.severity, status: 'all' });
  const active  = reports.filter(r => r.status !== 'resolved');

  const sevColors = { critical:'#7C0000', high:'#D62828', medium:'#F97316', low:'#F59E0B' };
  const center = APP_CONFIG.mapCenter;

  active.forEach((r) => {
    const seed = r.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    const lat  = r.lat ? r.lat : center.lat + ((seed % 97) - 48) * 0.00015;
    const lng  = r.lng ? r.lng : center.lng + ((seed % 83) - 41) * 0.00015;
    const color = sevColors[r.severity] || '#64748B';
    const icon  = L.divIcon({
      html: `<div style="background:${color};width:22px;height:22px;border-radius:50%;border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;font-size:10px">${sevEmoji(r.severity)}</div>`,
      className: '', iconSize: [22, 22], iconAnchor: [11, 11],
    });
    const imgThumb = r.imageUrl
      ? `<img src="${r.imageUrl}" style="width:100%;border-radius:6px;margin-top:6px;max-height:100px;object-fit:cover" loading="lazy">`
      : '';
    const marker = L.marker([lat, lng], { icon })
      .addTo(App.map);
    marker.reportId = r.id; // Store ID on marker
    marker.bindPopup(`
        <div>
          <strong>${r.title}</strong><br>
          <span style="font-size:0.75rem;color:#64748B">${r.street}</span><br>
          <span style="display:inline-block;margin-top:5px;padding:1px 8px;background:${color};color:white;border-radius:999px;font-size:0.7rem;font-weight:600">${cap(r.severity)}</span>
          <span style="display:inline-block;margin-top:5px;padding:1px 8px;background:#E2E8F0;border-radius:999px;font-size:0.7rem;font-weight:600;margin-left:4px">${cap(r.status)}</span>
          <p style="margin-top:6px;font-size:0.78rem;color:#334155">${(r.description || '').slice(0, 120)}...</p>
          <p style="font-size:0.72rem;color:#64748B;margin-top:4px">${formatDate(r.date)}</p>
          ${imgThumb}
        </div>
      `);
    App.mapMarkers.push(marker);
  });

  const list = $('#mapIncidentList');
  $('#incidentCount').textContent = active.length;
  if (active.length === 0) {
    list.innerHTML = '<div class="map-incident-empty">No active incidents matching filter.</div>';
    return;
  }
  
  list.innerHTML = active.map((r) => `
    <div class="map-incident-item sev-${r.severity}" data-id="${r.id}">
      <div class="map-incident-title">${r.title}</div>
      <div class="map-incident-meta">${r.street} · ${formatDate(r.date)}</div>
    </div>
  `).join('');

  list.querySelectorAll('.map-incident-item').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      const marker = App.mapMarkers.find(m => m.reportId === id);
      if (marker) {
        marker.openPopup();
        App.map.flyTo(marker.getLatLng(), 17);
      }
    });
  });
}

// ============================================================
// REPORT FORM — IMAGE UPLOAD HANDLERS
// ============================================================
function resetForm() {
  ['reportTitle','reportType','reportSeverity','reportStreet','reportDescription',
   'reporterName','reporterContact','reportLat','reportLng'].forEach(id => {
    const el = $(`#${id}`); if (el) el.value = '';
  });
  const statusEl = $('#locationStatus');
  if (statusEl) statusEl.style.display = 'none';
  if ($('#reportAnonymous')) $('#reportAnonymous').checked = false;
  $$('.sev-btn').forEach(b => b.classList.remove('selected'));
  const s = $('#formSuccess');
  if (s) s.classList.remove('show');
  $('#titleCount').textContent = '0/100';
  $('#descCount').textContent  = '0/600';
  $$('.form-section-title, .form-grid, .form-actions').forEach(el => el.style.display = '');

  // Reset image state
  App.pendingImageFile = null;
  App.pendingImageUrl  = null;
  if ($('#reportImageUpload')) $('#reportImageUpload').value = '';
  if ($('#reportImageCamera')) $('#reportImageCamera').value = '';
  $('#imagePreviewWrap').style.display = 'none';
  $('#imagePreview').src = '';
  $('#uploadProgressWrap').style.display = 'none';
  $('#uploadProgressBar').style.width = '0';
  if ($('#btnCameraImage')) $('#btnCameraImage').style.display = 'flex';
  const uploadZone = $('#imageUploadZone');
  if (uploadZone) {
    uploadZone.style.display = 'block';
    const textNode = uploadZone.querySelector('p');
    if (textNode) textNode.textContent = 'Tap to Upload or Drag & Drop here';
  }
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

// Geolocation
$('#btnGetLocation').addEventListener('click', () => {
  if (!navigator.geolocation) {
    showToast('⚠️ Geolocation not supported.');
    return;
  }
  const statusEl = $('#locationStatus');
  statusEl.textContent = 'Fetching location...';
  statusEl.style.display = 'block';
  statusEl.style.color = 'var(--primary)';

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      $('#reportLat').value = lat;
      $('#reportLng').value = lng;
      statusEl.textContent = `📍 GPS Acquired (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
      statusEl.style.color = 'var(--green)';

      // Auto-populate street field if empty using basic fetch (optional enrichment)
      if (!$('#reportStreet').value) {
        $('#reportStreet').value = `GPS Location: ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
      }
    },
    (err) => {
      statusEl.textContent = `⚠️ Required: ${err.message}`;
      statusEl.style.color = 'var(--red)';
    },
    { enableHighAccuracy: true, timeout: 15000 }
  );
});

// Image file selection / camera capture
$('#btnCameraImage').addEventListener('click', () => $('#reportImageCamera').click());

const handleImageSelection = function() {
  const file = this.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { showToast('⚠️ Image must be under 5MB.'); this.value = ''; return; }
  App.pendingImageFile = file;
  const reader = new FileReader();
  reader.onload = (e) => {
    $('#imagePreview').src = e.target.result;
    $('#imagePreviewWrap').style.display = 'block';
    $('#imageUploadZone').querySelector('p').textContent = file.name;
    if ($('#btnCameraImage')) $('#btnCameraImage').style.display = 'none';
    $('#imageUploadZone').style.display = 'none';
  };
  reader.readAsDataURL(file);
};

$('#reportImageUpload').addEventListener('change', handleImageSelection);
$('#reportImageCamera').addEventListener('change', handleImageSelection);

// Drag & drop on upload zone
const zone = $('#imageUploadZone');
zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
zone.addEventListener('drop', (e) => {
  e.preventDefault();
  zone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) {
    $('#reportImageUpload').files = e.dataTransfer.files;
    $('#reportImageUpload').dispatchEvent(new Event('change'));
  }
});

$('#removeImageBtn').addEventListener('click', () => {
  App.pendingImageFile = null;
  App.pendingImageUrl  = null;
  if ($('#reportImageUpload')) $('#reportImageUpload').value = '';
  if ($('#reportImageCamera')) $('#reportImageCamera').value = '';
  $('#imagePreview').src = '';
  $('#imagePreviewWrap').style.display = 'none';
  if ($('#btnCameraImage')) $('#btnCameraImage').style.display = 'flex';
  $('#imageUploadZone').style.display = 'block';
  $('#imageUploadZone').querySelector('p').textContent = 'Tap to Upload or Drag & Drop here';
});

// Image preview click-to-zoom
$('#imagePreview').addEventListener('click', () => {
  const src = $('#imagePreview').src;
  if (!src) return;
  $('#imgLightboxImg').src = src;
  $('#imgLightbox').classList.add('open');
});

// Submit report
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
    lat:             $('#reportLat').value ? parseFloat($('#reportLat').value) : null,
    lng:             $('#reportLng').value ? parseFloat($('#reportLng').value) : null,
    imageUrl:        null,
  };

  const missing = ['title','type','severity','street','description','reporterName'].filter(k => !data[k]);
  if (missing.length) { showToast('⚠️ Please fill in all required fields.'); return; }
  if (data.anonymous) data.reporterName = 'Anonymous';

  try {
    $('#submitReportBtn').textContent = 'Submitting...';

    // Upload image if selected
    if (App.pendingImageFile) {
      $('#uploadProgressWrap').style.display = 'block';
      try {
        data.imageUrl = await Database.uploadImage(App.pendingImageFile, (pct) => {
          $('#uploadProgressBar').style.width = pct + '%';
        });
      } catch (imgErr) {
        showToast('⚠️ Image upload failed — submitting without photo.');
        data.imageUrl = null;
      }
      $('#uploadProgressWrap').style.display = 'none';
    }

    const report = await Database.create(data);
    $$('.form-section-title, .form-grid, .form-actions').forEach(el => el.style.display = 'none');
    $('#formSuccess').classList.add('show');
    showToast(`✅ Report ${report.id} submitted! Synced to all users.`);
    mapInitialized = false;
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
  $('#adminBadge').style.display    = App.isAdmin ? 'inline-flex' : 'none';
  $('#resolveNotice').style.display = App.isAdmin ? 'block' : 'none';

  // Reset filters to "all" every time the page is visited
  App.filters = { severity: 'all', status: 'all', search: '' };
  $('#searchReports').value = '';
  _resetChips('#severityFilter');
  _resetChips('#statusFilter');

  await loadReports();
}

function _resetChips(selector) {
  $$(selector + ' .chip').forEach(c => c.classList.remove('active'));
  const first = $(selector + ' .chip');
  if (first) first.classList.add('active');
}

async function loadReports() {
  try {
    // Show loading state
    $('#reportsTableBody').innerHTML =
      '<tr><td colspan="8" style="text-align:center;padding:28px;color:var(--gray-400)">Loading…</td></tr>';

    const reports = await Database.query(App.filters);
    renderTable(reports);

    const empty = reports.length === 0;
    const hasActiveFilter = App.filters.severity !== 'all' ||
                            App.filters.status   !== 'all' ||
                            App.filters.search   !== '';

    // Update result count in the filter bar
    const countEl = $('#filterResultCount');
    if (countEl) {
      countEl.textContent = `${reports.length} report${reports.length !== 1 ? 's' : ''} found`;
      countEl.style.display = 'inline';
    }

    // Show clear button only when a filter is active
    const clearBtn = $('#clearFiltersBtn');
    if (clearBtn) clearBtn.style.display = hasActiveFilter ? 'inline-flex' : 'none';

    $('#emptyState').style.display       = empty ? 'block' : 'none';
    $('#reportsTableWrap').style.display = empty ? 'none' : 'block';
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

    // Show a small camera icon badge if the report has a photo (no thumbnail)
    const photoTag = r.imageUrl
      ? `<span class="photo-tag" title="Has photo">📷</span>`
      : '';

    return `<tr>
      <td><code style="font-size:0.72rem;color:var(--gray-500)">${r.id}</code></td>
      <td>
        <strong style="font-size:0.83rem">${r.title}</strong>${photoTag}${countdown}
      </td>
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


// Table action delegation
$('#reportsTableBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const { action, id } = btn.dataset;

  if (action === 'view') { openModal(id); return; }

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
let _searchDebounce = null;

$('#severityFilter').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip[data-filter]');
  if (!chip) return;
  $$('#severityFilter .chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  App.filters.severity = chip.dataset.filter;
  loadReports();
});

$('#statusFilter').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip[data-filter]');
  if (!chip) return;
  $$('#statusFilter .chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  App.filters.status = chip.dataset.filter;
  loadReports();
});

$('#searchReports').addEventListener('input', function() {
  clearTimeout(_searchDebounce);
  const val = this.value;
  _searchDebounce = setTimeout(() => {
    App.filters.search = val;
    loadReports();
  }, 280); // debounce 280ms so we don't query on every keystroke
});

$('#clearFiltersBtn').addEventListener('click', () => {
  App.filters = { severity: 'all', status: 'all', search: '' };
  $('#searchReports').value = '';
  _resetChips('#severityFilter');
  _resetChips('#statusFilter');
  loadReports();
});

$('#refreshBtn').addEventListener('click', async () => {
  showToast('↻ Refreshing…');
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

  // Build a prominent full-width photo hero when image exists
  const imageSection = r.imageUrl ? `
    <div class="modal-photo">
      <img class="modal-photo-img" src="${r.imageUrl}" alt="Incident photo"
        loading="lazy"
        onclick="openLightbox('${r.imageUrl}')"
        onerror="this.closest('.modal-photo').style.display='none'">
      <div class="modal-photo-overlay">
        <span class="modal-photo-zoom">🔍 Tap to zoom</span>
        <span class="modal-photo-label">📷 Photo Evidence</span>
      </div>
    </div>
  ` : `
    <div class="modal-no-photo">
      <span>📷</span> No photo submitted for this report
    </div>
  `;

  $('#modalBody').innerHTML = `
    <div class="modal-sev-bar ${r.severity}"></div>
    <div class="modal-title">${r.title}</div>
    <div class="modal-sub">${r.id} · Submitted ${formatDate(r.date)}</div>

    ${imageSection}

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

window.openLightbox = function(src) {
  $('#imgLightboxImg').src = src;
  $('#imgLightbox').classList.add('open');
};

function closeModal() { $('#modalOverlay').classList.remove('open'); }
$('#modalClose').addEventListener('click', closeModal);
$('#modalOverlay').addEventListener('click', (e) => { if (e.target === $('#modalOverlay')) closeModal(); });

// Lightbox close
$('#imgLightboxClose').addEventListener('click', () => $('#imgLightbox').classList.remove('open'));
$('#imgLightbox').addEventListener('click', (e) => {
  if (e.target === $('#imgLightbox')) $('#imgLightbox').classList.remove('open');
});

// ============================================================
// PROFILE PAGE
// ============================================================
async function initProfile() {
  const card = $('#profileCard');
  if (!App.currentUser) {
    card.innerHTML = `
      <div class="profile-not-logged">
        <p style="font-size:2rem;margin-bottom:12px">🔐</p>
        <h3>Sign in to view your profile</h3>
        <p style="margin-bottom:18px">Manage your account information and security settings.</p>
        <button class="btn-submit" data-page="login">Sign In</button>
      </div>
    `;
    return;
  }

  const user     = App.currentUser;
  const name     = user.user_metadata?.full_name || user.email.split('@')[0];
  const initials = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  const role     = App.isAdmin ? 'Admin' : 'Resident';
  const roleIcon = App.isAdmin ? '🛡️' : '👤';
  const joinDate = user.created_at
    ? new Date(user.created_at).toLocaleDateString('en-PH', { month:'long', day:'numeric', year:'numeric' })
    : 'N/A';

  card.innerHTML = `
    <div class="profile-header">
      <div class="profile-avatar">${initials}</div>
      <div class="profile-info">
        <h2>${name}</h2>
        <p>${user.email}</p>
        <span class="profile-role-badge ${App.isAdmin ? 'admin' : 'resident'}">${roleIcon} ${role}</span>
      </div>
    </div>

    <!-- Account Info -->
    <div class="profile-section">
      <div class="profile-section-title">Account Information</div>
      <div class="profile-info-row"><span class="profile-info-label">Email</span><span class="profile-info-value">${user.email}</span></div>
      <div class="profile-info-row"><span class="profile-info-label">Role</span><span class="profile-info-value">${roleIcon} ${role}</span></div>
      <div class="profile-info-row"><span class="profile-info-label">Account Created</span><span class="profile-info-value">${joinDate}</span></div>
      <div class="profile-info-row"><span class="profile-info-label">Supabase ID</span><span class="profile-info-value" style="font-size:0.72rem;color:var(--gray-500)">${user.id || 'Local mode'}</span></div>
    </div>

    <!-- Change Name -->
    <div class="profile-section">
      <div class="profile-section-title">Update Display Name</div>
      <div class="profile-form-group">
        <label>Full Name</label>
        <input type="text" id="profileNewName" value="${name}" placeholder="Your full name">
      </div>
      <button class="profile-save-btn" id="saveNameBtn">Save Name</button>
      <div class="profile-feedback" id="nameFeedback"></div>
    </div>

    <!-- Change Password -->
    <div class="profile-section">
      <div class="profile-section-title">Change Password</div>
      ${!Database.isOnline ? '<p style="font-size:0.8rem;color:var(--gray-500);margin-bottom:12px">⚠️ Password change requires Supabase connection.</p>' : ''}
      <div class="profile-form-group">
        <label>Current Password</label>
        <input type="password" id="profileCurrentPw" placeholder="Enter current password">
      </div>
      <div class="profile-form-group">
        <label>New Password</label>
        <input type="password" id="profileNewPw" placeholder="Min. 8 characters">
        <div class="pw-strength" id="profilePwStrengthBars" style="margin-top:6px">
          <div class="pw-strength-bar" id="ppBar1"></div>
          <div class="pw-strength-bar" id="ppBar2"></div>
          <div class="pw-strength-bar" id="ppBar3"></div>
          <div class="pw-strength-bar" id="ppBar4"></div>
        </div>
        <div class="pw-strength-label" id="profilePwLabel"></div>
      </div>
      <div class="profile-form-group">
        <label>Confirm New Password</label>
        <input type="password" id="profileConfirmPw" placeholder="Repeat new password">
      </div>
      <button class="profile-save-btn" id="savePasswordBtn" ${!Database.isOnline ? 'disabled' : ''}>Change Password</button>
      <div class="profile-feedback" id="passwordFeedback"></div>
    </div>
  `;

  // Password strength meter for profile page
  $('#profileNewPw').addEventListener('input', function() {
    const { score, label, cls } = Database.checkPasswordStrength(this.value);
    ['ppBar1','ppBar2','ppBar3','ppBar4'].forEach((id, i) => {
      const bar = $(`#${id}`);
      bar.className = 'pw-strength-bar';
      if (i < score && this.value.length > 0) bar.classList.add(cls);
    });
    $('#profilePwLabel').textContent = label;
    $('#profilePwLabel').style.color = cls === 'weak' ? '#EF4444' : cls === 'fair' ? '#F59E0B' : '#16A34A';
  });

  // Save name
  $('#saveNameBtn').addEventListener('click', async () => {
    const newName = $('#profileNewName').value.trim();
    const fb = $('#nameFeedback');
    try {
      $('#saveNameBtn').disabled = true;
      $('#saveNameBtn').textContent = 'Saving...';
      const updatedUser = await Database.Auth.updateName(newName);
      App.currentUser = updatedUser || { ...App.currentUser, user_metadata: { ...App.currentUser.user_metadata, full_name: newName } };
      // Update header display
      const initials2 = newName.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
      $('#userAvatar').textContent = initials2;
      $('#userNameDisplay').textContent = newName;
      fb.className = 'profile-feedback ok';
      fb.textContent = '✓ Name updated successfully!';
    } catch (err) {
      fb.className = 'profile-feedback err';
      fb.textContent = '✕ ' + err.message;
    } finally {
      $('#saveNameBtn').disabled = false;
      $('#saveNameBtn').textContent = 'Save Name';
    }
  });

  // Change password
  $('#savePasswordBtn').addEventListener('click', async () => {
    const currentPw = $('#profileCurrentPw').value;
    const newPw     = $('#profileNewPw').value;
    const confirmPw = $('#profileConfirmPw').value;
    const fb = $('#passwordFeedback');

    if (!currentPw || !newPw || !confirmPw) {
      fb.className = 'profile-feedback err';
      fb.textContent = '✕ Please fill in all password fields.';
      return;
    }
    if (newPw !== confirmPw) {
      fb.className = 'profile-feedback err';
      fb.textContent = '✕ New passwords do not match.';
      return;
    }

    try {
      $('#savePasswordBtn').disabled = true;
      $('#savePasswordBtn').textContent = 'Changing...';
      await Database.Auth.updatePassword(currentPw, newPw);
      fb.className = 'profile-feedback ok';
      fb.textContent = '✓ Password changed successfully! You may need to sign in again.';
      $('#profileCurrentPw').value = '';
      $('#profileNewPw').value = '';
      $('#profileConfirmPw').value = '';
    } catch (err) {
      fb.className = 'profile-feedback err';
      fb.textContent = '✕ ' + err.message;
    } finally {
      $('#savePasswordBtn').disabled = false;
      $('#savePasswordBtn').textContent = 'Change Password';
    }
  });
}

// ============================================================
// LOW BANDWIDTH DETECTION
// ============================================================
function detectLowBandwidth() {
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!conn) return;

  const slowTypes = ['slow-2g', '2g'];
  if (slowTypes.includes(conn.effectiveType) || conn.saveData) {
    const banners = $('#headerBanners');
    const existing = banners.querySelector('.lite-banner');
    if (existing) return;

    const div = document.createElement('div');
    div.className = 'lite-banner';
    div.innerHTML = `
      <span>📶</span>
      <span>Slow connection detected. Switch to <a href="lite.html">⚡ Lite Mode</a> for a faster experience.</span>
      <button onclick="this.parentElement.remove()" title="Dismiss">✕</button>
    `;
    banners.appendChild(div);
  }
}

// ============================================================
// NOTIFICATIONS PAGE
// ============================================================
async function initNotifications() {
  const list = $('#notificationsList');
  if (!list) return;

  try {
    list.innerHTML = '<div style="text-align:center;padding:40px;color:var(--gray-400)">Checking for alerts…</div>';
    
    // Fetch both zones and reports
    const [zones, reports] = await Promise.all([Database.getZones(), Database.getAll()]);
    
    // Combine into a generic "Alert" object
    const alerts = [
      ...zones.map(z => ({
        type: 'zone',
        title: z.name,
        body: z.description || `${cap(z.level)} risk zone established.`,
        level: z.level,
        date: z.created_at || z.updated_at || new Date().toISOString(),
        id: z.id,
        coordinates: z.coordinates
      })),
      ...reports.filter(r => r.severity === 'critical' || r.severity === 'high').map(r => ({
        type: 'report',
        title: r.title,
        body: `Reported at ${r.street}. ${r.description.slice(0, 100)}...`,
        level: r.severity,
        date: r.date,
        id: r.id
      }))
    ];

    // Sort by date desc
    alerts.sort((a, b) => new Date(b.date) - new Date(a.date));

    if (alerts.length === 0) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🔔</div>
          <h3>No alerts yet</h3>
          <p>Stay tuned for real-time hazard updates from the Barangay Admin.</p>
        </div>
      `;
      return;
    }

    list.innerHTML = alerts.map(a => `
      <div class="notif-item sev-${a.level}" data-type="${a.type}" data-id="${a.id}">
        <div class="notif-icon">${a.type === 'zone' ? '🗺️' : sevEmoji(a.level)}</div>
        <div class="notif-content">
          <div class="notif-header">
            <span class="notif-title">${a.title}</span>
            <span class="notif-time">${formatDate(a.date)}</span>
          </div>
          <p class="notif-body">${a.body}</p>
          <div class="notif-meta">
            <span class="notif-badge ${a.type}">${a.type === 'zone' ? 'Map Zone' : 'Incident'}</span>
            <span class="notif-badge" style="background:var(--gray-100);color:var(--gray-500)">${cap(a.level)} Risk</span>
          </div>
        </div>
      </div>
    `).join('');

    // Add click listeners to items
    list.querySelectorAll('.notif-item').forEach(el => {
      el.addEventListener('click', async () => {
        const { type, id } = el.dataset;
        if (type === 'report') {
          openModal(id);
        } else {
          navigate('map');
          // Wait for map to init
          if (!App.map) await initMap();
          
          const zone = zones.find(z => z.id === id);
          if (zone && zone.coordinates && App.map && window.L) {
             const bounds = window.L.latLngBounds(zone.coordinates);
             App.map.flyToBounds(bounds, { padding: [50, 50], duration: 1.5 });
          }
        }
      });
    });

  } catch (err) {
    console.error('Notif init error:', err);
    list.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${err.message}</p></div>`;
  }
}

$('#refreshNotifsBtn').addEventListener('click', async () => {
  showToast('↻ Refreshing alerts…');
  await initNotifications();
  showToast('✅ Alerts updated.');
});

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
    // If it's a zone update from someone else, show specialized notification
    if (payload.table === 'hazard_zones') {
      const zone = payload.new || payload.old;
      const isInsert = payload.eventType === 'INSERT';
      const isUpdate = payload.eventType === 'UPDATE';
      
      // Skip if this change was made by the current user
      if (zone.created_by === App.currentUser?.email) return;

      if (isInsert || isUpdate) {
        const title = isInsert ? '🚨 New Risk Zone Added' : '📏 Risk Zone Updated';
        const body  = `Admin has ${isInsert ? 'added' : 'updated'} the "${zone.name}" risk zone (${zone.level} risk).`;
        
        showHazardNotification(title, body, 'View on Map', () => {
          navigate('map');
          if (App.map && window.L) {
             // If we have coordinates, fly to it
             if (zone.coordinates && zone.coordinates.length > 0) {
               const bounds = window.L.latLngBounds(zone.coordinates);
               App.map.flyToBounds(bounds, { padding: [50, 50], duration: 1.5 });
             }
          }
        });

        // Always refresh if on map
        if (App.currentPage === 'map' && typeof App.renderHazardZones === 'function') {
           await App.renderHazardZones();
        }
      }
      return;
    }

    // Default report update
    showToast('🔄 Data updated by another user.');
    if (App.currentPage === 'home') await initHome();
    if (App.currentPage === 'view') await loadReports();
    if (App.currentPage === 'map')  await refreshMapMarkers();
    if (App.currentPage === 'notifications') await initNotifications();
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
  el.title = online
    ? 'Connected to Supabase — real-time sync active'
    : 'Using localStorage — configure Supabase in config.js for real-time sync';
}

// ============================================================
// BOOT
// ============================================================
function clearAuthForms() {
  // Clear sensitive data on refresh/load as requested
  if ($('#loginPassword')) $('#loginPassword').value = '';
  if ($('#regName'))     $('#regName').value = '';
  if ($('#regEmail'))    $('#regEmail').value = '';
  if ($('#regPassword')) $('#regPassword').value = '';
  if ($('#regConfirmPassword')) $('#regConfirmPassword').value = '';
  // Optional: clear login email too if preferred
  // if ($('#loginEmail')) $('#loginEmail').value = '';
}

async function boot() {
  const online = await Database.init();
  updateDbIndicator(online);

  await initAuth();

  if (online) initRealtime();

  await runAutoPurge();
  setInterval(runAutoPurge, 3600 * 1000);

  setInterval(async () => {
    if (App.currentPage === 'home') await initHome();
  }, 30000);

  // Detect slow connection
  detectLowBandwidth();

  // Clear forms
  clearAuthForms();

  // Load last visited page or home
  const startPage = window.location.hash.slice(1) || 'home';
  navigate(startPage, false);

  console.log('%cBaHALA v2 — Brgy. Marulas Flood Warning System', 'color:#005F99;font-size:14px;font-weight:bold');
  console.log('%cSupabase:', 'color:#64748B', online ? '✅ Connected' : '⚠️ Not configured (localStorage mode)');
  console.log('%cAdmin emails:', 'color:#64748B', APP_CONFIG.adminUsers);
}

boot();
