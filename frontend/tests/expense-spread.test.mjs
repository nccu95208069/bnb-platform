import test from 'node:test';import assert from 'node:assert/strict';
import {spreadMonths,equalSpread,validateSpread} from '../src/lib/expense-spread.ts';
test('average allocation handles cents and December rollover exactly',()=>{const months=spreadMonths('2026-12','2027-02');assert.deepEqual(months,['2026-12','2027-01','2027-02']);const rows=equalSpread(10000,months);assert.deepEqual(rows.map(r=>r.amount_cents),[3334,3333,3333]);assert.deepEqual(validateSpread(rows,'expense',10000),rows);assert.deepEqual(spreadMonths('2026-09','2026-08'),[]);});
