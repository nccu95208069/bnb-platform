# Guest notification status — 2026-09-26

Manual status only; no guest messages are sent. Default is not notified. Month view exposes the control in details; week/day expose it on the right of each booking row. Clicking a checked control revokes the mark. Multi-night and multi-room segments share the source order identity within a property.

The authenticated API is GET/POST /api/v1/guest-notification. Owner, God, admin and housekeeper may write within their property scope; viewers may read. Server checks an active source booking before writing. Data lives separately from Sheet imports in the existing OS Redis store. Each write atomically compares the previous version, stores the new status and appends an audit event with account, role, server time and before/after states. Readback verifies completion. Polling cannot replace a newer local version with an older response.

Validation: 168 frontend tests passed; TypeScript and production build passed; lint has no errors and two existing unused-symbol warnings. Synthetic browser acceptance covers week mark, day shared state, month detail revoke, no accidental detail opening and desktop/mobile layout. Browser network fixtures are synthetic; server persistence/CAS and authorization are separately tested with a Redis protocol mock. No real guest was marked during acceptance.

Code review: checked server-side property/role enforcement, origin protection, version conflicts, audit atomicity, cancellation rejection, shared identity, accessible sibling buttons and four-language labels. No critical findings. This change is based on the deployed calendar baseline and excludes the separate console work.
