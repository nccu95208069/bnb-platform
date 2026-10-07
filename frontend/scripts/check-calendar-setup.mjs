// Offline diagnostics only: no provider calls, mail, storage access or writes.
import { pathToFileURL } from "node:url";
import { calendarGoogleConfig } from "../src/lib/customer-workspaces/calendar-google.ts";
import { customerOrigin } from "../src/lib/customer-workspaces/site-url.ts";
import { enabled } from "../src/lib/customer-workspaces/auth.ts";
import {
  intakeEnabled,
  onboardingEnabled,
} from "../src/lib/customer-intake/config.ts";

export function checkCalendarSetup(origin) {
  const checks = [];
  const check = (name, test) => {
    let pass = false;
    try {
      pass = test() === true;
    } catch {
      // Never print environment values, provider responses or error messages.
    }
    checks.push({ name, pass });
  };
  const expected = /^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin ?? "")
    ? origin
    : null;
  check("explicit_https_vercel_origin", () => Boolean(expected));
  check(
    "workspace_and_onboarding_enabled",
    () => enabled() && intakeEnabled() && onboardingEnabled(),
  );
  check("google_oauth_and_encryption_configured", () => {
    calendarGoogleConfig();
    return true;
  });
  check(
    "google_callback_matches_entry_origin",
    () =>
      Boolean(expected) &&
      calendarGoogleConfig().redirectUri ===
        `${expected}/api/customer-calendar/callback`,
  );
  check(
    "email_links_match_entry_origin",
    () => Boolean(expected) && customerOrigin() === expected,
  );
  check("storage_configured_not_connected", () => {
    const url =
      process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
    const token =
      process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
    return Boolean(url && token) && new URL(url).protocol === "https:";
  });
  check(
    "continuous_sync_disabled_for_initial_acceptance",
    () => process.env.CUSTOMER_CALENDAR_SYNC_ENABLED !== "true",
  );
  return {
    configured: checks.every((item) => item.pass),
    liveAcceptanceVerified: false,
    checks,
    pending: [
      "Google project, Calendar API, consent screen, test users and registered callback",
      "Verified ownership and protection of the fixed alias",
      "Approved isolated storage and separately authorized test mail recipients",
      "Real consent, cancellation, refresh, revocation and mobile return",
    ],
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const report = checkCalendarSetup(process.argv[2]);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.configured ? 0 : 1;
}
