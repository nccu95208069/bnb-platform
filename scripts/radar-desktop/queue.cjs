// Local file transport only. This program never controls a browser or runs job text.
const fs = require('node:fs');
const path = require('node:path');
const base = process.env.RADAR_DESKTOP_QUEUE_DIR;
const compiled = process.env.RADAR_DESKTOP_COMPILED_DIR;
if (!base || !path.isAbsolute(base) || !compiled || !path.isAbsolute(compiled)) throw Error('Desktop paths are required');
const queue = require(path.join(compiled, 'desktop-queue.js'));
const active = path.join(base, 'active-worker.json');
(async () => {
  const command = process.argv[2];
  if (command === 'claim') {
    if (fs.existsSync(active)) { console.log(JSON.stringify({ state: 'attention', detail: 'An unfinished worker claim exists. Resume it or explicitly fail it.' })); return; }
    const job = await queue.claimDesktop();
    if (!job) { console.log(JSON.stringify({ state: 'idle' })); return; }
    fs.writeFileSync(active, JSON.stringify(job), { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ state: 'running', id: job.id, request: job.request }));
  } else if (command === 'request') {
    const job = JSON.parse(fs.readFileSync(active, 'utf8'));
    console.log(JSON.stringify({ id: job.id, request: job.request }));
  } else if (command === 'complete' || command === 'fail') {
    const job = JSON.parse(fs.readFileSync(active, 'utf8'));
    const capture = command === 'complete' ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) : { failure: process.argv[3] || '桌面收集未完成，請重試。' };
    console.log(JSON.stringify(await queue.finishDesktop(job.id, job.claim, capture)));
    fs.unlinkSync(active);
  } else throw Error('Use claim, request, complete <capture-file>, or fail <reason>');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
