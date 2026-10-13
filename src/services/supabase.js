import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
      },
      realtime: {
        params: { eventsPerSecond: 10 },
      },
    })
  : null

export function requireSupabase() {
  if (!supabase) {
    throw new Error('Connect a Supabase project by setting VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.local.')
  }
  return supabase
}
