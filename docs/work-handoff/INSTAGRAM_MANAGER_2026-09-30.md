# Instagram customer-manager cards

Status: frontend and compatible backend deployed; IG receipt remains disabled
pending Meta readiness and observed receipt. A bounded daily credential renewal
job is enabled; its first real provider refresh remains pending.

The existing Daili bridge accepts provider metadata from the authenticated backend
queue. IG cards identify the source, show the reply deadline, and warn that history
and attachments may be incomplete. Expired cards remain visible for a decision and
cannot be approved, including through batch approval. Both edit and approval paths
enforce the backend's 1,000 UTF-8 byte text limit. A queued approval that expires
returns to owner review rather than being sent.

Guest sending remains an explicitly approved operation. The backend is authoritative
for exact account/property routing, message snapshot, current response window and
send idempotency. Successful IG acceptance is labeled Instagram; it does not claim
the guest has read the message. Internal IG reservation association uses the backend's
`SKIPPED` LINE-sheet writeback result without claiming a LINE contact was updated.

Changed modules:

- `frontend/src/lib/host-agents/daili.mjs`
- `frontend/src/lib/host-agents/manager-inbox.mjs`
- `frontend/src/lib/host-agents/manager.mjs`

JavaScript syntax, scoped ESLint, 4 synthetic IG manager tests and the Next.js
production build passed. Frontend code `f034ac9` was deployed and promoted as
`dpl_9G6u4wUNTWWKV9V9ufRHPzo3Z1kJ`. Anonymous manager page/API checks confirmed
login redirection and 401 rejection; deployment protection remains enabled.

The backend migration, encrypted credential registration and rollout completed.
Existing LINE counts were unchanged, and the IG table is private. The global IG
flag is still off. No external guest messages were sent. Meta publication/webhook
activation, verified token renewal and observed IG receipt remain outstanding.
Historical DM import is not implemented; the existing backlog was not synchronized.

Do not push this branch to the public repository until the existing publication
approval is resolved. The unrelated LINE OA handoff document is outside this change.

## Approved public policy publication

The owner supplied the public support contact and approved the exact privacy and
data-deletion draft. Static pages `frontend/public/privacy.html` and
`frontend/public/data-deletion.html` were deployed in `dpl_CmHho2vFtt8zm1eEBLENnpvb83Cb`
(code `4c2531d`), with anonymous HTTP 200 from the primary production domain
`https://sweetfun-os.vercel.app`.

Meta still rejected the deletion URL and its Sharing Debugger reported HTTP 403.
Vercel showed no custom rules or active bot protection; its one denied request
concerned a different deployment hostname. Explicit crawler rules for only the
two policy pages were deployed in `dpl_G1uGGEaX4RYrwMqqCoYcT23TDvhu` (code
`6e5f61d`); build, TypeScript and public robots readback passed. This did not
resolve Meta's 403. No firewall, authentication or deployment protection was
disabled. The same approved pages are being served by the existing backend to
provide an independently reachable policy endpoint.
