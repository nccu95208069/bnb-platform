/* eslint-disable @typescript-eslint/no-require-imports -- Node CJS acceptance runner loads isolated browser dependencies. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { chromium, request, webkit } = createRequire('/tmp/radar-browser/package.json')('playwright');

const base = process.env.RADAR_TEST_URL || 'http://localhost:3137';
const out = process.env.RADAR_EVIDENCE_DIR || '/tmp/radar-evidence';
fs.mkdirSync(out, { recursive: true });
const browsers = [];
const rooms = [
  ['101', '101 河景四人房', 4],
  ['102', '102 侘寂雙人房', 2],
  ['201', '201 河景雙人房', 2],
  ['202', '202 侘寂四人房', 4],
  ['301', '301 河景雙人房', 2],
  ['302', '302 天窗雙人房', 2],
].map(([id, name, capacity]) => ({ id, name, sourceName: name, sourceUrl: `https://www.sweetfuntw.com/zh/stay/${id}`, roomNumber: id, capacity, bundle: false, features: [], origin: 'website_detail', editable: true }));

const website = {
  analysisId: 'browser-fixture', analyzedAt: new Date().toISOString(), requestedUrl: 'https://www.sweetfuntw.com/', finalUrl: 'https://www.sweetfuntw.com/zh',
  property: { name: '水芳 Sweetfun', sourceUrl: 'https://www.sweetfuntw.com/zh', websiteHost: 'www.sweetfuntw.com', address: '新北市瑞芳區東和里中山路24-1號', registrationNumber: '新北市民宿402號', phone: '0973400562', identityStatus: 'review', confidence: .7 },
  identityEvidence: [], canonicalRooms: rooms,
  platformSources: [
    { platform: 'official', label: '官網', status: 'discovered', sourceUrl: 'https://www.sweetfuntw.com/', identityEvidence: [], rooms: [], message: '官網' },
    { platform: 'booking', label: 'Booking.com', status: 'identity_review', sourceUrl: 'https://www.booking.com/hotel/tw/shui-fang-sweetfun-rui-fang-jiu-fen.zh-tw.html', identityEvidence: [], rooms: [], message: '' },
    { platform: 'agoda', label: 'Agoda', status: 'adapter_pending', identityEvidence: [], rooms: [], message: '' },
    { platform: 'trip', label: 'Trip.com', status: 'identity_review', sourceUrl: 'https://tw.trip.com/hotels/new-taipei-city-hotel-detail-133359377/sweet-fun/', identityEvidence: [], rooms: [], message: '' },
  ], dateWindow: { start: '2026-09-08', end: '2026-09-21', days: 14 }, warnings: [],
};
const registry = {
  status: 'matched', sourceUrl: 'https://data.gov.tw/dataset/7780', selectedHotelId: 'Hotel_A15010000H_035813', message: '唯一高信心候選',
  candidates: [{ hotelId: 'Hotel_A15010000H_035813', registrationNumber: '新北市民宿402號', name: '水芳', matchedName: '水芳', address: '新北市瑞芳區中山路24之1號', phone: '0973400562', totalRooms: 5, score: .846, status: 'confirmed', evidence: [], conflicts: [], platformUrls: {} }],
};
function addDays(value, amount) { const date = new Date(`${value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + amount); return date.toISOString().slice(0, 10); }
function otaResponse(platform, body) {
  const dates = Array.from({ length: 14 }, (_, i) => addDays(body.startDate, i));
  const identity = { platform, sourceUrl: platform === 'booking' ? website.platformSources[1].sourceUrl : platform === 'trip' ? website.platformSources[3].sourceUrl : 'https://www.agoda.com/sweetfun-101/hotel/taipei-tw.html', sourceName: platform === 'booking' ? '水芳瑞芳-九份' : platform === 'trip' ? '水芳瑞芳' : '水芳 Sweetfun', sourceRegistrationNumber: platform === 'agoda' ? undefined : '新北市民宿402號', score: .94, status: 'confirmed', evidence: ['測試 fixture'] };
  const observations = dates.map((stayDate, index) => {
    if (platform === 'agoda') {
      const roomRows = rooms.filter(room => room.id !== '102').map((room, roomIndex) => {
        const sold = (index + roomIndex) % 4 === 0;
        return { sourceRoomId: `agoda-${room.id}`, sourceRoomName: `水芳 Sweetfun ${room.id}`, canonicalRoomId: room.id, availability: sold ? 'sold_out' : 'available', quantityState: 'unknown', amount: sold ? undefined : 2400 + roomIndex * 420 + index * 50, currency: 'TWD', sourceText: sold ? 'Sold out' : 'dated offer' };
      });
      return { stayDate, checkOut: addDays(stayDate, 1), state: 'ready', availability: roomRows.some(room => room.availability === 'available') ? 'available' : 'sold_out', minAmount: Math.min(...roomRows.map(room => room.amount).filter(Boolean)), currency: 'TWD', sourceUrl: identity.sourceUrl, identityVerified: true, dateVerified: true, rooms: roomRows, message: 'Agoda 日期已核對' };
    }
    return { stayDate, checkOut: addDays(stayDate, 1), state: 'partial', availability: 'unknown', sourceUrl: identity.sourceUrl, identityVerified: true, dateVerified: platform === 'trip', rooms: platform === 'booking' ? [{ sourceRoomId: 'booking-1', sourceRoomName: 'Executive Quadruple Room with River View', availability: 'unknown', quantityState: 'unknown' }] : [], message: platform === 'booking' ? '日期未能驗證' : '日期已核對，價格未公開' };
  });
  const scan = { platform, state: platform === 'agoda' ? 'ready' : 'partial', capturedAt: new Date().toISOString(), requestedDays: 14, completedDays: platform === 'booking' ? 0 : 14, identity, observations, warnings: [platform === 'agoda' ? 'Agoda 未公開可靠待售間數。' : `${platform} 沒有可採用的逐日價格。`], durationMs: 1200 };
  return { scan, capability: { source: 'isolated_browser', live: true, physicalInventory: false, confirmedBookings: false } };
}
async function installMocks(page) {
  await page.route('**/api/radar-preview', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { version: 'test' } });
    const body = route.request().postDataJSON();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body.phase === 'website' ? website : registry) });
  });
  await page.route('**/api/radar-ota', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { live: true } });
    const body = route.request().postDataJSON();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(otaResponse(body.platform, body)) });
  });
}

async function run() {
  const browser = await chromium.launch(); browsers.push(browser);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await installMocks(page);
  await page.goto(base + '/radar-test');
  assert.equal(await page.getByRole('button', { name: '載入完整範例' }).count(), 0);
  await page.getByRole('button', { name: '開始分析' }).click();
  await page.getByRole('heading', { name: '未來 14 天價格與可售狀態' }).waitFor();
  await page.getByText('NT$2,400').first().waitFor();
  await page.getByRole('button', { name: '開始分析' }).waitFor();
  assert.equal(await page.getByRole('heading', { name: '水芳 Sweetfun' }).count(), 1);
  assert.equal(await page.getByText('住宿已核對').count(), 1);
  assert.equal(await page.locator('table').first().locator('tbody tr').count(), 6);
  assert.match(await page.locator('table').first().innerText(), /NT\$2,400/);
  assert.match(await page.locator('table').first().innerText(), /房型已辨識/);
  assert.match(await page.locator('table').first().innerText(), /日期已核對/);
  await page.getByRole('button', { name: /Agoda/ }).click();
  await page.getByRole('heading', { name: 'Agoda' }).waitFor();
  assert.equal(await page.locator('table').last().locator('thead th').count(), 15);
  assert.ok(await page.locator('[aria-label="有房"]').count() > 0);
  assert.ok(await page.locator('[aria-label="售完"]').count() > 0);
  await page.getByRole('button', { name: '編輯民宿資訊' }).click();
  const roomInput = page.getByLabel('101 河景四人房 房型名稱');
  await roomInput.fill('101 河景家庭四人房');
  await page.getByRole('button', { name: '完成編輯' }).click();
  await page.getByRole('button', { name: '總覽' }).click();
  assert.equal(await page.getByText('101 河景家庭四人房').count(), 1);
  await page.screenshot({ path: path.join(out, 'radar-desktop.png'), fullPage: true });
  assert.deepEqual(errors, []);
  await context.close();

  const mobileBrowser = await webkit.launch(); browsers.push(mobileBrowser);
  const mobile = await mobileBrowser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const phone = await mobile.newPage();
  const phoneErrors = []; phone.on('pageerror', error => phoneErrors.push(error.message));
  await installMocks(phone);
  await phone.goto(base + '/radar-test');
  await phone.getByRole('button', { name: '開始分析' }).click();
  await phone.getByRole('heading', { name: '未來 14 天價格與可售狀態' }).waitFor();
  await phone.getByRole('button', { name: '開始分析' }).waitFor();
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
  await phone.getByRole('button', { name: /Booking\.com/ }).click();
  await phone.getByRole('heading', { name: 'Booking.com' }).waitFor();
  await phone.screenshot({ path: path.join(out, 'radar-mobile-webkit.png'), fullPage: true });
  assert.deepEqual(phoneErrors, []);
  await mobile.close();

  const origin = new URL(base).origin;
  const api = await request.newContext();
  const blocked = await api.post(base + '/api/radar-preview', { headers: { Origin: origin }, data: { phase: 'website', url: 'http://127.0.0.1' } });
  assert.equal(blocked.status(), 422);
  const cross = await api.post(base + '/api/radar-ota', { headers: { Origin: 'https://untrusted.example' }, data: {} });
  assert.equal(cross.status(), 403);
  await api.dispose();
  fs.writeFileSync(path.join(out, 'browser-result.json'), JSON.stringify({ passed: true, layout: 'approved-minimal-wireframe', desktop: 'Chromium', mobile: 'WebKit 390x844', sixRooms: true, overviewTabs: true, fourteenDays: true, editableRooms: true, priceAndAvailabilityStates: true, noSyntheticMainFlow: true, ssrfBlocked: true, crossOriginBlocked: true }, null, 2));
  console.log('BROWSER_ACCEPTANCE_PASS');
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { for (const browser of browsers) await browser.close().catch(() => undefined); });
