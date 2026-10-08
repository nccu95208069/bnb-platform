# OS-10 / OS-11 — OS implementation and integration boundary

Date: 2026-10-07. Owner instruction: update the Todo list board first, implement the OS-owned parts, defer cross-system wiring to integration tickets, review the code, fix critical issues, and report. The PM published board v4 with OS-10/11 in progress before implementation began.

## Delivery status

Implemented in `codex/os-holds-pricing-20261007`, based on the current customer/production source `407a064`. This is code and isolated acceptance, **not a production release**. No production orders, Google Sheet, OwlNest prices/stock, credentials, email, LINE delivery, or schedules were changed. The new hold endpoint/UI is disabled unless `CUSTOMER_HOLDS_ENABLED=true`; existing holds remain visible and keep occupying inventory even while new commands are disabled. Production integration-client scopes were not expanded.

### OS-10: native hold lifecycle

A native customer-workspace booking can now have `status=held` and a versioned `hold` record. Its scope is explicitly `platform_only`. A successful local creation reserves the selected physical room nights for 24 hours from creation. The exclusive checkout date is not occupied. Whole-property selection uses the existing physical room IDs; a hold conflicts with other active bookings and blocks through the same atomic workspace comparison-and-swap as ordinary booking creation.

Expiry derives `awaiting_owner` from the persisted deadline. It does not release the room or invent a receipt. `pendingHoldTasks` reconstructs a stable task identity from booking ID/version/deadline after a restart; the order search and navigation expose expiry decisions and late-payment review. This is a durable work list, not an email/LINE notification scheduler.

Owner/admin operations use authenticated account, workspace/property scope, workspace and booking versions, durable request keys, operation receipts, and post-write readback:

| Action | Result |
| --- | --- |
| `hold-create` | Requires a positive known total, explicit platform-only acknowledgement, and no initial payment. Creates the original UUID and a 24-hour deadline. |
| `hold-extend` | Adds 12/24 hours to the later of now/current deadline, or accepts an explicit later UTC deadline within one year. Rechecks current occupancy/readiness. |
| `hold-convert` | Requires confirmation of actual receipt, amount, method/time and an account for bank/card. Atomically appends one deposit receipt and confirms the same booking ID/source. Partial payment leaves the proper remaining balance. |
| `hold-release` | Only an unpaid held booking can release its own occupancy reason. Never changes another booking/block or external stock. |
| `hold-late-payment` | Records actual money against a released booking and requires owner review. Never reclaims inventory or changes it back to confirmed. |
| `hold-refund` | Records a bounded refund without reopening inventory. Clears late-payment review when the retained actual balance reaches zero. |

The customer operations endpoint handles these actions at `POST /api/customer-workspaces/[slug]/operations`. It is a private owner UI endpoint, not the future guest/LINE service API. A valid session and same-origin request are required. The UI retains one request body/key while the result is unknown, locks competing controls/navigation, and retries the original operation. Backend receipts survive process restart. Reloading and deliberately discarding a browser warning loses the unsent form; clients added in integration tickets must provide durable request recovery across page reloads.

Official Website is preserved as the source when entered at creation and cannot be relabeled by an order-details command. It is not inferred from the acting channel. The website binding adapter will enforce this source server-side in INT-01.

Calendar, availability and import collision checks include held inventory. Revenue/receivables for formal bookings remain separate; dated actual receipts include late payments. Hidden-price views omit money, receipt details and late-payment financial flags. Standard workbook v4 appends five hold columns and exports held orders/nights distinctly from cancelled orders. Intact v1/v2/v3 workbooks can upgrade; foreign edits still block writes. Importing a held source row without its authoritative hold contract is rejected for review rather than converted to a formal/cancelled order.

### OS-11: pricing decisions and exact readback

The existing scoped calendar-change receiver adds the opt-in `pricing_decisions` change kind. Old events remain compatible. A producer must receive that explicit permission later in INT-04; a prices-only client cannot silently introduce decision fields.

`pricing_snapshot.cells[].pricing_decisions[channel]` stores:

- `run_id`, `source_version`, `model_version`, `policy_version` (bounded identifiers)
- positive integer TWD `base_price`, `target_price`, nullable `published_price`
- `adjustment_pct`, checked against base/target to 0.011 percentage points
- nullable `probability: {value, asof, source_version}` with range/date/version validation
- bounded `reason` (must not contain guest/account data)
- UTC `calculated_at`, nullable `published_at`, and `observed_at`
- `publish_status`: `shadow`, `proposed`, `skipped`, `verified`, or `failed`

A verified publication requires a published price equal to the target and a consistent publication time. Shadow/proposed/skipped decisions cannot claim a published price. A failed publication may retain the mismatching observed price/time. The decision is per property/date/physical room/channel. OFFLAND's plans remain channels on its single villa, not extra inventory.

Decision-only events do not alter current channel prices, probability observations, or inventory. They have independent timestamps, reject older calculations and conflicting observations at the same time, and retain newer values on delayed delivery. Ordinary price events and manual OwlNest refreshes preserve decisions. The old bulk publishing script now refuses to replace a snapshot containing decisions; callers should migrate to the field-aware change endpoint. Snapshots are bounded to 4 MiB to fit existing readers.

POST and authenticated GET receipts return `decision_readback.cells` with the actual retained decision for each requested cell, `matches`, and SHA-256 `digest` of canonical sorted cells. The receipt and price snapshot commit atomically and are read back. A replay returns the immutable receipt; an event ID reused with different data is rejected. Partial/superseded events return 409 and `verified=false`, with the retained values available for diagnosis.

**Receipt `verified=true` means the OS saved and verified the submitted fields. It does not mean OwlNest was changed.** `decision.publish_status` describes the producer's publication observation. The UI labels shadow/failed/skipped distinctly, shows the decision's base/target/readback price, percentage, reason, probability and provenance, and keeps the current channel-price observation separate. It does not enable price publishing. Receipts retain the existing 30-day terminal retention; permanent immutable run history remains the pricing producer's responsibility.

## Integration tickets and acceptance

| Ticket | Remaining work |
| --- | --- |
| INT-01 | Owner-authorized website ↔ workspace/property/physical-room binding; server-owned quotes; scoped guest service credentials; stable public request recovery and source IDs. Website's provisional `/api/integration/website-booking/v1/bindings/{bindingId}/{action}` contract and `configurationHash` are inputs to this ticket, not live OS routes. The guest adapter must not call this private owner endpoint or trust browser totals/tenant IDs. |
| INT-02 | LINE actor/owner binding, expiry decision actions, durable notification/retry and notification status. Reuse this lifecycle after authorization; sender channel never changes Official Website source. |
| INT-03 | Existing Sweetfun/OFFLAND Sheet identity mapping and hold states, shared occupancy authority across legacy/native entrances, serialized OwlNest close/reopen with fresh pre/post-readback, partial-failure recovery and conservative release. Only then may an externally bound hold claim external room closure. Existing channel snapshots are not write authorization. |
| INT-04 | Pricing producer field mapping, scoped client enablement, immutable run history, producer→OS→GET exact comparison, live shadow acceptance, actual writer evidence and guardrails. Three-day automatic pricing remains disabled until that separate acceptance. |
| ING-01 | Existing notification ingestion remains authoritative; wire its verified booking changes to the receiver without adding a second Gmail ingestor. |

The website team delivered its independently tested adapter on October 7. Its note is `stayform-prototype/docs/web04-website-adapter.md` in the project workspace. No credentials or live reservation enablement were configured there; WEB-04 as a whole remains pending integration.

## Code review and verification

Self-review covered authority boundaries, CAS/idempotency, last-room races, stale owner commands, financial balance, privacy, import/export compatibility, decision merge rules, and React control locking/accessibility. Corrected issues:

1. Held occupancy could disappear from monthly views, availability and calendar-import conflicts; all now include active holds, including expired holds.
2. The old workbook fallback labeled every non-confirmed booking cancelled; v4 now exports explicit hold states and deadlines, with guarded historical upgrades.
3. Generic financial operations could bypass the required hold receipt transition; they reject held bookings and direct owners to the dedicated atomic action.
4. A delayed pricing calculation could overwrite a later decision, and price refresh could drop its provenance; both now preserve the newer decision independently.
5. Released-booking late payments remain money only, appear in owner review and dated receipts, and never restore inventory. Financial flags are removed from hidden-price responses.

6. A formal booking cancelled after conversion keeps its conversion history and cannot be mistaken for a released hold or accept hold-specific late-payment commands.

No remaining critical issue was identified within this isolated scope. External integration acceptance is explicitly pending, not waived by this review.

Verification: 187 customer/availability/OFFLAND service, route and DOM tests plus 19 pricing/change-receiver/OwlNest-refresh tests (206 total); TypeScript; frontend lint; optimized webpack production build. The 19 include a real disposable loopback Redis server, atomic Lua fences, actual Next HTTP handlers, scoped auth, immutable readback, conflict handling and recovery after a committed response was lost. UI tests exercise creation and deposit conversion against the real hold service, including unknown-response locking and replay. No production write was used.

One existing OFFLAND parity test still asserted the old rule that channel-manager locked stock overrides the Sheet's unsold status. It also failed unchanged on the base checkout. Its expectation now matches the already-live source rule: unsold remains available for inquiry, with the separate locked channel observation retained. No production availability behavior was changed for this fix.

Frontend lint has six existing unrelated warnings and no errors. No Python/backend files changed. New UI was verified through DOM interaction; desktop/mobile browser and real operator walkthrough are still release acceptance items. Production activation and all cross-system acceptance belong to the tickets above.
