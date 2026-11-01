# OFFLAND recovery — 2026-11-02

Current production was re-read, not inferred from the prior handoff. Calendar deployment baseline: `dpl_7prwk9gYkHddF7Cn5GKCyBsJBi13`. All 801 source files were downloaded or recovered by exact deployment SHA1; no Git baseline was used as a substitute. This commit preserves that production tree and integrates PR #127's request-status fix. Device-cache data stays unverified until a successful live read (`fromDeviceCache` prevents green status).

Validation: 14 source-status/resilience/device-hydration tests pass, TypeScript passes, full Webpack build passes. The production candidate is `dpl_HQRNQFbK8UtDHf2yWJpLV7NLMm4Y`; promotion/readback are recorded below when complete. No booking/occupancy/payment edits are part of this UI release.

Gmail baseline is `gmail-order-handler-offland-orders-36954b1`, image digest `d0ada2519db20b359ef29a278f29d576e5e1716938d87f06bd80d972024d9e68`. The source credential was rotated using PR #126's exact tool with rollback rehearsal and successful apply/readback. Replacement ID `2c583cd0-4afc-46f1-ba9b-fceed00f8918`, expiry `2026-11-29T16:43:14.960Z`; existing Secret Manager version 2. Candidate `gmail-order-handler-offland-source-20261102` differs from the live revision only in that fixed secret version. Runtime, image, scopes and old credential are preserved.

Calendar credential remains `354219dd-6419-401b-9155-ac8e52977516`, expiry `2026-11-29T09:59:35.824Z`. Existing daily expiry task `6ae7398bbfcc8191b15027025cfb94d6` is monitoring, not automatic renewal. Renewal still requires the guarded rotation package, administrator SQL, fixed secret/environment installation, consumer deployment, authenticated verification and readback. Runtime services must not receive credential-issuing privileges.

Private manifests, tokens, raw mail, claims, deployment environment values and guest data are excluded from this document and Git. This recovery has no guest notification authorization. Quarantined messages and unresolved channel-review records must remain intact unless independently resolved.
