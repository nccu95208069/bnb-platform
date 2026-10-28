import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sameSourceInstant, validSourceRecordedAt } from '../src/finance-source-time.mjs';

test('historical source time preserves microsecond identity across time zones', () => {
  const original = '2026-10-16T18:46:54.590172+08:00';
  assert.equal(validSourceRecordedAt(original), true);
  assert.equal(sameSourceInstant('2026-10-16T10:46:54.590172Z', original), true);
  assert.equal(sameSourceInstant('2026-10-16T10:46:54.590173Z', original), false);
  assert.equal(sameSourceInstant(new Date('2026-10-16T10:46:54.590Z'), original), false);
  assert.equal(validSourceRecordedAt('2026-10-16T18:46:54.5901721+08:00'), false);
});
