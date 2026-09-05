# Workspace access and stay-service fields

## Roles

| Role | Manage members | Edit bookings | Record payments | Cancel bookings | View prices |
|---|---:|---:|---:|---:|---:|
| Owner | Yes | Yes | Yes | Yes | Yes |
| Admin | No | Yes | Yes | Yes | Yes |
| Housekeeper | No | Yes | Yes | No | Yes |
| Viewer | No | No | No | No | Yes |
| Viewer without prices | No | No | No | No | No |

The owner assigns a role and either all properties or an explicit property scope. Email and E.164 phone number are accepted as account identifiers. An invited member is activated only after the authenticated Supabase user claims an invitation with a matching verified email or phone number.

## Stay-service fields

Operational requirements are structured fields rather than a single note:

- `extra_guest_count`
- `extra_bed_count`
- `pet_count`
- `baby_supplies` (array; e.g. crib, baby bath, sterilizer, bed rail, high chair)
- `service_note` for free-form details

The UI may render a compact summary inside a note-like section, but structured values remain queryable and auditable.

## Multi-night presentation

A stay remains one continuous interval (`check_in` inclusive, `check_out` exclusive). Calendar views should show:

- Month: start / continuation / final-night segments with progress, not unrelated one-night chips.
- Week: a single horizontal band spanning all occupied nights visible in the window.
- Day: explicit arrival, continuing-stay progress, or departure state.
