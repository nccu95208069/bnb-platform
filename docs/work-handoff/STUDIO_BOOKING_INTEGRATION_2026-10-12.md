# Studio booking integration — 2026-10-12

The private Stayform Studio connects each website project to a separate Sweetfun OS binding. OS remains authoritative for inventory, prices, orders, payments and notification jobs. A website does not take bookings until an owner approves its connection, the team publishes a confirmed website version, and website sales are explicitly enabled.

## Owner entry

`/w/[slug]/website?property=[propertyId]` presents calendar, pending holds, orders and finance with the existing role/property authorization. Owners can inspect website room mappings and policies, and pause/resume that binding. Staff without price permission do not receive the owner management data. Existing calendars, orders and finance pages remain the operational tools.

New approval stores the workspace's binding index atomically. Legacy bindings appear in this new index after reapproval. No existing binding is silently migrated. Reapproval retains owner-managed base prices, overrides, disabled pricing and paused sales. Physical mapping changes continue to require the existing controlled procedure.

## Configuration and rollout

Existing `WEBSITE_BOOKING_CLIENTS` and `WEBSITE_BOOKING_EMAIL_SITE_SCOPES` remain untouched. Optional `WEBSITE_BOOKING_STUDIO_CLIENTS` and `WEBSITE_BOOKING_STUDIO_EMAIL_SITE_SCOPES` extend those validated registries with explicit site IDs only. Combined duplicate IDs, token hashes, duplicate email scopes, malformed values and overall limits fail closed. No wildcard permissions or automatic tenant provisioning are added.

The guest Site uses a separate server-only `OS_STUDIO_EDITOR_TOKEN` for standard Studio websites. Legacy Happy House still uses its existing editor token and binding. New grants require an authorized operator and a redeploy to apply production environment changes. Notifications remain opt-in through exact client/site pairs and existing delivery flags.

Two private Studio starter links use `?booking-test=a` and `?booking-test=b`. They load synthetic editable drafts and reuse saved drafts when present; opening a link does not create a property, publish a website or enable sales. Their project IDs are `61391aa1-58d9-4b18-b57f-d0695d59523f` and `99779fdc-a0aa-4fc4-bf52-8da2a3a36eac` under the existing guest Site's `:studio:` scope. No real accommodation records or payments are used.

Guest hosting adds a D1 `site_registry` through its tracked migration. Private R2 setup snapshots and binding credentials are server-only. Immutable content revisions remain readable; a CAS-protected `/sites/{project}/live/` pointer selects current content. Every revision uses the current approved booking configuration; paused websites retain original request-key lookup. The public Happy House record is unchanged.

## Validation and review

124 OS tests pass, including HTTP and real local Redis concurrency checks, owner role authorization, scoped management, existing booking lifecycle, exact registry separation and React owner UI. The cross-system suite adds 13 scenarios using the actual main Worker, guest Worker and Next HTTP handlers with isolated storage and synthetic mail. It verifies two properties, last-room contention, whole-house overlap, double-clicks, lost responses, resumed activation, owner deposit confirmation, paused lookups, current policies, immutable versions and email scope isolation.

Additional Studio and guest checks pass: 27 backend, 9 UI, 10 public website, 25 existing operations, 4 legacy OS transport. Total: 212 checks. The Next production build passed before the final registry additions; the staged cloud build is the release build validation for the final source.

Self code review repaired owner price overwrite on reapproval, silent reopening of paused bindings, cross-project stale UI results, lost activation response recovery, version publishing click-handler collision, and mobile booking detail grid leakage. No known critical issue remains in the checked source. No external notification was sent by verification; physical LINE in-app browser and owner login/real email delivery remain user acceptance steps.

## User acceptance

Save test A/B drafts; confirm synthetic facts; enter the owner's actual login email and synthetic transfer/cancellation text; submit the connection and approve through the owner's OS account. Return to Studio to refresh status. Publish the website and explicitly open bookings. Place one test hold, confirm its deposit in OS, and check the same public order. Verify the second test property remains independent. Pause sales and confirm existing lookup still works. Do not record real transfers for synthetic test orders.
