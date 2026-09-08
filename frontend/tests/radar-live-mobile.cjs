/* eslint-disable @typescript-eslint/no-require-imports -- Manual live acceptance runner. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {webkit,chromium}=require('/tmp/radar-browser/node_modules/playwright');
const base=process.env.RADAR_TEST_URL, sha=process.env.RADAR_BUILD_SHA;
const out=process.env.RADAR_EVIDENCE_DIR||'/tmp/radar-live-mobile';
fs.mkdirSync(out,{recursive:true});
(async()=>{
  const health=await fetch(base+'/api/radar-preview').then(r=>r.json());assert.equal(health.build,sha);
  const browser=await webkit.launch();
  try{
    const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2});
    const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base+'/radar-test');
    await page.getByRole('button',{name:'開始分析',exact:true}).click();
    await page.getByRole('heading',{name:'未來 14 天價格與可售狀態'}).waitFor({timeout:90000});
    assert.equal(await page.locator('table').first().locator('tbody tr').count(),6);
    await page.waitForFunction(()=>{const s=JSON.parse(localStorage.getItem('daili-radar-mobile:v5')||'{}');return ['agoda','booking','trip'].every(p=>s.jobs?.[p]||s.scans?.[p])},{},{timeout:60000});
    await context.setOffline(true);
    await page.waitForTimeout(8000);
    await context.setOffline(false);
    await page.reload();
    await page.getByRole('heading',{name:'未來 14 天價格與可售狀態'}).waitFor();
    await page.waitForFunction(()=>{const s=JSON.parse(localStorage.getItem('daili-radar-mobile:v5')||'{}');return ['agoda','booking','trip'].every(p=>s.scans?.[p])&&Object.keys(s.jobs||{}).length===0},{},{timeout:400000,polling:3000});
    const snapshot=await page.evaluate(()=>JSON.parse(localStorage.getItem('daili-radar-mobile:v5')));
    delete snapshot.jobs;
    fs.writeFileSync(out+'/real-result.json',JSON.stringify({build:sha,live:true,...snapshot},null,2));
    assert.equal(snapshot.analysis.canonicalRooms.length,6);
    const agoda=snapshot.scans.agoda;
    const accepted=agoda.observations.filter(d=>d.identityVerified&&d.dateVerified&&d.rooms.some(r=>r.availability!=='unknown'));
    console.log('Real Agoda accepted dates:',accepted.length,'of',agoda.requestedDays);
    assert.ok(accepted.length>0,'at least one real dated availability is required');
    const room102=snapshot.analysis.canonicalRooms.find(r=>r.roomNumber==='102');
    assert.ok(agoda.observations.every(d=>d.rooms.filter(r=>r.canonicalRoomId===room102.id).every(r=>r.availability==='unknown')));
    assert.equal(snapshot.scans.trip.collectionState,'paused');
    assert.equal(snapshot.scans.trip.durationMs,0);
    await page.getByRole('button',{name:'編輯房型',exact:true}).click();
    const input=page.getByLabel('101 河景四人房 房型名稱');
    await input.fill('101 河景家庭四人房');
    await page.getByRole('button',{name:'完成編輯',exact:true}).click();
    await page.reload();
    await page.getByText('101 河景家庭四人房',{exact:true}).first().waitFor();
    const restored=await page.evaluate(()=>JSON.parse(localStorage.getItem('daili-radar-mobile:v5')));
    assert.equal(restored.scans.agoda.capturedAt,agoda.capturedAt);
    assert.deepEqual(restored.scans.agoda.observations,agoda.observations);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:out+'/mobile-overview.png',fullPage:true});
    await page.locator('nav[aria-label="平台切換"] button').filter({hasText:'Agoda'}).click();
    await page.getByRole('heading',{name:'Agoda',exact:true}).waitFor();
    assert.ok(await page.locator('[aria-label="目前無可訂方案"]').count()>0);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:out+'/mobile-agoda.png',fullPage:true});
    assert.deepEqual(errors,[]);
    fs.writeFileSync(out+'/mobile-checks.json',JSON.stringify({build:sha,live:true,acceptedDates:accepted.length,rooms:6,refreshWhileScanning:true,networkInterruptionRecovered:true,refreshAfterCompleted:true,roomEditRetained:true,originalCaptureTimeRetained:true,documentOverflow:false,pageErrors:errors},null,2));
  }finally{await browser.close()}
  const desktop=await chromium.launch();try{
    const page=await desktop.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base+'/radar-test');await page.getByRole('button',{name:'開始分析',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
    await page.screenshot({path:out+'/desktop-initial.png',fullPage:true});
  }finally{await desktop.close()}
  assert.equal((await fetch(base+'/api/radar-preview').then(r=>r.json())).build,sha);
  console.log('Public real mobile WebKit acceptance passed:',sha);
})().catch(e=>{console.error(e);process.exitCode=1});
