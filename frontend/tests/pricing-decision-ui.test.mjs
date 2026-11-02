import test from 'node:test';
import assert from 'node:assert/strict';
import {PricingDecisionDetails} from '../src/components/calendar/pricing-decision-details.tsx';
import {mount} from './helpers/customer-dom.mjs';
test('protected date renders no invented base or adjustment and keeps audit provenance',async t=>{
 const decision={run_id:'synthetic-protected-run',source_version:'input-v1',base_price:null,target_price:10000,published_price:null,
  adjustment_pct:null,probability:null,reason:'holiday_or_eve',model_version:'model-v1',policy_version:'policy-v1',
  calculated_at:'2026-10-07T09:00:00.000Z',published_at:null,observed_at:'2026-10-07T09:00:00.000Z',publish_status:'skipped'};
 await mount(t,PricingDecisionDetails,{decision});
 const section=document.querySelector('[aria-label="定價決策紀錄"]');assert.ok(section);
 assert.match(section.textContent,/已跳過・未發布/);assert.match(section.textContent,/未定義/);
 assert.match(section.textContent,/synthetic-protected-run/);assert.match(section.textContent,/holiday_or_eve/);
 assert.doesNotMatch(section.textContent,/NaN|發布當時已核對/);
});
