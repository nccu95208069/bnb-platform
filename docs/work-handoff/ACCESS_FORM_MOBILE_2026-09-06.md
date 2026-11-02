# Access form navigation — 2026-09-06

The top Add user button previously reset an already visible form without moving
to it. On mobile this appeared to do nothing. Add and Edit now focus the name
input during the tap and scroll the form below the fixed header. This also works
inside the desktop main scroll container. Saving resets the form without opening
the keyboard again.

The demo page and save confirmation explicitly state that members are stored in
this browser only; they do not create production login accounts. Owner private
calendar credentials are separate and unchanged.

Validation: frontend lint and production build passed. Browser checks at 390×844
and desktop confirmed name focus and form positioning at 64px and 24px respectively.
Starting again cleared an unsaved synthetic draft. No member was created.
Physical iPhone keyboard behavior still needs the owner's device check.
