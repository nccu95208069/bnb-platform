import { normalizeTaiwanPhone } from "@/lib/access-control";

import { supabase } from "./client";

export async function signInWithEmail(email: string, password: string) {
  return supabase.auth.signInWithPassword({ email, password });
}

export async function sendEmailSignIn(email: string) {
  const redirectTo =
    typeof window === "undefined" ? undefined : `${window.location.origin}/calendar`;
  return supabase.auth.signInWithOtp({
    email: email.trim().toLowerCase(),
    options: {
      shouldCreateUser: true,
      emailRedirectTo: redirectTo,
    },
  });
}

export async function sendPhoneSignIn(phone: string) {
  return supabase.auth.signInWithOtp({
    phone: normalizeTaiwanPhone(phone),
    options: { shouldCreateUser: true },
  });
}

export async function verifyPhoneSignIn(phone: string, token: string) {
  return supabase.auth.verifyOtp({
    phone: normalizeTaiwanPhone(phone),
    token: token.trim(),
    type: "sms",
  });
}

export async function claimWorkspaceMembership() {
  return supabase.rpc("claim_workspace_membership");
}

export async function signOut() {
  return supabase.auth.signOut();
}

export async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
