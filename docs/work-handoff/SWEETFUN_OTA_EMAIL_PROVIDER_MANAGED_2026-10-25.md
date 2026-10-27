# Sweetfun OwlNest email orders: provider manages OTA inventory

On 2026-10-25 the owner clarified the operational rule: an OwlNest OTA booking email
arrives after OwlNest has already closed the relevant rooms. Iron Gate should mirror
the confirmed order, amendment, or cancellation into OS occupancy and should not
send a second OwlNest inventory write or wait for the manual channel claim.

The previous source path queued a channel operation for a signed Gmail new order.
That made a subsequent notice for the same already-created order appear under
review when an unrelated manual room operation held the property dispatch claim.
This was a false coupling between incoming OTA mail and manual room controls.

The correction scopes the provider-managed path to the bound Gmail writer and
an OwlNest order ID with Gmail's aligned Owlting DKIM/DMARC evidence. A new order
still needs its exact OTA alias and amount and still passes duplicate identity
and local occupancy checks. Signed amendments and cancellations update local
occupancy without channel operations. Unsigned or ambiguous notices remain for
review. Generic Sheet source events and manually created direct bookings keep
their existing channel safeguards.

Historical pending operations created by the earlier Gmail path require a
separate, guarded retirement. The source-controlled transaction generator
`iron-gate/scripts/retire-gmail-source-channel-operations.mjs` accepts a private
manifest, checks the exact booking, source link, receipt, operation, fence,
occupied nights, and lack of a target dispatch claim, then marks only that
operation `retired_source_managed`. It clears its channel fence and booking
sync flag. It preserves any separate source-review fence and never calls OwlNest.
An unprocessed later notice must be replayed from the original Gmail message
after its source evidence is reviewed; retiring the old operation does not
pretend the later notice was applied.

Release order: deploy Iron Gate's signed provider-managed handling, deploy the
Gmail writer that attaches the same evidence to amendments/cancellations,
recheck the live property snapshot, dry-run the exact retirement transaction,
then apply it only with a current version and explicit release authorization.
The Gmail runtime has its own paused-ingress cutover and rollback gate. Report
code, PR, deployed runtime, historical retirement, and mail replay separately.
