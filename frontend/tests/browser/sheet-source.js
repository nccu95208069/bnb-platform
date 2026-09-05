(async () => {
  const wait = async (fn, label) => { for (let i=0;i<100;i++) { if (fn()) return; await new Promise(r=>setTimeout(r,80)); } throw new Error(label); };
  const response = await fetch('/api/v1/bookings/calendar?start=2026-09-01&end=2026-10-01').then(r=>r.json());
  if (response.data_mode !== 'anonymized_google_sheet_snapshot') throw new Error('wrong source');
  if (response.bookings.filter(b=>b.check_in.startsWith('2026-09')).length !== 114) throw new Error('September row count');
  if (response.bookings.some(b=>!b.source_read_only || b.payment_status!=='unknown' || b.external_order_no || b.payments.length)) throw new Error('projection safety');
  const groups=Map.groupBy(response.bookings,b=>b.order_id+'|'+b.room_id);
  const stay=[...groups.values()].find(bs=>bs.length>=2&&bs[0].source_order_linked&&bs.every(b=>b.check_in.startsWith('2026-09')));
  if (!stay) throw new Error('no linked stay');
  stay.sort((a,b)=>a.check_in.localeCompare(b.check_in));
  // Drive the existing navigation, then inspect details through its supported addressable URL.
  const url=new URL(location.href);url.searchParams.set('order',stay[0].id);url.searchParams.set('date',stay[0].check_in);
  history.pushState(null,'',url);window.dispatchEvent(new PopStateEvent('popstate'));
  await wait(()=>document.querySelector('[role="dialog"]')?.innerText.includes('每晚登記房費'),'nightly detail panel');
  const dialog=document.querySelector('[role="dialog"]');
  if ([...dialog.querySelectorAll('button')].some(b=>/登記付款|編輯訂單資料|取消訂單/.test(b.textContent))) throw new Error('write control exposed');
  if (!dialog.innerText.includes('可能平均拆分')) throw new Error('amount semantics missing');
  history.back();
  await wait(()=>!document.querySelector('[role="dialog"]'),'back closes panel');
  const issue=await fetch('/api/v1/bookings/calendar?start=2026-12-19&end=2026-12-20').then(r=>r.json());
  if (issue.bookings.filter(b=>b.source_conflict&&b.check_in==='2026-12-19').length!==6) throw new Error('whole-property uncertainty');
  const post=await fetch('/api/v1/bookings/calendar',{method:'POST'});
  if (post.status!==405) throw new Error('source is not read-only');
  return {source:true,septemberRoomNights:114,readOnly:true,nightlyDetail:true,back:true,wholePropertyBlocked:true};
})()
