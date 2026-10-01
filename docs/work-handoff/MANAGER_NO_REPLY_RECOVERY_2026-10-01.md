# Manager no-reply recovery

The backend previously reported internal closure failures as changed content.
This left a review in the queue despite the owner's no-reply decision.

Deploy the reviewed backend dismissal fix before this manager release. At the beginning of normal sync, a previously rejected no-reply or clear-all action is recovered once
when its exact saved snapshot and owner binding remain current. The backend rereads and
validates that snapshot against current input. A later action or changed local
snapshot prevents recovery; newer upstream input fails the backend guard. The existing authenticated no-reply endpoint and
original decision ID perform the operation; there is no direct data rewrite.

Blocked closures remain visible with an accurate explanation. A successful
closure removes this turn only; future guest input is still processed.

JavaScript syntax and scoped ESLint passed. No tests were added or run for this
fix. Deployment and observed recovery are recorded after rollout. Do not push
the public repository without the owner's separate authorization.

## Release

- Backend `739df82` is at 100% traffic in
  `bnb-reply-copilot-manager-dismiss-739df82` before recovery activation.
- Frontend `5eae21b` deployed as `dpl_5UH2AFAykDBFuN6d26WzrLUoifoa`.
  Next.js/TypeScript production build passed; promotion succeeded and
  `sweetfun-os.vercel.app` resolves to this release. Anonymous status returns
  `login_required`. No public Git push was performed.
- Actual recovery is being observed through the normal scheduler and audit rows.
