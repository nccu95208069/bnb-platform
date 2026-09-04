import { createClient } from "@supabase/supabase-js";

const configuredUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const configuredAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(configuredUrl && configuredAnonKey);

// Keep module evaluation safe during preview deployments. AuthGuard bypasses
// Supabase entirely when the real public configuration is not available.
const supabaseUrl = configuredUrl || "https://preview-placeholder.supabase.co";
const supabaseAnonKey = configuredAnonKey || "preview-anon-key";

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
