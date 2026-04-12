/* ============================================================
   config.js — External Database & App Configuration
   BaHALA Flood Early Warning System
   Brgy. Marulas, Valenzuela City

   SETUP INSTRUCTIONS:
   1. Go to https://supabase.com and create a free account
   2. Create a new project named "bahala-flood-system"
   3. Go to Settings → API and copy your URL and anon key
   4. Replace the placeholder values below
   5. Go to SQL Editor and run the schema in supabase-schema.sql
   ============================================================ */

const SUPABASE_CONFIG = {
  url:    'https://rapbpbwhbsisardqlrfr.supabase.co',   // ← Replace with your Supabase URL
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJhcGJwYndoYnNpc2FyZHFscmZyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU4MTM3MzMsImV4cCI6MjA5MTM4OTczM30.zSl7xvhKrZdewsEOGJl-MJUCXVTru-xGUGkCMzfwySg',                  // ← Replace with your anon/public key
};

/* ============================================================
   APP CONFIGURATION
   ============================================================ */
const APP_CONFIG = {
  name:       'BaHALA',
  fullName:   'Barangay Hazard & Alert Lifeline App',
  barangay:   'Brgy. Marulas',
  city:       'Valenzuela City',
  version:    '2.1.0',

  // Auto-delete resolved reports after this many hours
  resolvedDeleteAfterHours: 24,

  // Fallback admin email list (used if Supabase metadata role is not set).
  // For production: use Supabase metadata instead (see SQL schema below).
  adminUsers: ['admin@marulas.gov.ph', 'bdrrmc@marulas.gov.ph', 'captain@marulas.gov.ph'],

  // Brgy. Marulas center coordinates
  mapCenter: { lat: 14.6739, lng: 120.9858 },
  mapZoom: 15,

  // Hazard zones — add polygon coordinates here when available
  hazardZones: [],

  // Flood-prone zones in Brgy. Marulas (approximate)
  /*
  hazardZones: [
    {
      id: 'HZ-001',
      name: 'Marulas Creek Buffer Zone',
      level: 'critical',
      description: 'Adjacent to Tullahan River tributary. Highest flood risk area.',
      coordinates: [[14.7010, 120.9685], [14.7025, 120.9700], [14.7010, 120.9715], [14.6995, 120.9700]],
    },
    {
      id: 'HZ-002',
      name: 'Low-lying Residential Area (Purok 3-4)',
      level: 'high',
      description: 'Below-grade streets with poor drainage. Floods within 30 min of heavy rain.',
      coordinates: [[14.6995, 120.9690], [14.7005, 120.9700], [14.6995, 120.9710], [14.6985, 120.9700]],
    },
    {
      id: 'HZ-003',
      name: 'Commercial Strip (Marulas Road)',
      level: 'medium',
      description: 'Main road floods during monsoon season due to blocked drainage.',
      coordinates: [[14.6975, 120.9695], [14.6985, 120.9705], [14.6975, 120.9715], [14.6965, 120.9705]],
    },
    {
      id: 'HZ-004',
      name: 'School Zone Buffer',
      level: 'low',
      description: 'Occasional surface flooding. School grounds used as temporary retention.',
      coordinates: [[14.6980, 120.9680], [14.6990, 120.9690], [14.6980, 120.9700], [14.6970, 120.9690]],
    },
  ],
  */

  // Evacuation centers
  evacuationCenters: [
    { name: 'Valenzuela National High School', lat: 14.672562, lng: 120.984834, capacity: 500 },
    { name: 'Marulas Barangay Hall', lat: 14.67448,  lng: 120.98770, capacity: 200 }
  ],
};

/* ============================================================
   SUPABASE SQL SCHEMA
   Run this in your Supabase SQL Editor to set up the database:

   -- Reports table (run once to create)
   CREATE TABLE IF NOT EXISTS reports (
     id               TEXT PRIMARY KEY DEFAULT 'RPT-' || gen_random_uuid()::text,
     title            TEXT NOT NULL,
     type             TEXT NOT NULL,
     severity         TEXT NOT NULL CHECK (severity IN ('low','medium','high','critical')),
     barangay         TEXT NOT NULL,
     street           TEXT NOT NULL,
     description      TEXT,
     reporter_name    TEXT,
     reporter_contact TEXT,
     anonymous        BOOLEAN DEFAULT FALSE,
     image_url        TEXT,
     status           TEXT DEFAULT 'pending' CHECK (status IN ('pending','responding','resolved')),
     resolved_at      TIMESTAMPTZ,
     created_at       TIMESTAMPTZ DEFAULT now(),
     updated_at       TIMESTAMPTZ DEFAULT now()
   );

   -- Add image_url column if upgrading from v1 schema
   ALTER TABLE reports ADD COLUMN IF NOT EXISTS image_url TEXT;

   -- Enable Row Level Security
   ALTER TABLE reports ENABLE ROW LEVEL SECURITY;

   -- Anyone can read reports
   CREATE POLICY "Anyone can read reports"
     ON reports FOR SELECT USING (true);

   -- Anyone can insert reports
   CREATE POLICY "Anyone can submit reports"
     ON reports FOR INSERT WITH CHECK (true);

   -- Only authenticated admins can update/delete
   CREATE POLICY "Admins can update reports"
     ON reports FOR UPDATE USING (auth.email() = ANY(ARRAY['admin@marulas.gov.ph','bdrrmc@marulas.gov.ph','captain@marulas.gov.ph']));

   CREATE POLICY "Admins can delete reports"
     ON reports FOR DELETE USING (auth.email() = ANY(ARRAY['admin@marulas.gov.ph','bdrrmc@marulas.gov.ph','captain@marulas.gov.ph']));

   -- Auto-delete resolved reports after 24 hours (pg_cron job)
   -- Enable pg_cron extension in Supabase Dashboard → Extensions
   SELECT cron.schedule(
     'delete-resolved-reports',
     '0 * * * *',  -- Every hour
     $$DELETE FROM reports WHERE status = 'resolved' AND resolved_at < now() - interval '24 hours'$$
   );

   -- ============================================================
   -- HAZARD ZONES TABLE
   -- ============================================================
   CREATE TABLE IF NOT EXISTS hazard_zones (
     id               TEXT PRIMARY KEY DEFAULT 'HZ-' || gen_random_uuid()::text,
     name             TEXT NOT NULL,
     level            TEXT NOT NULL CHECK (level IN ('low','medium','high','critical')),
     description      TEXT,
     coordinates      JSONB NOT NULL,
     created_by       TEXT,
     created_at       TIMESTAMPTZ DEFAULT now()
   );

   ALTER TABLE hazard_zones ENABLE ROW LEVEL SECURITY;
   CREATE POLICY "Anyone can read hazard zones" ON hazard_zones FOR SELECT USING (true);
   CREATE POLICY "Admins can insert hazard zones" ON hazard_zones FOR INSERT WITH CHECK (
     auth.email() = ANY(ARRAY['admin@marulas.gov.ph','bdrrmc@marulas.gov.ph','captain@marulas.gov.ph']) OR
     (auth.jwt() ->> 'role') = 'admin'
   );
   CREATE POLICY "Admins can delete hazard zones" ON hazard_zones FOR DELETE USING (
     auth.email() = ANY(ARRAY['admin@marulas.gov.ph','bdrrmc@marulas.gov.ph','captain@marulas.gov.ph']) OR
     (auth.jwt() ->> 'role') = 'admin'
   );

   -- Enable real-time on reports and hazard_zones tables
   ALTER PUBLICATION supabase_realtime ADD TABLE reports;
   ALTER PUBLICATION supabase_realtime ADD TABLE hazard_zones;

   -- ============================================================
   -- SUPABASE STORAGE — Report Images
   -- Run in SQL Editor to create the storage bucket:
   -- ============================================================
   INSERT INTO storage.buckets (id, name, public)
   VALUES ('report-images', 'report-images', true)
   ON CONFLICT DO NOTHING;

   -- Allow authenticated users to upload images
   CREATE POLICY "Auth users can upload report images"
     ON storage.objects FOR INSERT
     WITH CHECK (bucket_id = 'report-images' AND auth.role() = 'authenticated');

   -- Allow anyone to view report images
   CREATE POLICY "Anyone can view report images"
     ON storage.objects FOR SELECT
     USING (bucket_id = 'report-images');

   -- ============================================================
   -- SECURE ADMIN ROLES via Supabase User Metadata
   -- Run this after creating admin accounts to assign secure roles:
   -- ============================================================
   UPDATE auth.users
   SET raw_user_meta_data = raw_user_meta_data || '{"role":"admin"}'
   WHERE email IN ('admin@marulas.gov.ph', 'bdrrmc@marulas.gov.ph', 'captain@marulas.gov.ph');

   -- To assign admin role to a NEW user:
   -- UPDATE auth.users SET raw_user_meta_data = raw_user_meta_data || '{"role":"admin"}' WHERE email = 'newadmin@marulas.gov.ph';

   ============================================================ */

// Export for use in app
if (typeof module !== 'undefined') {
  module.exports = { SUPABASE_CONFIG, APP_CONFIG };
}
