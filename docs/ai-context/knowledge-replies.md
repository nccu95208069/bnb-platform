# Knowledge & Reply Model

## Business-facing concepts

Use simple operator language:

- **回覆主題 / Reply Topic** — what kind of guest question this is
- **回覆內容 / Reply Content** — the actual suggested message

Do not expose “template engine” jargon as a primary UI concept.

## V1 reply modes

- 固定回覆 / Fixed Reply
- 帶入資料 / Data-Inserted Reply
- AI 撰寫 / AI-Written
- 人工處理 / Human Handling

The mode explanation belongs behind a small `?` help affordance instead of a large block of helper text.

## Core policy

> If a standard answer exists, do not generate. If structured data can answer, do not guess. Only let an LLM write freely when controlled answers cannot solve the case.

## Reply Topic schema — conceptual

```json
{
  "id": "bed_size",
  "name": "床的尺寸",
  "description": "Guest asks about bed size or bed type",
  "examples": ["床多大？", "是加大雙人床嗎？"],
  "response_mode": "data_inserted",
  "required_fields": ["reservation.room_no", "room.bed_size"],
  "on_missing_data": "resolve_identity_or_room",
  "reply_content": "您預訂的 {{reservation.room_no}} 房，床尺寸是 {{room.bed_size}} 喔～",
  "allow_extra_information": false
}
```

## Answer scope

Default behavior: answer only what the guest asked.

If the guest asks `我訂哪一間？`, answer the room. Do not append bathtub/window/balcony information unless the business explicitly configured that behavior.

## Property and room data

Prefer structured fields over long prose where possible.

Examples:

- Property: check-in/out time, parking policy, luggage policy, address, access variables
- Room: bed size, window/skylight, bathtub, balcony, floor, occupancy

This lets one reply topic reuse current data instead of hardcoding room-specific wording.

## Sensitive variables

Examples:

- entrance code
- room/keybox code
- Wi-Fi password if treated as sensitive
- bank transfer data

Sensitive values:

- do not belong in general RAG
- should be permission-gated
- should be versioned
- should be re-resolved when a suggestion is applied/sent
- should be masked from normal logs

## Historical knowledge

Historical reply frequency does not define current truth.

Old chats can be used to:

- discover topics
- discover phrasing
- find policy conflicts
- generate candidate answers

But current policy must come from owner-confirmed structured knowledge.

## Knowledge CRUD

Knowledge home should support:

- create topic
- edit topic
- duplicate topic
- delete topic with confirmation
- edit linked Reply Content
- insert structured variables into Reply Content when the mode supports it

## Feedback loop

Store:

- AI suggestion
- final owner response
- selection/rejection/ignore signal when observable
- text diff

Do not immediately fine-tune on every owner edit. First use feedback to improve knowledge, evaluation, style profile and routing diagnostics.