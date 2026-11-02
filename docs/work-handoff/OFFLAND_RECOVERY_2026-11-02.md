# OFFLAND recovery — 2026-11-02

Current production was re-read, not inferred from the prior handoff. Calendar deployment baseline: `dpl_7prwk9gYkHddF7Cn5GKCyBsJBi13`. All 801 source files were downloaded or recovered by exact deployment SHA1; no Git baseline was used as a substitute. This commit preserves that production tree and integrates PR #127's request-status fix. Device-cache data stays unverified until a successful live read (`fromDeviceCache` prevents green status).

Validation: 14 source-status/resilience/device-hydration tests pass, TypeScript passes, full Webpack build passes. The production candidate is `dpl_HQRNQFbK8UtDHf2yWJpLV7NLMm4Y`; promotion/readback are recorded below when complete. No booking/occupancy/payment edits are part of this UI release.

Gmail baseline is `gmail-order-handler-offland-orders-36954b1`, image digest `d0ada2519db20b359ef29a278f29d576e5e1716938d87f06bd80d972024d9e68`. The source credential was rotated using PR #126's exact tool with rollback rehearsal and successful apply/readback. Replacement ID `2c583cd0-4afc-46f1-ba9b-fceed00f8918`, expiry `2026-11-29T16:43:14.960Z`; existing Secret Manager version 2. Candidate `gmail-order-handler-offland-source-20261102` differs from the live revision only in that fixed secret version. Runtime, image, scopes and old credential are preserved.

Calendar credential remains `354219dd-6419-401b-9155-ac8e52977516`, expiry `2026-11-29T09:59:35.824Z`. Existing daily expiry task `6ae7398bbfcc8191b15027025cfb94d6` is monitoring, not automatic renewal. Renewal still requires the guarded rotation package, administrator SQL, fixed secret/environment installation, consumer deployment, authenticated verification and readback. Runtime services must not receive credential-issuing privileges.

Private manifests, tokens, raw mail, claims, deployment environment values and guest data are excluded from this document and Git. This recovery has no guest notification authorization. Quarantined messages and unresolved channel-review records must remain intact unless independently resolved.

## Renewal procedure and remaining automation gap

Use the existing daily 09:00 Asia/Taipei monitor, task `6ae7398bbfcc8191b15027025cfb94d6`; do not create a second expiry schedule. It is an alert/preparation task, not an unattended credential issuer. Check actual deployed credential IDs and database expiries on every run, including replacements, rather than permanently monitoring a historical ID. Start maintenance with at least seven days remaining; complete both consumers' authenticated readback before declaring renewal done.

For the next cycle:
1. Re-read live Vercel alias/source and Cloud Run traffic revision/digest/full runtime and secret pins. Calendar and Gmail have independent credentials and expiry times.
2. Use PR #126's operator rotation tool against a fresh metadata-only snapshot. Preserve the complete grant and epoch; dry-run rollback, apply and independent verify must all pass. Never extend the old row in place.
3. Calendar: update the server-only production grant ID and token together, stage from the complete current production source, verify authenticated calendar reads and preserve device-cache unverified states.
4. Gmail: add only the token to the existing Secret Manager secret; stage a fixed numeric version on the exact live runtime/image. Re-pin the release controller to that cycle's actual baseline/candidate; preserve and verify all existing unknown/quarantined state. Use the existing pause/drain/outbox/restore workflow and verify source authorization, not merely `/health`.
5. After independent live readback, record the new expiry and consumer IDs in the maintenance record. Keep the former package private for recovery; do not publish token material or install credential-issuing authority into application runtimes.

Unattended renewal is **not** implemented or proven. A scheduled reminder does not supply the administrator SQL transport, GCP identity, release review or authenticated verification. Until those are provided to an audited maintenance runner, an authorized maintainer must execute this procedure. This session established a tested manual procedure; it does not promise an automatic November renewal.


## Verified UI publication

The candidate was promoted to the existing production alias, confirmed independently through Vercel deployment lookup. A logged-in browser selected OFFLAND / November 2026 and refreshed: 27 room-nights remained, the toolbar immediately showed `更新中`, then returned to `訂單已讀取` after success. Compared with the former live deployment, the published source differs in exactly four paths: caller, new status helper, toolbar and status UI test; no source files were removed. PR #127 remains the source-control review record, separate from the completed CLI production publication.

## Mail reconciliation findings

The audit starts at `2026-11-01T04:46:49Z` and scans the complete mailbox, including read, archived, spam/trash and quarantined messages; it does not use the seven-day unread filter. The initial full-content scan found 26 messages, seven parsed booking notifications: six Sweetfun notices and one OFFLAND modification. Other OFFLAND mentions were a processing-error copy and an Airbnb payout notice, not new bookings/cancellations.

The OFFLAND modification was matched through its original Gmail ID, permanent Firestore `needs_human` claim, original deterministic request key, source lookup and booking. No source receipt exists for that message. Exact deployed parser/writer code classified it as `payment_method_only`, and the real source-authenticated processing path returned `skipped/payment_method_only` with all apply/enrich writes explicitly blocked. Original/updated mail sections agree, and the source booking identity and stay match. No booking backfill is required for that notice; the platform payment/card check remains manual. Quarantine and original idempotency identity were preserved. No guest or operator notification was resent. Private identifiers and raw content remain outside Git.

The two unrelated pre-existing channel review records remain unresolved, scoped and unchanged. Their immutable backend claim/hold/fence hashes were rechecked before release; no claims were cleared to pass release checks.


## Final release readback

Completed `2026-11-01T17:08:19.850072Z` (2026-11-02 01:08 Asia/Taipei). The source candidate now serves 100% production traffic. Independent post-release readback confirms the full runtime and IAM fingerprints, fixed source-secret version 2, identical image, and all seven ingress sources restored to their original state. The real source lookup succeeds. Post-release Cloud Run error/5xx scan returned zero records in the checked window. The first aborted attempt and successful retry both retained durable journals; no business/notification records were cleared.

Website production is `dpl_HQRNQFbK8UtDHf2yWJpLV7NLMm4Y`, with logged-in OFFLAND November refresh verified at 27 room-nights. Its post-release error/fatal runtime-log scan returned no groups. Tests: 14 UI/status/cache tests, TypeScript, full Webpack build and focused ESLint pass; six credential-runtime tests and 107 existing publication/poll/recovery tests pass. Published code is retained on the existing bnb-platform PR #127 and gmail-check-order PR #123; the PRs remain unmerged review records and are separate from verified production deployments.

Final full-content mailbox audit window: `2026-11-01T04:46:49+00:00` through `2026-11-01T17:08:49+00:00`, which extends beyond completed service restoration. Total messages: 26; parsed booking notices: 7; OFFLAND notices: 1 (payment-method-only modification). OFFLAND new bookings/cancellations needing backfill: 0; booking backfills written: 0; remaining platform payment/card review: 1. No additional notifications arrived during the release. The quarantined claim and original request key remain intact.
