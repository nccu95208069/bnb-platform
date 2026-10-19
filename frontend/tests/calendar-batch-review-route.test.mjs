import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

import { POST } from '../src/app/api/v1/bookings/batch-review/route.ts';

test('a confirmation request cannot reach a Sheet write', async () => {
  const request = new NextRequest('https://os.test/api/v1/bookings/batch-review', {
    method: 'POST', headers: {host: 'os.test', origin: 'https://os.test'},
    body: JSON.stringify({action: 'confirm', property_id: 'sweetfun', ids: ['sheet-00000000000000000000']}),
  });
  const response = await POST(request);
  assert.equal(response.status, 405);
  assert.equal((await response.json()).code, 'UNSUPPORTED_ACTION');
});
