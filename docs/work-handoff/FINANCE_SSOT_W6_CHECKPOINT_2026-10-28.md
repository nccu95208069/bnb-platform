# Finance SSOT W6 candidate — 2026-10-28

This branch adds the first Sweetfun batch Sheet adapter. It is stacked on the W4 booking guard branch. No production workbook, connector, finance grant, migration, or writer flag was changed. The new endpoint and five-minute scan remain disabled unless both `FINANCE_SHEET_BULK_ENABLED=true` and `OS_SWEETFUN_FINANCE_SSOT_ENABLED=true` are set with the dedicated configuration below.

## What this candidate does

- A dedicated Google workbook has `批次輸入` plus five protected output tabs. The provisioning script accepts an existing **private workbook without the target tabs**, adds the tabs and protection, and reads the result back. It does not register or enable a finance connector. The first `批次輸入` tab has 20 fixed columns; Google Sheets protection covers headers, `row_id`, `base_version`, `sync_status`, `error_code`, `accepted_hash`, and `event_id`. Each other tab is protected. A user must still be granted access by the workbook owner; this branch does not share a workbook.
- The scanner reads the registered spreadsheet ID and sheet ID, checks its Taipei timezone, exact headers, grid and protected columns, and assigns a stable UUID to each new business row. A Sheet row number is never the ledger identity. The submitted source key is `sheet:<spreadsheet ID>:<row UUID>`. Iron Gate independently checks that the prefix matches the connector's registered `source_sheet_ref`. Every Sheet commit also asks Iron Gate for an authenticated connector preview and compares its source instance, source system and workbook reference with the private frontend registration, including on expense rows without a booking.
- The OS screen at `/finance/sheet-bulk` shows all material fields, issues and new rows. The operator selects up to ten safe rows after a signed 15-minute preview. Commit re-reads the workbook, current ledger and booking versions; a changed row or booking invalidates approval. It uses a deterministic request key for each row version, confirms the Iron Gate receipt, then projects accepted version and event ID back to the Sheet. A lost response stays unknown until the original receipt is checked. A confirmed ledger write is never reversed because Sheet projection failed.
- The five-minute cron assigns pending row IDs and repairs projection from the canonical ledger. It cannot submit a money command. A review issue makes the cron return an error for operational monitoring. It only reports row numbers and issue codes in the response; the ledger and Sheet stay private.
- New Sheet content supports receipt and paid expense create/amend/void. Room/deposit must use an exact Iron Gate booking UUID; expense month allocation uses integer cents. It rejects cross-property display, changed protected fields, duplicate IDs, formulas, unsafe free text, unknown dates and stale versions. Other payment types and multi-order allocations remain outside this first Sheet input schema.

## Configuration before an isolated test

Use a workbook and service account dedicated to one property. The service account needs edit access only to that workbook. Do not reuse the old Sweetfun calendar workbook or Google credential. In `frontend`, run:

```text
node --experimental-strip-types scripts/provision-finance-sheet-bulk.mjs SPREADSHEET_ID CREDENTIAL_ENV "水芳 Sweetfun" --check
node --experimental-strip-types scripts/provision-finance-sheet-bulk.mjs SPREADSHEET_ID CREDENTIAL_ENV "水芳 Sweetfun" --apply
```

The script reads `CREDENTIAL_ENV` from the process environment and never prints its contents. It requires the workbook timezone to be `Asia/Taipei` and refuses to add another copy if any target tab already exists. Save the returned input tab `sheetId` in private configuration. The dedicated `iron_gate.finance_connector` must be `source_system=sheet_bulk`, have `source_sheet_ref` equal to the registered spreadsheet ID, and be bound to the one property's OS grant. Keep `cutover_at` null and the finance flags off until W7's source-by-source reconciliation.

The frontend expects these private settings, alongside its existing Iron Gate calendar configuration:

| Setting | Meaning |
| --- | --- |
| `FINANCE_SHEET_BULK_ENABLED` | Sweetfun batch adapter gate; default off |
| `OS_SWEETFUN_FINANCE_SSOT_ENABLED` | Overall Sweetfun finance gate; default off |
| `FINANCE_SHEET_BULK_SPREADSHEET_ID`, `FINANCE_SHEET_BULK_SHEET_ID` | Registered workbook and `批次輸入` tab |
| `FINANCE_SHEET_BULK_GOOGLE_CREDENTIAL_ENV` | Name of the dedicated private Google credential environment variable |
| `FINANCE_SHEET_BULK_PREVIEW_SECRET` | At least 32 characters, separate from Google and Iron Gate credentials |
| `IRON_GATE_SWEETFUN_SHEET_BULK_GRANT` | Dedicated property-scoped OS finance grant JSON |
| `IRON_GATE_SWEETFUN_SHEET_BULK_SOURCE_INSTANCE_ID` | UUID of the registered `sheet_bulk` connector |
| `IRON_GATE_SWEETFUN_SHEET_BULK_SCAN_TOKEN` | Read-only ledger token for the cron; separate from the write grant |

## Local verification and open gates

- Frontend TypeScript and changed-file ESLint passed. Focused tests cover row identity, content and booking version drift, signed preview across time, voided Sheet projection, protected workbook reads and write readback, plus the OS bridge conflict behavior. The local production build is not verified: Turbopack refuses the worktree's external `node_modules` symlink, and the webpack fallback cannot reach `fonts.googleapis.com` in this sandbox.
- The isolated PostgreSQL finance test passed with a registered synthetic Sheet connector, a same-workbook command and a rejected wrong-workbook source key. No production data was used.
- The workbook has not yet been provisioned or edited in a real Google account. The route, Google API, cron and Iron Gate grant have not been exercised end to end in an isolated property. The five output tabs are protected placeholders; their full Iron Gate read-model projections and a persisted daily full-book reconciliation are still to be implemented. The live W0 source snapshot, cross-source duplicate mapping, source watermarks, Sheet projection lag and W7 cutover remain open. Keep the writer off and do not describe this candidate as production-ready.
- The present ledger scan reads at most 20,000 events per request. Before widening beyond the first small property, add a source-filtered paginated ledger view or a bounded `finance_change` cursor and test it with a larger history.
