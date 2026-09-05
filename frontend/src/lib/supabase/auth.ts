import { supabase } from "./client";

export async function signInWithEmail(email: string, password: string) {
  return supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
}

export async function signUpWithEmail(email: string, password: string) {
  return supabase.auth.signUp({
    email: email.trim().toLowerCase(),
    password,
    options: {
      emailRedirectTo:
        typeof window === "undefined" ? undefined : `${window.location.origin}/calendar`,
    },
  });
}

export async function requestPhoneOtp(phone: string) {
  return supabase.auth.signInWithOtp({ phone: phone.trim() });
}

export async function verifyPhoneOtp(phone: string, token: string) {
  return supabase.auth.verifyOtp({
    phone: phone.trim(),
    token: token.trim(),
    type: "sms",
  });
}

export async function signOut() {
  return supabase.auth.signOut();
}

export async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
