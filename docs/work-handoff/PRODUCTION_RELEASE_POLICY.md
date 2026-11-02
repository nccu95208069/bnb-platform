# Production source integration and release policy

Owner decision, 2026-11-02: integrate the verified calendar recovery and renewal
work into `main`, retire the old automatic deployment path, and preserve the
current production features. This supersedes the historical demo-only CD policy.

## Source baseline and conflict resolution

- Previous main: `4dd5694` (2026-09-07).
- Accepted recovery source: `acb48f8`, including merged renewal PR #128.
- Existing production: `dpl_Rsnf6hgkJ6wUHirhG44z9Zny2fGz` on `sweetfun-os`.
- The integration retains all recovered production frontend files. Comparing the
  accepted live-source export found 804 identical files, no missing files, and
  only `vercel.json` plus `src/lib/api-client.ts` changed before release guards.
- Main's competitor-radar routes, implementation and documentation are retained.
  Its API client routing is additive only for `/competitor-radar/`; all other
  paths retain the deployed API base. The sidebar conflict resolves to the
  current production navigation, including finance scopes, i18n, customer
  workspaces, device-cache logout and mobile calendar behavior. The old sidebar
  is not restored and the legacy radar route is not newly activated in navigation.
- Integrating source does not publish backend migrations or switch runtime code.
  The existing frontend and Iron Gate production releases remain separate units.

## Retired deployment paths

The old `.github/workflows/cd.yml` ran on every main push, supplied demo mode and
placeholder Supabase settings, and assigned the production domain immediately.
It could replace the private operational calendar with an anonymized demo.

Before integration, the GitHub workflow was set to `disabled_manually` and no
in-progress runs were present. Its replacement is a manual-only instruction job:
no credentials, external actions, build or deployment commands. Even manually
re-enabling the workflow cannot publish production.

`frontend/vercel.json` sets `git.deploymentEnabled: false`, as documented in
[Vercel Git configuration](https://vercel.com/docs/project-configuration/git-configuration).
At preflight, the actual `sweetfuns-projects/sweetfun-os` project had no Git link.
The live project, environment variables, aliases, cron configuration and protection
settings were not changed by this integration.

The removed Railway comment was historical, not verified live infrastructure.
The authenticated owner's Railway dashboard listed only the unrelated iamsafe
project; the previously recorded bnb-platform project returned 404 after login.
No Railway service was recreated, changed or deployed. GitHub listed no repository
webhooks. Do not infer an active backend release path from an old comment.

## CI enforcement

CI continues to run frontend lint/build, backend lint/format/tests, Iron Gate
checks/tests and tenant/calendar/finance regressions. It also explicitly runs the
recovered device-cache and cloud-renewal identity regressions.

`python scripts/check_release_policy.py` checks that Git builds remain disabled,
that the retired CD has no push trigger, and that repository workflows do not
contain production CLI flags, deployment actions or the old Vercel token wiring.
Negative tests replay a renamed demo publisher, a restored push trigger, a manual
external deploy command and re-enabled Git builds. Changing release policy must be
an intentional reviewed change; this guard is not a substitute for code review.

## Future application releases

1. Start from an exact reviewed and tested commit that includes current `main`.
   Compare it with the actual live source and preserve any newer live changes.
2. Verify the Vercel team `sweetfuns-projects`, project `sweetfun-os` and production
   alias before using credentials. Export only tracked frontend files; do not
   upload local environment files, private evidence, `.git` or credential files.
3. Retain the real production environment. Never add demo flags or placeholder
   values to a production deployment, and never decrypt all environment values.
4. Stage a production candidate without assigning the domain (`--prod
   --skip-domain`, or the equivalent authenticated API operation). Verify build,
   authentication, property isolation and the affected read flows on that candidate.
5. Under the owner's release authorization, promote the verified candidate,
   verify the actual alias, repeat read-only acceptance, and record the exact
   commit/deployment and recovery target. A merge alone is not a deployment.
6. Preserve the current deployment if candidate verification fails. Rollback must
   use a known compatible deployment and must not remove newer booking/finance
   guards. Backend/consumer updates require their own compatibility checks.

## Automatic credential renewal remains independent

The existing Cloud Run renewal job still checks daily at 09:00 Asia/Taipei.
It recreates the actual live frontend source for equivalent-scope credential
renewal, verifies its consumer, then promotes it. It does not deploy GitHub main.
The `git.deploymentEnabled` option controls Git events, not this authorized API
renewal. Keep its scoped identity probe, production configuration and recovery
journal intact. Gmail renewal is managed by its separate repository and service.

Final merge SHAs, CI results and post-merge runtime acceptance belong to the
integration PR. Historical recovery/deployment records remain timestamped history.
