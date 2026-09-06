// Run in an isolated test browser on /calendar. Only the response's sync metadata
// is simulated; source rows remain read-only and no real Sheet changes are made.
(async () => {
  const wait = async (fn, label) => { for (let i=0;i<100;i++) { if(fn())return; await new Promise(r=>setTimeout(r,80)); } throw new Error(label); };
  const original = window.fetch;
  for (const path of ['/api/cron/sheet-monitor','/api/v1/sources/sheet/status']) {
    const response=await original(path);
    if(response.status!==401)throw new Error('unauthenticated monitor access');
  }
  let status='healthy', calls=0;
  window.fetch=async (...args)=>{
    const response=await original(...args);
    if(!String(args[0]).includes('/bookings/calendar') || !response.ok)return response;
    const data=await response.json();calls++;
    data.source={...data.source,automatic_sync:true,sync:{status,last_checked_at:'2026-09-06T02:00:00Z',last_published_at:'2026-09-06T01:59:00Z',cutoff:'2026-08-07',interval_seconds:60,error_code:status==='error'?'MONITOR_CHECK_FAILED':null}};
    return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
  };
  try {
    const button=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='重新整理'||b.getAttribute('title')==='重新整理');
    if(!button)throw new Error('refresh missing');button.click();
    await wait(()=>document.body.innerText.includes('每分鐘自動檢查訂房表'),'healthy status');
    const checks={confirming:'發現資料變更，等待下一次檢查確認',error:'訂房表檢查失敗，目前保留上次資料',stale:'已超過 5 分鐘未完成檢查',waiting:'監控已設定，等待首次檢查'};
    for(const [next,text] of Object.entries(checks)){
      status=next;window.dispatchEvent(new Event('focus'));
      await wait(()=>document.body.innerText.includes(text),next);
    }
    if(!document.body.innerText.includes('2026-08-07'))throw new Error('cutoff missing');
    if(document.querySelector('[data-nextjs-dialog]'))throw new Error('runtime overlay');
    return {unauthenticatedBlocked:true,statuses:5,focusRefresh:true,cutoff:true,requests:calls};
  }finally{window.fetch=original;}
})()
