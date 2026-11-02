// Synthetic loopback fixture for GCO's provider-free wire acceptance.
// Never loads a database, provider, real LINE identity or deployment credential.
import { MemoryPropertyRepository } from '../../src/memory-repository.ts';
import { IronGateService } from '../../src/service.ts';
import { createHandler } from '../../src/http.ts';
import { createNodeServer } from '../../src/node-server.mjs';
import { createGrantAuthenticator } from '../../src/authenticator.mjs';
import { createRuntimeLineProof } from '../../src/line-proof-routing.mjs';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const propertyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const roomId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const grantId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const otherPropertyId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const grant = { credentialId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', workspaceId,
  propertyId, grantId, authorityEpoch: 1, clientId: 'synthetic-offland',
  subjectId: 'synthetic-line', origin: 'line', lineGroupId: 'group', lineActorIds: ['owner'],
  lineCreateEnabled: true, lineManageAllEnabled: true, lineProviderFreeEnabled: true,
  actions: ['booking:read', 'booking:create', 'booking:amend', 'booking:cancel', 'booking:manage_all'],
  fields: ['guest_name', 'contact', 'notes', 'money'] };
const repository = new MemoryPropertyRepository();
const initial = { workspaceId, propertyId, roomIds: [roomId], authorityEpoch: 1,
  version: 1, readOnly: false, channel: { mode: 'none', ready: false, websiteSalesEnabled: false,
    grantId: null, websiteBindingId: null, lineBookingMode: 'provider_free', lineBookingGrantId: grantId },
  sourceGrants: [], bookings: [], sourceLinks: [], operations: [], receipts: [], fences: [], manualBlocks: [] };
repository.seed(initial);
repository.seed({ ...structuredClone(initial), propertyId: otherPropertyId });
const otherInitial = JSON.stringify(await repository.read(otherPropertyId));
const { verifyLineOperator, linePreviewSecret } = createRuntimeLineProof({
  IRON_GATE_LINE_PROOF_SECRET: 'p'.repeat(43),
  IRON_GATE_OFFLAND_LINE_BOOKING_PROOF_SECRET: 'q'.repeat(43),
  IRON_GATE_OFFLAND_LINE_BOOKING_CREDENTIAL_ID: grant.credentialId,
  IRON_GATE_OFFLAND_LINE_BOOKING_GRANT_ID: grant.grantId,
  IRON_GATE_OFFLAND_LINE_BOOKING_PROPERTY_ID: propertyId,
});
const service = new IronGateService(repository, linePreviewSecret);
const auth = createGrantAuthenticator({ lookup: async token => token === 'o'.repeat(43) ? grant : null },
  repository, null, verifyLineOperator);
const handle = createHandler(service, auth);
const server = createNodeServer(async request => {
  const path = new URL(request.url).pathname;
  if (path === '/fixture-state' && request.method === 'GET') {
    const state = await repository.read(propertyId);
    return Response.json({ bookings: state.bookings.length,
      active: state.bookings.filter(b => ['confirmed', 'held'].includes(b.status)).length,
      cancelled: state.bookings.filter(b => b.status === 'cancelled').length,
      receipts: state.receipts.length, operations: state.operations.length,
      fences: state.fences.length, manualBlocks: state.manualBlocks.length,
      linePending: state.bookings.reduce((n, b) => n + (b.lineChannelPending?.length ?? 0), 0),
      otherPropertyUnchanged: JSON.stringify(await repository.read(otherPropertyId)) === otherInitial });
  }
  return handle(request);
});
server.listen(0, '127.0.0.1', () => process.stdout.write(JSON.stringify({ base: `http://127.0.0.1:${server.address().port}` }) + '\n'));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
