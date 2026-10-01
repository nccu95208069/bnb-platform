# Manager no-reply recovery

The backend previously reported internal closure failures as changed content.
This left a review in the queue despite the owner's no-reply decision.

Deploy the reviewed backend dismissal fix before this manager release. On normal
queue scans, a previously rejected no-reply or clear-all action is recovered once
when its exact snapshot and owner binding remain current. A later action or new
snapshot prevents recovery. The existing authenticated no-reply endpoint and
original decision ID perform the operation; there is no direct data rewrite.

Blocked closures remain visible with an accurate explanation. A successful
closure removes this turn only; future guest input is still processed.

JavaScript syntax and scoped ESLint passed. No tests were added or run for this
fix. Deployment and observed recovery are recorded after rollout. Do not push
the public repository without the owner's separate authorization.
