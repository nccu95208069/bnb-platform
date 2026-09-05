# Shared payment workflow: human and Agent integration

Updated 2026-09-05. Local synthetic integration only; production Sheet remains SSOT.

## Two clients, one persistent Mission

Humans enter from `/calendar` → order details → payment, or `/missions`.
Agents use the existing scoped HTTP Tools and Missions API, without browser automation.
Both see the original structured request, checked order, payment receipt, status,
next Tool, verification result, ordered audit, and blocking/parent Mission IDs.
A human can take over an Agent-created Mission by its addressable URL and vice versa.
There is no connected natural-language model or background scheduler in this slice.
The frontend is a bounded Playbook executor; closing a tab leaves unfinished Missions
available for explicit resumption. It never assumes a write response means completion.

## Agent contract

Base: `/api/v1/tenants/{tenant_id}/properties/{property_id}/payment-workflow`.
Production API requires verified bearer identity and actual DB membership/property scope.
The isolated harness on loopback port 8765 uses a fixed synthetic Owner ONLY in its
separate process. Its POSTs require `X-Payment-Sandbox: 1`.

1. `POST /tools/check_order` with precise known criteria. Inspect status; do not infer
   one matching booking by choosing from conflicting records.
2. `POST /missions` with `{goal, query, payment, idempotency_key}`. Persist the key
   before sending; reuse the identical request after uncertain responses. Never
   regenerate a key merely because a request timed out.
3. `POST /missions/{id}/advance` executes one Tool boundary. The service re-checks
   permission, source, version, and integrity. Continue only while `status=queued`.
4. `GET /missions/{id}` restores original input and audit. `next_tool` is guidance
   within the current status, not permission to bypass a wait or confirmation.
5. Complete only when `status=completed` and `result.status=verified`.

Example payment payload (substitute the actual receipt time):

```json
{
  "goal": "為 301 房指定訂單登記 2000 元訂金",
  "query": {"order_id": "test-order-301"},
  "payment": {
    "amount": 2000,
    "currency": "TWD",
    "payment_type": "deposit",
    "payment_method": "bank_transfer",
    "received_at": "2026-09-05T17:00:00+08:00",
    "note": "隔離測試"
  },
  "idempotency_key": "replace-with-one-stable-operation-uuid"
}
```

| State | Required action |
| --- | --- |
| queued | Advance one Tool boundary, inspect the returned state. |
| waiting_user + confirmation_required | Show exact order, receipt amount/type/method/time. Obtain the owner's decision, then call `/confirm` with checked expected version. An Agent must not infer approval from the wait itself. |
| needs_more_criteria / not_found | Ask the smallest clarification; `/clarify` can refine, never replace, original criteria. If intent was wrong, withdraw it and create a corrected Mission. |
| paused / waiting_external | Re-establish source availability, then `/resume` and advance; old confirmation is discarded. |
| blocked | Follow `blocked_by`; inspect and repair actual source. Owner/Admin supplies evidence to `/resolve`; source check must pass. Follow `parent_mission_id` back and revalidate. |
| write_result present, not completed | Receipt exists. Continue this Mission's verification. Never create a replacement payment to recover. |
| canceled | No receipt was written; repeated advance does not write. |

`POST /missions/{id}/cancel` withdraws an unwritten payment intent and appends audit.
It refuses recorded receipts, investigation Missions, and parents with blocking children.
All write actions recheck server-side membership. Cancellation is not a refund.

## Human entry points

- `/calendar?order={order_id}` opens the order's existing detail panel.
- `/missions?mission={mission_id}` opens exactly that persistent Mission.
- Mobile selection puts the selected Mission detail before the list.
- Original request and machine state are under the expandable audit/contract section.
- Read-only roles do not get write controls; price-hidden roles cannot see payment
  Missions. The local harness identity is fixed Owner; production auth rollout is separate.

The calendar's sandbox projection reads the same orders and append-only payments as
Tools. It never overlays demo localStorage edits. Payment status and detailed receipts
refresh from the database after actions and every five seconds while visible. The
Mission distinguishes saved-but-unverified receipts from completed verified work.
Historical Mission totals are labeled as that Mission's check result.

## Running the integrated preview

Start PostgreSQL and `python -m scripts.payment_sandbox` as described in
`PAYMENT_WORKFLOW.md`, retaining its dedicated `bnb_payment_preview_test` database.
Then in `frontend`, start development on loopback port 3000 with:

- `NEXT_PUBLIC_DEMO_MODE=true` (existing synthetic UI identity)
- `NEXT_PUBLIC_PAYMENT_SANDBOX=true`
- `PAYMENT_SANDBOX_ENABLED=true`
- local placeholder `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`

The Next route is a strict loopback proxy to fixed port 8765, with an allowlist of
paths, same-origin/header validation for writes, no caching, and a timeout. It returns
404 unless NODE_ENV is development and the server-only flag is enabled. It never
proxies reset/repair helpers or arbitrary upstream destinations. No public deployment
can reach the fixed-Owner harness through this route.

The standalone harness remains at port 8765 for reset/overlap/retry tests and links
to the integrated calendar. Synthetic freshness can be renewed against the local
source; refreshing a stale checked timestamp still requires normal revalidation.
Production source freshness and Sheet writes are unaffected.


## Final integration verification

A browser-side lost-create-response simulation recovered the same persistent Mission
on refresh, completed exactly one TWD 2,000 payment, and removed the acknowledged retry
key before another payment. Fresh-browser error log was empty after receipt rendering.
The preview was reset to the normal synthetic scenario for owner testing.
