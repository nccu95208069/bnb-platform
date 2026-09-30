# Instagram customer-manager cards

Status: frontend and compatible backend deployed; Meta is published and the IG
callback/account subscriptions are active. The Instagram Login signing secret was
corrected and real Meta redelivery now succeeds. The test's incoming question and
draft are verified in the manager, waiting for owner approval. A bounded daily credential renewal
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
Existing LINE counts were unchanged, and the IG table is private. The IG flag is
enabled on the verified backend callback revision. Meta publication, callback
verification and minimal `messages,message_edit` subscriptions are complete.
The owner sent the requested test DM. Using the Instagram Login app's own secret
resolved the signature failure; Meta redelivery returned 200. No outgoing guest
messages were sent. Verified token renewal and owner-approved outgoing delivery remain outstanding.
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
disabled. The same approved pages are also served by the existing backend; Meta returned
HTTP 200 for both. The owner approved the exact replacement URLs. Meta saved both and the contact
email; a full reload confirmed persistence. Publication readiness reports all
required basic settings complete. Own-business development may skip advanced App
Review according to the Instagram setup notice. This exception does not cover
onboarding other businesses.

The crawler experiment was reverted in `faa3e9b`, deployed as
`dpl_GmFqki1sQ8c8q38jzXDgNNsXriLR`; the original crawler behavior is restored.
Production build and TypeScript passed. The two public policy pages remain.

The owner explicitly approved the local verification-value transfer and Meta
publication/message subscriptions. The earlier automatic review block was resolved
by that grant; the one-use loopback handoff completed without logging the value.
The manager UI confirms the property's monitoring and owner LINE binding are active.
Meta now exposes existing conversations through a bounded metadata read, but history
import remains unimplemented. Incoming receipt and the manager review card are
observed; an owner-approved outgoing reply remains unverified. The owner completed the required
Meta password reauthentication; its private secret transfer is complete.

## Latest-message polling

The first successful test delivery was followed by a poll during the backend's
30-second burst-settling interval. The bridge then advanced through older pages,
delaying the new card until the next full pass. Each sync now reads the newest
page first and, if enough execution time remains, one older page. The older-page
cursor is retained when only the newest page fits. Requests remain bounded and
owner approval is unchanged. A synthetic IG regression covers a message becoming
ready on the second poll, with zero sends; all five IG manager tests passed.
JavaScript syntax and scoped ESLint passed. Code `f2227f8` was built with TypeScript
and all 48 pages, deployed as `dpl_DfgLEKhs2ug8QJx8hkS5qX9r3ppX`, and promoted.
Inspecting the owner's `sweetfun-os.vercel.app` domain resolves to that deployment.
The unauthenticated manager API still returns `login_required`; deployment
protection was preserved. No public Git repository push was made.

The first new cron run returned 200 at 16:49 UTC. The real IG test question and
checkout-time draft are now visible under Sweetfun with an enabled approval
button. Owner approval for that specific test reply is pending. No guest message
was sent by the agent, and the older inbox was not imported.
