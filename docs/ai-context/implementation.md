# Implementation Plan & Agent Rules

## Build status

V1 Build Baseline 1.0 is approved for implementation.

Build approval does not mean production-ready.

## Recommended implementation order

1. Project/repo baseline and tenant-safe data foundation
2. LINE webhook/message ingestion + reliable manual send
3. Inbox + mobile Conversation shell
4. Google Sheet reservation sync/canonicalization
5. IdentityLink + manual binding/write-back to column R
6. Structured Property/Room/Knowledge data
7. Notes / HumanContext / Conversation State
8. Conversation Router contract + logging
9. Reply Engine + suggestion lifecycle
10. Screenshot/Vision identity evidence
11. Stage 3B evaluation harness
12. Sweetfun dogfood
13. Only then consider onboarding a second property

## Do not start with prompt tuning

Early milestones should prioritize:

- webhook reliability
- idempotent ingestion
- message persistence
- manual owner sending
- tenant isolation
- data correctness
- observability/audit

The product must still allow the owner to reply if AI is unavailable.

## Coding-agent behavior

Agents should:

- implement frozen contracts instead of reopening product strategy
- choose the simplest reversible option for unspecified low-risk details
- record meaningful architecture decisions as ADRs
- keep interfaces provider-agnostic where model/vendor choice is not frozen
- preserve historical/audit data instead of rewriting past events

Stop and ask only when encountering:

- irreversible or high-risk architecture/product changes
- a new paid service/credential requirement not already approved
- missing critical asset with no reasonable fallback
- direct contradiction between authoritative product decisions

## Never hardcode

- real access codes/passwords
- bank-account values
- unknown prices
- a permanently fixed whole-house price when the business rule is dynamic
- reservation identity based only on a manually renamed LINE contact label

## Safe fallback

If identity, context, structured data, or a monetary field is missing:

- represent the missing-data state explicitly
- ask for or retrieve the missing data
- or use Human Handling

Do not manufacture a plausible answer.

## Production gate

Before production release, complete:

- Stage 3B benchmark and agreed quality thresholds
- tenant-isolation validation
- secret/log masking review
- outage handling / manual fallback tests
- LINE integration acceptance tests
- Google Sheet synchronization/write-back tests
- identity binding and reservation-specific exception tests
- auditability checks