/* ============================================================
   database.js — Supabase-Synced Database Layer
   Falls back to localStorage if Supabase not configured.
   All users share the same real-time data.
   ============================================================ */

'use strict';

const Database = (() => {
  let supabase = null;
  let realtimeChannel = null;
  let isSupabaseReady = false;
  const LOCAL_KEY = 'bahala_reports_v3';
  const SEED_KEY  = 'bahala_seeded_v3';

  /* ----------------------------------------------------------
     INIT — connect to Supabase if configured
     ---------------------------------------------------------- */
  async function init() {
    const { url, anonKey } = SUPABASE_CONFIG;

    if (url.includes('YOUR_PROJECT_ID') || !url || !anonKey) {
      console.warn('[DB] Supabase not configured — using localStorage fallback.');
      isSupabaseReady = false;
      _seedLocal();
      return false; 
    }

    try {
      // Dynamically load Supabase SDK
      if (!window.supabase) {
        await _loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js');
      }
      supabase = window.supabase.createClient(url, anonKey);
      isSupabaseReady = true;
      console.log('[DB] ✅ Supabase connected — real-time sync active.');
      return true;
    } catch (err) {
      console.error('[DB] Supabase init failed:', err);
      isSupabaseReady = false;
      _seedLocal();
      return false;
    }
  }

  function _loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  /* ----------------------------------------------------------
     REAL-TIME SUBSCRIPTION
     ---------------------------------------------------------- */
  function subscribe(callback) {
    if (!isSupabaseReady) return;
    realtimeChannel = supabase
      .channel('reports-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reports' },
        (payload) => {
          console.log('[DB] Real-time change:', payload.eventType);
          callback(payload);
        })
      .subscribe();
  }

  function unsubscribe() {
    if (realtimeChannel) supabase.removeChannel(realtimeChannel);
  }

  /* ----------------------------------------------------------
     AUTH
     ---------------------------------------------------------- */
  const Auth = {
    async signIn(email, password) {
      if (!isSupabaseReady) return _localAuth(email, password);
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      return data;
    },

    async signOut() {
      if (isSupabaseReady) await supabase.auth.signOut();
      localStorage.removeItem('bahala_local_user');
    },

    async getUser() {
      if (isSupabaseReady) {
        const { data } = await supabase.auth.getUser();
        return data?.user || null;
      }
      const local = localStorage.getItem('bahala_local_user');
      return local ? JSON.parse(local) : null;
    },

    isAdmin(user) {
      if (!user) return false;
      return APP_CONFIG.adminUsers.includes(user.email);
    },

    async signUp(email, password, name) {
      if (!isSupabaseReady) throw new Error('Supabase not configured for user registration.');
      const { data, error } = await supabase.auth.signUp({
        email, password,
        options: { data: { full_name: name } }
      });
      if (error) throw error;
      return data;
    },
  };

  function _localAuth(email, password) {
    // Demo local auth for development
    const demoUsers = [
      { email: 'admin@marulas.gov.ph', password: 'admin123', role: 'admin', name: 'Barangay Admin' },
      { email: 'bdrrmc@marulas.gov.ph', password: 'bdrrmc123', role: 'admin', name: 'BDRRMC Officer' },
      { email: 'captain@marulas.gov.ph', password: 'captain123', role: 'admin', name: 'Barangay Captain' },
      { email: 'resident@marulas.com', password: 'resident123', role: 'resident', name: 'Juan dela Cruz' },
      { email: 'IAmAtomic@shadowgarden.com', password: 'CidKagenou', role: 'admin', name: 'Shadow' },
    ];
    const user = demoUsers.find(u => u.email === email && u.password === password);
    if (!user) throw new Error('Invalid email or password.');
    const session = { email: user.email, user_metadata: { full_name: user.name }, role: user.role };
    localStorage.setItem('bahala_local_user', JSON.stringify(session));
    return { user: session };
  }

  /* ----------------------------------------------------------
     CRUD OPERATIONS
     ---------------------------------------------------------- */
  async function getAll() {
    if (isSupabaseReady) {
      const { data, error } = await supabase
        .from('reports')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return _normalizeSupabase(data);
    }
    return _localGetAll();
  }

  async function getById(id) {
    if (isSupabaseReady) {
      const { data, error } = await supabase
        .from('reports').select('*').eq('id', id).single();
      if (error) throw error;
      return _normalizeOne(data);
    }
    return _localGetAll().find(r => r.id === id) || null;
  }

  async function create(reportData) {
    const payload = {
      title:            reportData.title,
      type:             reportData.type,
      severity:         reportData.severity,
      barangay:         reportData.barangay,
      street:           reportData.street,
      description:      reportData.description,
      reporter_name:    reportData.reporterName,
      reporter_contact: reportData.reporterContact,
      anonymous:        reportData.anonymous,
      status:           'pending',
    };

    if (isSupabaseReady) {
      const { data, error } = await supabase.from('reports').insert(payload).select().single();
      if (error) throw error;
      return _normalizeOne(data);
    }
    return _localCreate(reportData);
  }

  async function updateStatus(id, status) {
    const patch = { status, updated_at: new Date().toISOString() };
    if (status === 'resolved') patch.resolved_at = new Date().toISOString();

    if (isSupabaseReady) {
      const { data, error } = await supabase.from('reports').update(patch).eq('id', id).select().single();
      if (error) throw error;
      return _normalizeOne(data);
    }
    return _localUpdateStatus(id, status);
  }

  async function deleteReport(id) {
    if (isSupabaseReady) {
      const { error } = await supabase.from('reports').delete().eq('id', id);
      if (error) throw error;
    } else {
      const all = _localGetAll().filter(r => r.id !== id);
      localStorage.setItem(LOCAL_KEY, JSON.stringify(all));
    }
  }

  async function query({ severity = 'all', status = 'all', search = '' } = {}) {
    const all = await getAll();
    return all.filter(r => {
      if (severity !== 'all' && r.severity !== severity) return false;
      if (status !== 'all' && r.status !== status) return false;
      if (search) {
        const q = search.toLowerCase();
        return r.title.toLowerCase().includes(q) ||
               r.barangay.toLowerCase().includes(q) ||
               r.street.toLowerCase().includes(q);
      }
      return true;
    });
  }

  async function stats() {
    const all = await getAll();
    return {
      total:      all.length,
      critical:   all.filter(r => r.severity === 'critical').length,
      pending:    all.filter(r => r.status === 'pending').length,
      responding: all.filter(r => r.status === 'responding').length,
      resolved:   all.filter(r => r.status === 'resolved').length,
    };
  }

  /* ----------------------------------------------------------
     AUTO-DELETE RESOLVED REPORTS after 24h (client-side check)
     Server-side pg_cron handles this in production.
     ---------------------------------------------------------- */
  async function purgeExpiredResolved() {
    const all = await getAll();
    const cutoff = Date.now() - APP_CONFIG.resolvedDeleteAfterHours * 3600 * 1000;
    const expired = all.filter(r => {
      if (r.status !== 'resolved') return false;
      const resolvedTime = new Date(r.resolvedAt || r.date).getTime();
      return resolvedTime < cutoff;
    });

    for (const r of expired) {
      await deleteReport(r.id);
      console.log(`[DB] Auto-deleted expired resolved report: ${r.id}`);
    }
    return expired.length;
  }

  /* ----------------------------------------------------------
     NORMALIZATION — convert Supabase snake_case to camelCase
     ---------------------------------------------------------- */
  function _normalizeOne(r) {
    if (!r) return null;
    return {
      id:              r.id,
      title:           r.title,
      type:            r.type,
      severity:        r.severity,
      barangay:        r.barangay,
      street:          r.street,
      description:     r.description,
      reporterName:    r.reporter_name || r.reporterName,
      reporterContact: r.reporter_contact || r.reporterContact,
      anonymous:       r.anonymous,
      status:          r.status,
      resolvedAt:      r.resolved_at || r.resolvedAt,
      date:            r.created_at || r.date,
      updatedAt:       r.updated_at || r.updatedAt,
    };
  }

  function _normalizeSupabase(arr) {
    return (arr || []).map(_normalizeOne);
  }

  /* ----------------------------------------------------------
     LOCALSTORAGE FALLBACK
     ---------------------------------------------------------- */
  function _localGetAll() {
    try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]'); }
    catch { return []; }
  }

  function _localCreate(data) {
    const all = _localGetAll();
    const id = 'RPT-' + Date.now().toString(36).toUpperCase();
    const report = { id, ...data, status: 'pending', date: new Date().toISOString() };
    all.unshift(report);
    localStorage.setItem(LOCAL_KEY, JSON.stringify(all));
    return report;
  }

  function _localUpdateStatus(id, status) {
    const all = _localGetAll();
    const idx = all.findIndex(r => r.id === id);
    if (idx === -1) return null;
    all[idx].status = status;
    all[idx].updatedAt = new Date().toISOString();
    if (status === 'resolved') all[idx].resolvedAt = new Date().toISOString();
    localStorage.setItem(LOCAL_KEY, JSON.stringify(all));
    return all[idx];
  }

  function _seedLocal() {
    if (localStorage.getItem(SEED_KEY)) return;
    const samples = [
      { id: 'RPT-SEED001', title: 'Flooded road along Marulas Road', type: 'road-flooding', severity: 'high', barangay: 'Brgy. Marulas', street: 'Marulas Road near Barangay Hall', description: 'Water level approximately waist-deep. Vehicles cannot pass. Residents wading through floodwater. Situation critical.', reporterName: 'Jose Reyes', reporterContact: '09171234567', anonymous: false, status: 'responding', date: new Date(Date.now() - 2 * 3600000).toISOString() },
      { id: 'RPT-SEED002', title: 'Blocked drainage at Purok 3', type: 'blocked-drainage', severity: 'medium', barangay: 'Brgy. Marulas', street: 'Purok 3, Near basketball court', description: 'Drainage clogged with debris. Water backing up into adjacent homes. Needs immediate clearing.', reporterName: 'Maria Santos', reporterContact: '09281234567', anonymous: false, status: 'pending', date: new Date(Date.now() - 5 * 3600000).toISOString() },
      { id: 'RPT-SEED003', title: 'CRITICAL — Evacuation needed near creek', type: 'evacuation-needed', severity: 'critical', barangay: 'Brgy. Marulas', street: 'Sitio Riverside, near Tullahan Creek', description: 'Water level rising rapidly. At least 20 families in danger. Elderly and children present. Immediate evacuation required.', reporterName: 'Pedro Cruz', reporterContact: '09391234567', anonymous: false, status: 'responding', date: new Date(Date.now() - 30 * 60000).toISOString() },
      { id: 'RPT-SEED004', title: 'House flooding — ground floor submerged', type: 'house-flooding', severity: 'high', barangay: 'Brgy. Marulas', street: 'Purok 4, near elementary school', description: 'Ground floor fully submerged. Family moved to second floor. Electrical lines may be exposed.', reporterName: 'Anonymous', reporterContact: '', anonymous: true, status: 'pending', date: new Date(Date.now() - 8 * 3600000).toISOString() },
      { id: 'RPT-SEED005', title: 'Rising water level at creek bridge', type: 'rising-water-level', severity: 'low', barangay: 'Brgy. Marulas', street: 'Marulas-Tullahan bridge area', description: 'Water level elevated but manageable. Monitoring ongoing.', reporterName: 'Liza Flores', reporterContact: '09451234567', anonymous: false, status: 'resolved', resolvedAt: new Date(Date.now() - 2 * 3600000).toISOString(), date: new Date(Date.now() - 24 * 3600000).toISOString() },
    ];
    localStorage.setItem(LOCAL_KEY, JSON.stringify(samples));
    localStorage.setItem(SEED_KEY, '1');
  }

  /* ----------------------------------------------------------
     PUBLIC API
     ---------------------------------------------------------- */
  return {
    init, subscribe, unsubscribe,
    Auth,
    getAll, getById, create,
    updateStatus, deleteReport,
    query, stats,
    purgeExpiredResolved,
    get isOnline() { return isSupabaseReady; },
  };
})();
