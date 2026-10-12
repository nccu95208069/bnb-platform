# BETA self-service OS admission — 2026-10-12

The v1 target is a public website entry where each owner signs in during the
flow, prepares a site, reviews their own physical rooms and calendar, and
authorizes the OS connection. PM does **not** need the owner's email in advance,
precreate an OS account, or maintain an allowlist of pilot people. Content
publication, OS connection approval and live sales are separate decisions.

## What draft PR #36 already supports

- A trusted Studio server credential can opt in to new lowercase UUID-v4 site
  IDs. The browser cannot call the service route with an OS credential. A new
  site request lasts one hour and has no binding token until owner approval.
  The opt-in is not configured in production; legacy exact-site grants remain.
- Studio includes the intended `ownerEmail` in its server-side prepare request.
  That email can be collected from the owner **during** setup; it is not a PM
  preregistration list. The OS approval page sends a browser-bound email login
  link. Consuming it can create a passwordless OS account for an email that did
  not previously exist. The new test in `website-login.test.mjs` verifies that
  unregistered-owner path through owner review, calendar creation and a
  sales-disabled binding.
- OS shows the site UUID and Studio origin, requires a verified matching email
  and explicit review of room counts, dates, prices and rules. The owner can
  create a new native workspace/property or select an eligible property they
  own and map each offered type to OS physical-room IDs. CAS/version and
  idempotency protect retries. New bindings start `salesEnabled:false`.
- Sheet, Google Calendar and ICS onboarding are already deployed; Excel/CSV
  file intake in this PR uses the same owner/property-scoped preview, mapping,
  confirmation and deduplication path. This is not yet two-real-owner acceptance.
- This branch now permits a **confirmed file-backed ICS calendar in migration
  mode** to share inventory with an approved website binding. The complete
  source interval must cover every advertised night through checkout. Existing
  imported bookings and blocks participate in the same room-night conflict
  check. Any pending review, shortened coverage or conversion to connected
  mode makes website bootstrap unavailable; sales activation also refuses it.
  The owner still has to enable sales as a separate action.
- A Sheet, CSV or Excel import can also share OS inventory after the owner
  confirms its exclusive end date and the complete source interval covers the
  website's advertised nights. Sold nights use the same physical-room conflict
  check. Unresolved rows, mixed sources, an unconfirmed or shortened interval,
  and undo of imported inventory close website readiness. The sales switch
  shows the source interval and requires a separate acknowledgement that a
  static file does not update itself or other channels.
- The owner management page reports effective sale readiness separately from
  the saved sales switch. If coverage is revoked, a connected read-only
  calendar replaces the file, room mapping/owner access is lost, pricing is
  disabled or the website/hold feature is off, it shows new reservations as
  paused rather than displaying the old switch as available. Sales activation
  checks the same gates; pausing remains possible during a feature outage.

## Gaps before a public self-service booking journey

1. **Studio identity and email handoff.** The website is moving to public
   owner ChatGPT sign-in. OS does not receive a verifiable ChatGPT identity
   assertion. A Studio-supplied email is an intended recipient, not proof of
   ownership; the independent OS email link remains the proof. The website
   must present/collect the intended email from the logged-in owner, bind the
   request to its authenticated project and stable site UUID, show the same UUID
   at both sides, and preserve the request ID after reload. Single sign-on
   would require a separately specified signed, audience-bound identity
   exchange; a browser-submitted email or cookie cannot replace verification.
   Sites' `oai-authenticated-user-id` is scoped to each Site and cannot be
   compared across the Studio and OS as one person's canonical ID.
2. **Site admission configuration.** Production does not yet install the new
   Studio `allow_new_sites:true` opt-in or deploy this PR's OS runtime. The
   service credential, editor origin and notification scopes must remain
   server-only. No individual owner email or site UUID needs advance entry in
   the opt-in registry, but enabling the registry is an operator rollout step.
3. **Static source operations and connected Google.** The ICS and
   Sheet/CSV/Excel paths above are implemented only in this draft branch.
   Their end date is an owner assertion about a complete source export, not
   independent evidence that Booking/OwlNest has no other orders. Each new
   external change requires a refreshed import and review before OS can safely
   sell that night. Connected Google remains read-only, and OS holds cannot
   write occupancy back to it; it needs an explicit authority/writeback design.
   Keep connected sources and unresolved imports outside sale-ready status.
4. **Physical package mapping.** Current mixed selling mode maps one whole-house
   offer to *all* physical rooms. It cannot infer arbitrary overlapping Villa
   packages from Booking labels. The owner must confirm actual room units and
   package composition; 蘭城's indexed three Villa options are not three new
   physical rooms. Changes to an approved pool need explicit migration rules.
5. **Real external acceptance.** Two owners must use their own accounts and
   actual source formats to check source coverage, mobile email/Google return,
   room mapping, last-room and OTA conflict, notification receipts, payment
   verification and pause/recovery. External tenant Gmail/LINE/OwlNest senders
   are separate incomplete work. No pilot booking or credential is created by
   this note or the synthetic test.

## Safe deployment order

1. Review this PR and deploy a protected OS candidate with the new UUID-site
   client opt-in only for the trusted Studio server. Verify unknown-site denial
   for legacy clients, one-hour pending expiry, cross-owner rejection, exact
   retry, owner-created account and sales-off readback. Keep the public sales
   switch disabled. Do not configure pilot emails in advance.
2. Have the website expose a public authenticated owner flow, retain its own
   project/site UUID, collect the owner's chosen OS contact email during setup,
   and show the same site ID and approval URL. Test the real Studio-to-OS
   request with two different owners before changing the primary OS runtime.
3. Verify the new ICS and Sheet/CSV/Excel inventory paths with two owner-led
   imports, including source completeness, revised files, undo, package overlap
   and last-room/OTA conflict. Keep
   connected Google, OTA/OwlNest and unresolved imports outside sale-ready
   status until their authority paths pass end-to-end acceptance.
4. Deploy the reviewed OS source to the primary domain only after candidate
   readback and rollback checks. Approve each pilot's mapping in the owner's
   own session, leave sales off, and enable it separately only after real
   inventory, notices and payment-flow evidence is complete.

The corresponding room/source questions for 愉園 and 蘭城 are in
`BETA_PILOTS_YUYUAN_LANCHENG_2026-10-12.md`.
