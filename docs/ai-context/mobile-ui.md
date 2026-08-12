# Mobile UI/UX — V1

## Platform strategy

- iOS first.
- Android and Web should reuse the same information architecture and core interaction model later.
- The product must be usable while the owner is moving around; replying is not a desktop-only task.

## Bottom navigation

V1 keeps only three tabs:

1. 收件夾 / Inbox
2. 知識庫 / Knowledge
3. 設定 / Settings

Do not add a separate Traveler tab in V1.

## Inbox

Each conversation row should prioritize quick operational recognition:

- guest avatar
- label like `8/13 101 Rou柔`
- latest-message preview
- time
- unread count
- minimal workflow status: 待處理 / 處理中 / 已結束

The date/room part should be derived from structured reservation state after identity binding, not treated as a permanent person name.

## Conversation screen

### Header

Show the user/conversation name prominently at the top, similar to the existing LINE OA mental model.

### Booking summary

Keep booking information compact and collapsible.

Examples:

- single room: `8/12–8/14｜201房`
- same-date multi-room: `8/12–8/14｜201房＋1`
- complex mixed stays: `2筆住宿訂單`

Do not permanently occupy a large area with full booking details.

Expanded state may show:

- check-in/out
- room / room type
- platform
- booking number
- guest name
- price when operationally useful

### Notes

Provide a visible `查看備註` entry.

Notes support:

- phone-call context
- special requests
- manual booking/identity confirmations
- reservation-specific exceptions
- internal reminders

### Chat direction

- guest messages: left
- owner messages: right
- AI suggestion: separate component, not a chat bubble

### AI suggestion lifecycle

- Default: show only **one most relevant suggestion** for the latest guest message.
- When a new guest message arrives, the previous suggestion becomes stale and a new round is generated.
- Multi-intent may justify more than one suggestion.
- Tap suggestion → insert into input → owner edits if needed → owner sends.
- Never auto-send in V1.

## Identity prompt in chat

Do not immediately jump into a full-screen identity workflow.

Use a compact banner such as:

`尚未綁定訂單 [辨識旅客]`

If a strong candidate already exists:

`可能是：8/12–8/14｜201房｜Peichen [確認]`

## More Actions bottom sheet

Keep it lean:

- 查看備註
- 查看訂單資訊
- 重新辨識訂單
- 加入標籤
- 取消

## Knowledge UI

Use business-friendly terms:

- 回覆主題 = question/topic category
- 回覆內容 = actual suggested reply text

Do not make “Template” the primary UI noun.

Knowledge list rows should expose `…` with:

- 編輯
- 複製
- 刪除

Deletion requires confirmation.

### Edit Reply Topic

Fields:

- 主題名稱
- 問題例句 / 關鍵字 (optional)
- 回覆模式 `?`
- linked reply content
- 儲存

Keep Reply Mode explanations behind the `?` icon rather than showing long helper paragraphs.

### Reply modes

V1 UI labels:

- 固定回覆
- 帶入資料
- AI 撰寫
- 人工處理

### Language

Do not display language controls in V1 main flows. Future multilingual controls may live under Settings/Advanced.

## Settings — MVP Lean

Keep only:

- LINE connection
- Google Sheet connection
- Notifications
- Sensitive data / access codes
- Account/basic sign-out

Do not add model selector, analytics center, broad automation settings, or heavy permission management unless a real V1 blocker appears.

## Mockup delivery rule

For design review, deliver complete phone screens one by one. Overview boards are supplementary only. No cropped or half-hidden screens.