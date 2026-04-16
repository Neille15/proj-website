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
      .channel('db-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reports' },
        (payload) => {
          console.log('[DB] Real-time change (reports):', payload.eventType);
          callback({ table: 'reports', ...payload });
        })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hazard_zones' },
        (payload) => {
          console.log('[DB] Real-time change (zones):', payload.eventType);
          callback({ table: 'hazard_zones', ...payload });
        })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'news_items' },
        (payload) => {
          console.log('[DB] Real-time change (news):', payload.eventType);
          callback({ table: 'news_items', ...payload });
        })
      .subscribe();
  }

  function unsubscribe() {
    if (realtimeChannel) supabase.removeChannel(realtimeChannel);
  }

  /* ----------------------------------------------------------
     PASSWORD STRENGTH CHECKER
     Returns: { score: 0-4, label: string, color: string }
     ---------------------------------------------------------- */
  function checkPasswordStrength(password) {
    let score = 0;
    if (!password) return { score: 0, label: '', bars: [] };
    if (password.length >= 8)  score++;
    if (/[A-Z]/.test(password)) score++;
    if (/[0-9]/.test(password)) score++;
    if (/[^A-Za-z0-9]/.test(password)) score++;

    const labels = ['', 'Weak', 'Fair', 'Good', 'Strong'];
    const classes = ['', 'weak', 'fair', 'good', 'good'];
    return {
      score,
      label: labels[score] || '',
      cls: classes[score] || '',
    };
  }

  /* ----------------------------------------------------------
     IMAGE COMPRESSION — canvas resize before upload/store
     Reduces a 3MB photo to ~150-300KB before uploading
     ---------------------------------------------------------- */
  function _compressImage(file, maxDim = 1200, quality = 0.82) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width >= height) { height = Math.round(height * maxDim / width); width = maxDim; }
          else { width = Math.round(width * maxDim / height); height = maxDim; }
        }
        const canvas = document.createElement('canvas');
        canvas.width  = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => blob ? resolve(blob) : reject(new Error('Canvas compression failed')),
          'image/jpeg',
          quality,
        );
      };
      img.onerror = reject;
      img.src = url;
    });
  }

  /* ----------------------------------------------------------
     IMAGE UPLOAD — Supabase Storage (with compression)
     ---------------------------------------------------------- */
  async function uploadImage(file, onProgress) {
    if (!file) return null;
    if (file.size > 20 * 1024 * 1024) throw new Error('Image must be under 20MB.');

    // Step 1: Compress the image client-side
    let uploadFile = file;
    try {
      if (onProgress) onProgress(10);
      const compressed = await _compressImage(file);
      uploadFile = new File([compressed], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' });
      console.log(`[IMG] Compressed ${(file.size/1024).toFixed(0)}KB → ${(uploadFile.size/1024).toFixed(0)}KB`);
    } catch (e) {
      console.warn('[IMG] Compression failed, using original:', e.message);
    }

    if (onProgress) onProgress(30);

    // Step 2a: Supabase Storage upload
    if (isSupabaseReady) {
      const name = `report-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
      const { data, error } = await supabase.storage
        .from('report-images')
        .upload(name, uploadFile, { contentType: 'image/jpeg', upsert: false });

      if (error) {
        // Bucket not set up yet — fall through to base64 fallback
        console.warn('[IMG] Supabase Storage error (bucket may not exist):', error.message);
        // Fall through to base64 below
      } else {
        if (onProgress) onProgress(100);
        const { data: urlData } = supabase.storage.from('report-images').getPublicUrl(name);
        return urlData.publicUrl;
      }
    }

    // Step 2b: localStorage fallback — store compressed base64
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        if (onProgress) onProgress(100);
        resolve(e.target.result); // compressed jpeg base64
      };
      reader.onerror = reject;
      reader.readAsDataURL(uploadFile);
    });
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
      // Check Supabase user metadata role first (secure), then fallback to email list
      if (user.user_metadata?.role === 'admin') return true;
      if (user.role === 'admin') return true; // local mock
      return APP_CONFIG.adminUsers.includes(user.email);
    },

    async signUp(email, password, name) {
      // Validate password strength before sending
      const strength = checkPasswordStrength(password);
      if (strength.score < 2) throw new Error('Password is too weak. Use at least 8 characters with numbers or symbols.');

      if (!isSupabaseReady) throw new Error('Sign-up requires a Supabase connection. Please configure Supabase in config.js.');

      const { data, error } = await supabase.auth.signUp({
        email, password,
        options: {
          data: { full_name: name, role: 'resident' },
          // Supabase will send a verification email automatically when
          // "Confirm email" is enabled in Dashboard → Auth → Settings
        },
      });
      if (error) throw error;
      return data;
    },

    isEmailVerified(user) {
      if (!user) return false;
      // Supabase sets email_confirmed_at when the user clicks the verification link
      return !!(user.email_confirmed_at || user.confirmed_at);
    },

    async resendVerification(email) {
      if (!isSupabaseReady) throw new Error('Requires Supabase connection.');
      const { error } = await supabase.auth.resend({ type: 'signup', email });
      if (error) throw error;
    },

    /* Update display name */
    async updateName(newName) {
      if (!newName || newName.trim().length < 2) throw new Error('Name must be at least 2 characters.');
      if (isSupabaseReady) {
        const { data, error } = await supabase.auth.updateUser({
          data: { full_name: newName.trim() },
        });
        if (error) throw error;
        return data.user;
      }
      // Update local mock
      const local = JSON.parse(localStorage.getItem('bahala_local_user') || 'null');
      if (!local) throw new Error('Not signed in.');
      local.user_metadata = { ...(local.user_metadata || {}), full_name: newName.trim() };
      localStorage.setItem('bahala_local_user', JSON.stringify(local));
      return local;
    },

    /* Change password — requires current session (Supabase re-auth not needed; uses JWT) */
    async updatePassword(currentPassword, newPassword) {
      if (!isSupabaseReady) throw new Error('Password change requires Supabase connection.');
      const strength = checkPasswordStrength(newPassword);
      if (strength.score < 2) throw new Error('New password is too weak. Use at least 8 characters with numbers or symbols.');
      if (currentPassword === newPassword) throw new Error('New password must be different from current password.');

      // Supabase requires re-authentication by signing in again
      const user = await this.getUser();
      if (!user) throw new Error('Not signed in.');

      // Verify current password by attempting sign-in
      const { error: reAuthErr } = await supabase.auth.signInWithPassword({
        email: user.email,
        password: currentPassword,
      });
      if (reAuthErr) throw new Error('Current password is incorrect.');

      const { data, error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
      return data;
    },
  };

  function _localAuth(email, password) {
    // Demo local auth — only used when Supabase is not configured
    const demoUsers = [
      { email: 'admin@marulas.gov.ph',   password: 'admin123',    role: 'admin',    name: 'Barangay Admin' },
      { email: 'bdrrmc@marulas.gov.ph',  password: 'bdrrmc123',   role: 'admin',    name: 'BDRRMC Officer' },
      { email: 'captain@marulas.gov.ph', password: 'captain123',  role: 'admin',    name: 'Barangay Captain' },
      { email: 'resident@marulas.com',   password: 'resident123', role: 'resident', name: 'Juan dela Cruz' },
    ];
    const user = demoUsers.find(u => u.email === email && u.password === password);
    if (!user) throw new Error('Invalid email or password.');
    const session = {
      email: user.email,
      user_metadata: { full_name: user.name, role: user.role },
      role: user.role,
    };
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
      image_url:        reportData.imageUrl || null,
      status:           'pending',
      lat:              reportData.lat !== undefined ? reportData.lat : null,
      lng:              reportData.lng !== undefined ? reportData.lng : null,
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
    const q = search.trim().toLowerCase();
    return all.filter(r => {
      if (severity !== 'all' && r.severity !== severity) return false;
      if (status   !== 'all' && r.status   !== status)   return false;
      if (q) {
        const haystack = [
          r.title, r.barangay, r.street,
          r.description, r.reporterName, r.type,
        ].join(' ').toLowerCase();
        if (!haystack.includes(q)) return false;
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
     AUTO-DELETE RESOLVED REPORTS after 24h
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
     HAZARD ZONES
     ---------------------------------------------------------- */
  async function getZones() {
    if (isSupabaseReady) {
      const { data, error } = await supabase.from('hazard_zones').select('*');
      if (error) {
        if (error.code === '42P01') return APP_CONFIG.hazardZones || []; // table missing, fallback
        throw error;
      }
      return data;
    }
    const local = localStorage.getItem('bahala_zones_v3');
    return local ? JSON.parse(local) : (APP_CONFIG.hazardZones || []);
  }

  async function createZone(zoneData) {
    const payload = {
      name: zoneData.name,
      level: zoneData.level,
      description: zoneData.description,
      coordinates: zoneData.coordinates,
      created_by: (await Auth.getUser())?.email || 'Local Admin',
    };

    if (isSupabaseReady) {
      const { data, error } = await supabase.from('hazard_zones').insert(payload).select().single();
      if (error) throw error;
      return data;
    }
    const all = await getZones();
    const newZone = { id: 'HZ-' + Date.now().toString(36).toUpperCase(), ...payload, created_at: new Date().toISOString() };
    all.push(newZone);
    localStorage.setItem('bahala_zones_v3', JSON.stringify(all));
    return newZone;
  }

  async function deleteZone(id) {
    if (isSupabaseReady) {
      const { error } = await supabase.from('hazard_zones').delete().eq('id', id);
      if (error) throw error;
    } else {
      const all = await getZones();
      const filtered = all.filter(z => z.id !== id);
      localStorage.setItem('bahala_zones_v3', JSON.stringify(filtered));
    }
  }

  async function updateZone(id, zoneData) {
    if (isSupabaseReady) {
      const { data, error } = await supabase.from('hazard_zones').update(zoneData).eq('id', id).select().maybeSingle();
      if (error) throw error;
      if (!data) throw new Error('Zone not found or update failed (check permissions).');
      return data;
    }
    const all = await getZones();
    const idx = all.findIndex(z => z.id === id);
    if (idx === -1) throw new Error('Zone not found');
    all[idx] = { ...all[idx], ...zoneData, updated_at: new Date().toISOString() };
    localStorage.setItem('bahala_zones_v3', JSON.stringify(all));
    return all[idx];
  }

  /* ----------------------------------------------------------
     NEWS ITEMS (Plans & Activities)
     ---------------------------------------------------------- */
  async function getNews() {
    if (isSupabaseReady) {
      const { data, error } = await supabase
        .from('news_items')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) {
        if (error.code === '42P01') return _localGetNews();
        throw error;
      }
      return data;
    }
    return _localGetNews();
  }

  async function createNews(newsData) {
    const payload = {
      title: newsData.title,
      content: newsData.content,
      tag: newsData.tag, // 'plan', 'activity', 'alert', etc.
      source: newsData.source || null,
      date_label: newsData.dateLabel || null,
      is_featured: newsData.isFeatured || false,
      created_by: (await Auth.getUser())?.email || 'Local Admin',
    };

    if (isSupabaseReady) {
      const { data, error } = await supabase.from('news_items').insert(payload).select().single();
      if (error) throw error;
      return data;
    }
    const all = _localGetNews();
    const newItem = { id: 'NW-' + Date.now().toString(36).toUpperCase(), ...payload, created_at: new Date().toISOString() };
    all.unshift(newItem);
    localStorage.setItem('bahala_news_v3', JSON.stringify(all));
    return newItem;
  }

  async function updateNews(id, newsData) {
    const payload = {
      ...newsData,
      updated_at: new Date().toISOString()
    };
    if (isSupabaseReady) {
      const { data, error } = await supabase.from('news_items').update(payload).eq('id', id).select().maybeSingle();
      if (error) throw error;
      return data;
    }
    const all = _localGetNews();
    const idx = all.findIndex(n => n.id === id);
    if (idx === -1) throw new Error('News item not found');
    all[idx] = { ...all[idx], ...payload };
    localStorage.setItem('bahala_news_v3', JSON.stringify(all));
    return all[idx];
  }

  async function deleteNews(id) {
    if (isSupabaseReady) {
      const { error } = await supabase.from('news_items').delete().eq('id', id);
      if (error) throw error;
    } else {
      const all = _localGetNews();
      const filtered = all.filter(n => n.id !== id);
      localStorage.setItem('bahala_news_v3', JSON.stringify(filtered));
    }
  }

  function _localGetNews() {
    try {
      const local = localStorage.getItem('bahala_news_v3');
      if (local) return JSON.parse(local);
      return [];
    } catch { return []; }
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
      imageUrl:        r.image_url || r.imageUrl || null,
      status:          r.status,
      lat:             r.lat !== undefined ? r.lat : null,
      lng:             r.lng !== undefined ? r.lng : null,
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
    // Try saving — if localStorage quota is exceeded, save without the image
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(all));
    } catch (e) {
      if (e.name === 'QuotaExceededError' || e.code === 22) {
        console.warn('[DB] localStorage quota exceeded — saving report without image.');
        report.imageUrl = null;
        all[0].imageUrl = null;
        try {
          localStorage.setItem(LOCAL_KEY, JSON.stringify(all));
        } catch (e2) {
          // Even without image it's too full — trim old resolved reports
          const trimmed = all.filter(r => r.status !== 'resolved').concat(
            all.filter(r => r.status === 'resolved').slice(0, 5)
          );
          trimmed[0] = { ...report, imageUrl: null };
          localStorage.setItem(LOCAL_KEY, JSON.stringify(trimmed));
        }
      } else {
        throw e;
      }
    }
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
      { id: 'RPT-SEED001', title: 'Flooded road along Marulas Road', type: 'road-flooding', severity: 'high', barangay: 'Brgy. Marulas', street: 'Marulas Road near Barangay Hall', description: 'Water level approximately waist-deep. Vehicles cannot pass. Residents wading through floodwater.', reporterName: 'Jose Reyes', reporterContact: '09171234567', anonymous: false, status: 'responding', imageUrl: null, date: new Date(Date.now() - 2 * 3600000).toISOString() },
      { id: 'RPT-SEED002', title: 'Blocked drainage at Purok 3', type: 'blocked-drainage', severity: 'medium', barangay: 'Brgy. Marulas', street: 'Purok 3, Near basketball court', description: 'Drainage clogged with debris. Water backing up into adjacent homes.', reporterName: 'Maria Santos', reporterContact: '09281234567', anonymous: false, status: 'pending', imageUrl: null, date: new Date(Date.now() - 5 * 3600000).toISOString() },
      { id: 'RPT-SEED003', title: 'CRITICAL — Evacuation needed near creek', type: 'evacuation-needed', severity: 'critical', barangay: 'Brgy. Marulas', street: 'Sitio Riverside, near Tullahan Creek', description: 'Water level rising rapidly. At least 20 families in danger. Immediate evacuation required.', reporterName: 'Pedro Cruz', reporterContact: '09391234567', anonymous: false, status: 'responding', imageUrl: null, date: new Date(Date.now() - 30 * 60000).toISOString() },
      { id: 'RPT-SEED004', title: 'House flooding — ground floor submerged', type: 'house-flooding', severity: 'high', barangay: 'Brgy. Marulas', street: 'Purok 4, near elementary school', description: 'Ground floor fully submerged. Family moved to second floor. Electrical lines may be exposed.', reporterName: 'Anonymous', reporterContact: '', anonymous: true, status: 'pending', imageUrl: null, date: new Date(Date.now() - 8 * 3600000).toISOString() },
      { id: 'RPT-SEED005', title: 'Rising water level at creek bridge', type: 'rising-water-level', severity: 'low', barangay: 'Brgy. Marulas', street: 'Marulas-Tullahan bridge area', description: 'Water level elevated but manageable. Monitoring ongoing.', reporterName: 'Liza Flores', reporterContact: '09451234567', anonymous: false, status: 'resolved', resolvedAt: new Date(Date.now() - 2 * 3600000).toISOString(), imageUrl: null, date: new Date(Date.now() - 24 * 3600000).toISOString() },
    ];
    localStorage.setItem(LOCAL_KEY, JSON.stringify(samples));
    
    const newsSamples = [
      { id: 'NW-SEED001', title: '2024–2026 Barangay Flood Resilience Program', content: 'Brgy. Marulas has adopted a 3-year flood resilience roadmap aligned with Valenzuela City\'s Comprehensive Land Use Plan. Key measures include the desilting of Tullahan River tributaries, elevation of critical roads along Marulas Road, and construction of 1.2 km of concrete drainage channels co-funded by the DPWH and City Government under the Valenzuela Urban Flood Resilience Initiative.', tag: 'plan', source: 'Barangay Resolution No. 2024-07', date_label: 'March 2024', is_featured: true, created_at: new Date().toISOString() },
      { id: 'NW-SEED002', title: 'Annual Drainage Cleaning Drive (Brigada Kalikasan)', content: 'Every June before the monsoon season, residents join the Brigada Kalikasan — a barangay-wide drainage and creek cleaning drive. In 2024, over 400 volunteers participated, clearing 3.5 tons of solid waste from Marulas\' drainage network and improving canal flow by an estimated 60%.', tag: 'activity', source: 'Brgy. Marulas Environment Committee', date_label: 'June 2024', is_featured: false, created_at: new Date().toISOString() },
      { id: 'NW-SEED003', title: 'Tullahan River Flood Sensors Now Operational', content: 'The DOST-PAGASA and Valenzuela DRRMO jointly installed water level sensors along the Tullahan River near Marulas. Residents receive SMS alerts when water reaches Warning (1.5m), Critical (2.0m), and Danger (2.5m) thresholds — giving households up to 2 hours of advance warning before flooding.', tag: 'alert', source: 'Valenzuela City DRRMO', date_label: 'August 2024', is_featured: false, created_at: new Date().toISOString() },
    ];
    localStorage.setItem('bahala_news_v3', JSON.stringify(newsSamples));

    localStorage.setItem(SEED_KEY, '1');
  }

  /* ----------------------------------------------------------
     PUBLIC API
     ---------------------------------------------------------- */
  return {
    init, subscribe, unsubscribe,
    Auth,
    uploadImage,
    checkPasswordStrength,
    getAll, getById, create,
    updateStatus, deleteReport,
    query, stats,
    getZones, createZone, updateZone, deleteZone,
    getNews, createNews, updateNews, deleteNews,
    purgeExpiredResolved,
    get isOnline() { return isSupabaseReady; },
  };
})();
