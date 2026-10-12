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
2. **Site admission configuration.** Production does not yet install the new
   Studio `allow_new_sites:true` opt-in or deploy this PR's OS runtime. The
   service credential, editor origin and notification scopes must remain
   server-only. No individual owner email or site UUID needs advance entry in
   the opt-in registry, but enabling the registry is an operator rollout step.
3. **Import-to-booking compatibility.** Today's website approval accepts an
   empty native property or an already eligible native property. The
   `nativeProperty` guard rejects a property with imported bookings or calendar
   bindings; importing Sheet/ICS after an approved website connection makes
   website bootstrap unavailable. Thus the owner can self-create a calendar
   and self-import data, but those two actions do not yet form a sale-ready
   shared-inventory journey. Static imports need an explicit, tested rule for
   complete source coverage, existing orders/blocks, reimport conflicts and
   quote date bounds. A connected Google calendar remains read-only and
   cannot be treated as two-way inventory without an authority/writeback
   contract. Keep sales off while this is unresolved.
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
3. Implement and test the static-import/shared-inventory rules in gap 3,
   including explicit date coverage and package conflicts, then verify one
   owner-led import per source type in separate workspaces. Keep connected
   Google, OTA/OwlNest and unresolved imports outside sale-ready status until
   their authority paths pass end-to-end acceptance.
4. Deploy the reviewed OS source to the primary domain only after candidate
   readback and rollback checks. Approve each pilot's mapping in the owner's
   own session, leave sales off, and enable it separately only after real
   inventory, notices and payment-flow evidence is complete.

The corresponding room/source questions for 愉園 and 蘭城 are in
`BETA_PILOTS_YUYUAN_LANCHENG_2026-10-12.md`.
