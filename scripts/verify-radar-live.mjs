import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
const base = process.env.RADAR_TEST_URL;
const sha = process.env.RADAR_BUILD_SHA;
if (!base || !sha) throw new Error('Exact deployment URL and SHA required');
const out = process.env.RADAR_EVIDENCE_DIR ?? '/tmp/radar-live';
mkdirSync(out, { recursive: true });
const health = await fetch(base + '/api/radar-preview').then(r => r.json());
assert.equal(health.build, sha);
const post = async (path, body) => {
  const response = await fetch(base + path, { method: 'POST', headers: { Origin: new URL(base).origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(65000) });
  const result = await response.json();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${result.detail}`);
  return result;
};
const website = await post('/api/radar-preview', { phase: 'website', url: 'https://www.sweetfuntw.com/' });
writeFileSync(out + '/website.json', JSON.stringify(website, null, 2));
assert.equal(website.canonicalRooms.length, 6);
assert.ok(website.canonicalRooms.every(room => room.origin === 'website_detail'));
const registry = await post('/api/radar-preview', { phase: 'registry', property: website.property });
writeFileSync(out + '/registry.json', JSON.stringify(registry, null, 2));
const date = new Date(); date.setUTCDate(date.getUTCDate() + 1);
const startDate = date.toISOString().slice(0, 10);
const scans = {};
const platforms = (process.env.RADAR_PLATFORMS ?? 'agoda,booking,trip').split(',');
assert.ok(platforms.every(p => ['agoda', 'booking', 'trip'].includes(p)));
for (const platform of platforms) {
  const { job } = await post('/api/radar-ota', { async: true, platform, startDate, days: 1, adults: 2, property: website.property, canonicalRooms: website.canonicalRooms });
  assert.ok(job?.id);
  let result;
  for (let attempt = 0; attempt < 70; attempt++) {
    const response = await fetch(`${base}/api/radar-ota?job=${encodeURIComponent(job.id)}`, { headers: { 'Sec-Fetch-Site': 'same-origin', 'x-radar-job-token': job.token }, signal: AbortSignal.timeout(20000) });
    result = await response.json();
    if (!response.ok) throw new Error(`job lookup ${response.status}`);
    if (result.state !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  scans[platform] = result;
  writeFileSync(`${out}/${platform}.json`, JSON.stringify(result, null, 2));
  console.log(platform, result.state, result.scan?.state, result.scan?.completedDays);
}
const accepted = Object.values(scans).some(result => result.scan?.observations.some(day => day.identityVerified && day.dateVerified && (day.availability !== 'unknown' || day.rooms.some(room => room.availability !== 'unknown'))));
writeFileSync(out + '/result.json', JSON.stringify({ build: sha, startDate, live: true, acceptedDatedObservation: accepted, coreOtaUat: accepted }, null, 2));
if (!accepted) { console.error('CORE_OTA_UAT_INCOMPLETE: no accepted real dated observation'); process.exitCode = 2; }
