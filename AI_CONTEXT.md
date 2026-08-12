# BnB Platform — Authoritative AI Context

> **Status:** V1 Build Baseline 1.0  
> **Updated:** 2026-08-12  
> **Purpose:** canonical public-safe context for coding agents and AI reviewers.
>
> This document intentionally excludes raw guest conversations, reservation rows, booking screenshots, real access codes, bank-account values, and other private evidence.
>
> **Precedence rule:** latest owner decisions/spec freeze > latest Mobile UI/UX spec > PRD/subsystem specs > research findings > legacy repository README/code comments.

## 0. Start here

This repository contains an older implementation/README that describes a RAG-driven web dashboard and more autonomous AI reply flow. That is historical implementation context, **not the current product contract**.

The current V1 direction is:

- **iOS-first mobile app**; Android and Web may follow using the same information architecture.
- **Human-in-the-loop AI Reply Copilot**, not an autonomous chatbot.
- LINE Official Account is the first channel.
- Google Sheet remains the reservation **SSOT**.
- Core architecture: **Conversation Router + Identity Resolver + Context/State + Structured Knowledge + Reply Engine**.
- Fixed/data-inserted replies are preferred over free generation.
- Unknown, risky, or missing-data situations go to **Human Review**, not hallucination.

---

# 1. Product goal

Help small hospitality operators reply to LINE messages quickly without repeatedly re-reading booking data, searching old answers, or retyping standard replies.

Primary experience:

1. Guest sends a LINE message.
2. System ingests and stores the message.
3. Context Builder assembles relevant conversation and structured state.
4. Conversation Router determines current intent/conversation act and missing data.
5. Identity/Reservation Resolver runs when the answer depends on a booking.
6. Reply Engine produces the safest useful suggestion.
7. Owner taps the suggestion, optionally edits it, then sends manually.

The product should feel like a messaging tool, not an AI dashboard.

---

# 2. Frozen product decisions

## Human control

- V1 does **not** auto-send AI replies.
- AI suggestions are placed near the message input area.
- Tapping a suggestion inserts the text into the input field.
- Owner may edit before sending.
- Identity binding also does **not** send a guest-facing message.

## Accuracy over inference cost

- Production routing should use an LLM for semantic understanding.
- Embeddings may retrieve candidates but are not the final authority for intent.
- Model/provider selection is benchmark-driven and is **not frozen yet**.

## Reservation truth

- Google Sheet is the Reservation SSOT.
- Sweetfun LINE User ID writes to **column R**.
- If one booking maps to multiple stay rows, write the LINE User ID to all related rows.
- SaaS keeps one canonical `IdentityLink` internally.

## Historical chat

- Historical LINE conversations are evidence, not current business truth.
- A historical reply may reflect an old policy or a one-off exception.
- Never infer current price/policy by majority vote over old conversations.

## Response priority

1. Fixed reply when a standard current answer exists.
2. Data-inserted reply when structured data is needed.
3. AI-written reply only when the first two cannot solve the case.
4. Human Review for exceptions, risk, uncertainty, missing monetary data, or incomplete context.

## Reply scope

Answer what the guest asked. Do not automatically add unrelated room features, policies, or upsell content unless the business explicitly configures that behavior.

---

# 3. Mobile Information Architecture — V1

Bottom tabs:

1. **收件夾 / Inbox**
2. **知識庫 / Knowledge**
3. **設定 / Settings**

Explicitly not in V1:

- separate Traveler tab
- Analytics/Dashboard tab
- visible language controls
- large advanced-settings surface

## Inbox

Each row should prioritize operational recognition:

- avatar
- display label such as `8/13 101 Rou柔`
- latest-message preview
- timestamp
- unread count
- a small workflow status such as 待處理 / 處理中 / 已結束

The stay date and room should come from structured reservation state after identity resolution, not from permanently renaming a person record.

Multi-room display should remain compact; avoid stuffing multiple room numbers into the row.

## Conversation screen

Header:

- show the current user/conversation name prominently, similar to LINE OA mental model.
- top-right `…` opens secondary actions.

Immediately below header:

- compact, collapsible booking summary, e.g. `8/12–8/14｜201房`
- same-date multi-room may use `8/12–8/14｜201房＋1`
- mixed/complex bookings may use a generic summary such as `2筆住宿訂單`
- a visible `查看備註` entry

Chat direction:

- guest messages on the **left**
- owner messages on the **right**
- AI suggestion is a separate UI element, not a chat bubble

AI suggestion lifecycle:

- by default show **one most relevant suggestion** for the latest guest message
- when a new guest message arrives, the old suggestion becomes stale and a new round is generated
- multi-intent may justify more than one suggestion
- suggestion tap → insert into input → edit if needed → owner sends

Booking details such as booking number, price, platform, guest name and headcount only appear after expanding the compact summary.

## Notes / phone context

`查看備註` opens internal human-provided context such as:

- phone-call note
- manual booking/identity confirmation
- special request
- reservation-specific exception
- internal reminder

Phone/offline context is first-class product data. The AI must not guess a missing phone conversation.

## More actions

Conversation `…` bottom sheet should stay lean:

- 查看備註
- 查看訂單資訊
- 重新辨識訂單
- 加入標籤
- 取消

Do not put AI model settings, CRM features, or broad automation controls here.

---

# 4. Identity Resolver

LINE user and reservation are not naturally linked.

Possible evidence:

- existing `IdentityLink`
- OTA/booking order number
- guest name
- check-in / check-out date
- room number / room type
- phone or email when available
- recent chat context
- owner-provided tag/note
- booking screenshot(s)

## Screenshot flow

A guest may send multiple screenshots.

Identity UI should:

- list recent relevant images
- allow checkbox select/deselect
- optionally preselect likely booking screenshots
- display `已選 N / M`
- extract structured evidence from selected images
- match evidence against Google Sheet reservations

OCR/Vision output is **evidence**, not booking truth.

## Candidate resolution

- high-confidence candidate: may be surfaced prominently
- V1 default is still owner confirmation before binding
- medium confidence: show ranked candidates
- no suitable match: return to chat; AI may suggest a missing-data question

Primary CTA: `確認綁定`

Permanent UI note: **僅更新內部資料，不會自動傳訊給旅客**.

Do not clutter V1 with large redundant actions such as `改由人工確認` and `詢問客人資訊`.

---

# 5. Context and Conversation State

Router must not classify only the latest sentence.

Each routing decision may use:

1. Property State
2. Reservation State
3. Human-provided Context
4. Confirmed Conversation State
5. Open Loops
6. up to the most recent **50 human messages**
7. latest message/media evidence

## Hard vs soft memory

Hard/longer-lived reservation context includes:

- confirmed identity
- active booking
- room
- dates
- confirmed exception such as approved late checkout

Soft state includes:

- active topic
- waiting for a name/order number
- temporary clarification state

## Open Loops

An unresolved topic may remain in state, but **memory does not imply reply**.

Old unresolved topics must not be surfaced into an unrelated new conversation unless:

- the latest message clearly continues that topic
- the answer depends on it
- it represents a real transactional obligation that must still be completed

This prevents the system from sounding repetitive or “stuck”.

## Source priority

Owner-confirmed human context outranks AI inference.

A practical priority order is:

1. owner-confirmed manual context / explicit reservation exception
2. Google Sheet reservation data
3. confirmed conversation state
4. recent raw conversation
5. AI-inferred soft context

Every stored fact should preserve source, scope, confidence and effective time where relevant.

Scopes include:

- Property
- Person
- Reservation
- Session/Conversation

Do not permanently attach a room number to a person; the next stay may use a different room.

---

# 6. Knowledge and Reply Model

The UI should use business-friendly concepts:

- **回覆主題 / Reply Topic** = what kind of guest question this is
- **回覆內容 / Reply Content** = the actual suggested message

Avoid exposing “template engine” jargon to ordinary operators.

## Reply modes — V1 UI

- 固定回覆 / Fixed Reply
- 帶入資料 / Data-Inserted Reply
- AI 撰寫 / AI-Written
- 人工處理 / Human Handling

On the Edit Reply Topic screen, `回覆模式` should remain visually simple; detailed explanations belong behind a small `?` help icon.

V1 does not show language controls. Multilingual controls may live in future Settings/Advanced.

## Knowledge CRUD

Knowledge home lists topics such as:

- 停車資訊
- 入住資訊
- 行李寄放
- 收據／統編
- 房型設備

Each topic row has `…` with:

- 編輯
- 複製
- 刪除

Delete requires a second confirmation.

iOS swipe-to-delete may be an additional shortcut, not the only discoverable delete action.

## Structured data vs prose

Property/Room facts should be structured when possible:

- check-in/out time
- parking policy
- room bed size
- bathtub/window/balcony
- entrance/access-code variable
- room keybox-code variable

Sensitive values do not belong in general RAG.

---

# 7. Sensitive Variables

Sensitive information is structured and versioned.

Examples:

- property entrance code
- room/keybox code
- Wi-Fi password when treated as sensitive
- bank transfer data

Rules:

- never hardcode real values in source/specs
- owner changes the active value in UI
- maintain version/effective-time metadata
- rendered suggestions must **re-resolve the current value at apply/send time** so a stale suggestion cannot send an old code
- audit/log output should mask secrets

---

# 8. Sweetfun Current Business Truth — Build Baseline

Owner-confirmed current rules:

## Rooms / beds

- 101 / 102 / 201 / 202 / 301: 加大雙人床, **180 × 190 cm**
- 302: 標準雙人床, **150 × 190 cm**

## Checkout

- official checkout: **before 11:00**
- old 10:00 replies are stale historical evidence

## Parking

- weekday: NT$20/hour, cap NT$150
- Saturday/Sunday/public holiday: NT$30/hour, cap NT$200

## Luggage storage

- before check-in and after checkout are both allowed
- only on the guest’s check-in/check-out day
- location: under the wooden shelving on the first floor
- valuables should stay with the guest
- do not proactively state a precise clock cutoff

## Receipt / invoice

- no official invoice
- handwritten stamped receipt may be provided
- guest company tax ID may be written on the receipt

## Payment

- OTA bookings: payment/credit-card processing through the OTA
- LINE/phone direct bookings: bank transfer
- no onsite cash payment in the self-check-in flow
- SaaS must not store raw card data

## Access codes

- entrance and room codes rotate irregularly
- both are versioned structured secrets

## Whole-house price

Pricing is dynamic.

Typical internal reference only:

- Mon–Fri: around NT$15,000
- Saturday: around NT$22,000

These numbers are **not guaranteed automatic quotes**.

Unknown current money fields, including extra-bed fee and Sunday/special-holiday whole-house pricing, go to Human Review.

## Internal-only data

`回水時段` is an internal operations note and is not customer-facing knowledge.

---

# 9. Conversation Router Contract

Conceptual input:

```json
{
  "property_state": {},
  "reservation_state": {},
  "human_context": [],
  "conversation_state": {},
  "recent_human_messages": [],
  "latest_message": {}
}
```

Conceptual output:

```json
{
  "intents": [],
  "conversation_acts": [],
  "known_fields": {},
  "missing_fields": [],
  "context_completeness": "HIGH|MEDIUM|LOW",
  "identity_requirement": "NONE|RESOLVE_IDENTITY|RESOLVE_ROOM",
  "next_action": "...",
  "reply_topic_candidates": [],
  "risk_level": "LOW|MEDIUM|HIGH",
  "confidence": 0.0,
  "state_updates": []
}
```

Intent and Conversation Act are separate concepts.

Examples of Conversation Acts:

- social acknowledgement
- identity evidence provided
- payment proof provided
- contextual slot/follow-up
- arrival notice
- checkout notice
- non-guest/B2B sales message

Multi-intent must be supported.

High-risk topics include refunds, cancellation, monetary commitments, reservation changes, complaints, identity/access codes and similar cases; these may require stronger verification or Human Review.

---

# 10. Reply Engine Contract

Reply Engine decides what UI suggestion to produce after Router/Data Resolver results.

Typical routes:

- `PARKING` + current fixed policy → Fixed Reply
- `BED_SIZE` + known room → read Room Master → Data-Inserted Reply
- `BED_SIZE` + unknown target room → Identity/Room Resolver → no answer until missing data is resolved
- `BOOKED_ROOM` + active reservation → reply only with requested room information
- complex recommendation/open-ended request → AI-Written
- refund/exception/unknown price → Human Handling

The Reply Engine must not fill missing business data from historical messages.

---

# 11. Data Model — core entities

V1 should conceptually support:

- Tenant
- Property
- Room
- Contact / LINE User
- Reservation / Booking
- StayUnit
- Conversation
- Message
- IdentityLink
- StateFact
- OpenLoop
- HumanContextEvent
- ReplyTopic
- ReplyContent
- StructuredVariable / SensitiveVariable
- RouterDecision
- ReplySuggestion
- FeedbackEvent

Every important state mutation should be auditable.

FeedbackEvent should capture at least:

- AI suggestion
- final owner text
- selected/rejected/ignored state when observable
- diff between suggestion and final text

Do not fine-tune immediately from every edit; use feedback first for evaluation, knowledge improvement and routing diagnostics.

---

# 12. System Architecture — V1 direction

High-level flow:

```text
LINE Webhook
  -> Message Ingestion
  -> Conversation/Message Store
  -> Context Builder
  -> Conversation Router
  -> Identity / Reservation Resolver when needed
  -> Reply Engine
  -> Suggestion Store / UI
  -> Owner edit + explicit send
  -> LINE Send
  -> Feedback/Audit
```

Side data:

```text
Google Sheet Reservation SSOT
Property / Room structured data
Reply Topic / Reply Content
Sensitive Variable Store
Model Gateway
```

Engineering priorities:

- tenant isolation from day one
- reliable webhook ingestion / idempotency
- message persistence before AI processing
- human-send fallback even when AI is unavailable
- auditability
- masked secrets/logging
- provider abstraction for Router/Vision/LLM

Do not start the implementation by optimizing prompts.

---

# 13. Stage 3 research conclusions

Historical Sweetfun data established that the architecture should not be “LLM generates everything”.

Among high-confidence business-intent occurrences in the research set:

- Fixed: ~41.5%
- Template / structured-data reply: ~39.6%
- Human Review: ~13.3%
- Generative: ~5.6%

Therefore Fixed + structured/data-inserted replies cover roughly **81%** of high-confidence business-intent occurrences in that analysis.

Interpretation:

- LLM is most valuable for understanding/routing/context.
- Most common hospitality replies should remain controlled.
- This percentage is research evidence, not a universal guarantee for every future tenant.

The historical study also showed substantial context dependency, supporting the Structured State + recent-message architecture rather than one-message classification.

---

# 14. Evaluation / Stage 3B

Do not ask each future property to manually label hundreds or thousands of messages.

Product-level evaluation strategy:

1. Build a small high-quality contextual Gold Set using Sweetfun.
2. Use multiple strong models to generate broader Silver labels.
3. Human-review model disagreements / high-value ambiguous cases.
4. Benchmark Router/provider/prompt versions against the same set.
5. After launch, collect implicit owner feedback from suggestion selection/edit behavior.

A benchmark case should include context, not just a single guest sentence:

- recent conversation
- known structured state
- latest guest message
- expected intent(s)
- conversation act
- missing data
- identity/room resolution need
- next action
- reply mode

New tenants should mainly confirm **their business truth**, not train the global intent classifier.

---

# 15. MVP settings scope

Keep Settings lean:

- LINE connection
- Google Sheet connection
- Notifications
- Sensitive data / access codes
- Account/basic sign-out

Do not add to V1 unless a real blocker emerges:

- complex role/member management for single-owner dogfood
- AI model selector
- analytics settings
- data export center
- language settings
- broad automation settings

Knowledge is already a primary tab; do not duplicate it unnecessarily inside Settings.

---

# 16. Acceptance principles

The implementation is not acceptable if any of these behaviors occur:

- guest asks room-specific question, identity/room is unknown, system guesses a room
- guest has two rooms and the system silently chooses one when the answer differs by room
- owner approved a reservation-specific exception, but general policy overrides it
- owner changes an access code and a stale suggestion sends the old code
- latest guest message changes topic but AI keeps surfacing an old unresolved FAQ
- identity binding automatically sends a guest-facing message
- AI invents an unknown monetary value
- raw OTA screenshot OCR is treated as truth without validating against reservation data
- a previous stay’s room remains permanently attached to a returning guest
- AI outage prevents the owner from manually replying

---

# 17. Implementation order

Recommended sequence:

1. Project/repo baseline and tenant-safe data foundation
2. LINE webhook/message ingestion + reliable manual send
3. Inbox + mobile Conversation shell
4. Google Sheet reservation sync/canonicalization
5. IdentityLink + manual binding/write-back to column R
6. Structured Property/Room/Knowledge data
7. Notes/HumanContext/Conversation State
8. Conversation Router contract + logging
9. Reply Engine + suggestion lifecycle
10. Screenshot/Vision identity evidence
11. Stage 3B evaluation harness
12. Sweetfun dogfood
13. Only then consider onboarding a second property

Do not let model selection block the early engineering milestones.

---

# 18. Build agent operating rules

Coding agents should:

- implement frozen contracts instead of redesigning the product from scratch
- choose the simplest reversible implementation for unspecified low-risk details
- record meaningful architecture decisions as ADRs
- stop only for irreversible/high-risk changes, new paid credentials/services, missing critical assets with no fallback, or a real product-strategy conflict
- never hardcode actual secrets or unconfirmed money values
- preserve audit/history rather than rewriting old messages when identity/state changes

**Build Baseline authorizes coding; it does not mean production-ready.**

Before production release, complete security/tenant isolation validation, outage handling, audit/log masking, Stage 3B benchmark, and integration acceptance tests.

---

# 19. Privacy boundary for this public AI context

This page intentionally does **not** publish:

- raw LINE conversation exports
- canonical reservation rows containing guest PII
- booking screenshots
- phone numbers/emails from historical guests
- actual entrance/keybox/Wi-Fi passwords
- bank-account data
- raw Stage 3B queues that contain identifying conversation examples

Those remain private evidence for the project team.

---

# 20. One-line instruction to another AI

Use this file as the authoritative product/build context for `bnb-platform`. Do not follow conflicting legacy README/code behavior without first reconciling it against this Build Baseline. Implement the iOS-first, human-in-the-loop messaging copilot with structured reservation/identity/context/knowledge handling, and use Human Review instead of inventing missing facts.