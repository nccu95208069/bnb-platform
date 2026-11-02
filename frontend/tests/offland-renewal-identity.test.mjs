import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPair, SignJWT } from 'jose';
import { authorizedRenewal, RENEWAL_AUDIENCE, RENEWAL_IDENTITY } from '../src/lib/offland-renewal-identity.ts';
const pair = await generateKeyPair('RS256');
async function signed(changes = {}, key = pair.privateKey) {
  const now = Math.floor(Date.now()/1000);
  return 'Bearer ' + await new SignJWT({ iss: 'https://accounts.google.com', aud: RENEWAL_AUDIENCE,
    sub: '123456789012345678901', email: RENEWAL_IDENTITY, email_verified: true,
    iat: now, exp: now+3600, ...changes }).setProtectedHeader({alg:'RS256'}).sign(key);
}
test('only verified maintenance identity and audience may exercise the read adapter', async () => {
  assert.equal(await authorizedRenewal(await signed(), async()=>pair.publicKey), true);
  for (const changes of [{email:'other@example.com'}, {email_verified:false}, {aud:'other'},
    {iss:'https://attacker.example'}, {sub:undefined}, {exp:1}, {iat:1}]) {
    assert.equal(await authorizedRenewal(await signed(changes), async()=>pair.publicKey), false);
  }
});
test('missing, malformed and wrong-key signatures fail closed', async () => {
  for (const value of [null, '', 'Bearer nonsense', 'Bearer '+'x'.repeat(9000)])
    assert.equal(await authorizedRenewal(value, async()=>pair.publicKey), false);
  const other = await generateKeyPair('RS256');
  assert.equal(await authorizedRenewal(await signed({},other.privateKey), async()=>pair.publicKey), false);
});
