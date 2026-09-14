// Run with agent-browser eval --stdin on the isolated local calendar only.
// All API reads and refresh writes below are synthetic browser fixtures.
(async () => {
  if (!['localhost','127.0.0.1'].includes(location.hostname)) throw Error('Local test only');
  const rooms=['101','102','201','202','301','302'];
  const expectedDate=new URLSearchParams(location.search).get('date'), expectedMonth=expectedDate.slice(0,7)+'-01';
  const properties=[{id:'sweetfun',name:'Test property',short_name:'Test',location:'Test',room_count:6,color:'emerald'}];
  let writes=0, reads=0, fail=false;
  const original=window.fetch;
  window.fetch=async (input, options) => {
    const url=new URL(String(input),location.origin), p=url.searchParams;
    if(url.pathname.endsWith('/availability/refresh')) {
      writes++; await new Promise(r=>setTimeout(r,400));
      return Response.json(fail?{detail:'Synthetic source unavailable; existing prices preserved'}:{verified:true,observed_at:new Date().toISOString()}, {status:fail?502:200});
    }
    if(url.pathname.endsWith('/availability')) {
      reads++; await new Promise(r=>setTimeout(r,120));
      const start=p.get('start'),end=p.get('end'),channel=p.get('channel')||'direct',cells=[];
      for(let d=Date.parse(start);d<Date.parse(end);d+=86400000) for(const room of rooms) cells.push({date:new Date(d).toISOString().slice(0,10),room,state:'available',reason:'',sellable_units:1,minimum_nights:1,max_guests:2,inventory_observed_at:new Date().toISOString(),freshness:'fresh',pricing:{current_price:2000+writes,base_price:3000,suggested_price:null,guest_pay_price:null,currency:'TWD',channel,policy:'observed_snapshot',eligible:false,exclusion:null,baseline_version:'fixture',price_version:'fixture',plan_version:'fixture',limits:'',observed_at:new Date().toISOString(),source:'OwlNest',suggestion_source:''}});
      return Response.json({status:'ok',mode:'live',snapshot_id:'fixture',asof:new Date().toISOString(),query:{start,end,rooms,channel,demo_cycle:1},property_id:'sweetfun',properties,rooms,cells,counts:{available:cells.length,sold:0,held:0,blocked:0,maintenance:0,unknown:0,conflict:0,past:0},price_hidden:false,continuous_windows:[],source_notice:'Synthetic fixture'});
    }
    if(url.pathname.endsWith('/bookings/calendar')) return Response.json({year:2026,month:9,month_start:'2026-09-01',month_end:'2026-10-01',period_start:p.get('start'),period_end:p.get('end'),properties,rooms:rooms.map(room=>({id:room,property_id:'sweetfun',room_number:room,label:room})),order_count:0,booking_segment_count:0,total_amount:0,bookings:[]});
    return original(input,options);
  };
  const pause=()=>new Promise(r=>setTimeout(r,450));
  const click=text=>{const b=[...document.querySelectorAll('button')].find(b=>b.getClientRects().length&&b.textContent.trim()===text);if(!b)throw Error('Missing '+text);b.click();};
  const check=label=>{
    if(new URLSearchParams(location.search).get('date')!==expectedDate)throw Error(label+': date drift '+location.search);
    const root=document.querySelector('[data-position-month]')?.parentElement;
    if(root){const bounds=root.getBoundingClientRect(),node=root.querySelector(`[data-position-month="${expectedMonth}"]`),r=node.getBoundingClientRect();if(r.bottom<=bounds.top||r.top>=bounds.bottom)throw Error(label+': target month not visible');}
  };
  try {
    document.querySelector('[aria-label="更新未售房況"]').click(); await pause(); check('loaded');
    for(let round=0;round<3;round++)for(const label of ['週','日','月','已售訂單','週','日','月','未售房況']){click(label);await pause();check(label);}
    const before=reads;
    const refreshButton=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='更新 OwlNest 價格');
    refreshButton.click();refreshButton.click();await pause();await pause();
    if(writes!==1||reads<=before||!document.body.innerText.includes('已更新未來三個月價格'))throw Error('refresh did not verify/reload or duplicate write');
    check('refresh');
    fail=true;click('更新 OwlNest 價格');await pause();
    if(!document.body.innerText.includes('Synthetic source unavailable'))throw Error('failure hidden');
    check('failed refresh');
    const root=document.querySelector('[data-position-month]').parentElement;
    root.querySelector('[data-position-month="2026-01-01"]').style.minHeight='3000px';await pause();check('async earlier height change');
    history.back();await pause();history.forward();await pause();check('Back/Forward');
    [...document.querySelectorAll('a')].find(a=>a.textContent.trim()==='首頁').click();
    for(let i=0;i<20&&document.querySelector('[data-position-month]');i++)await pause();
    if(document.querySelector('[data-position-month]'))throw Error('home navigation incomplete');
    document.querySelector('a[href="/calendar"]').click();
    for(let i=0;i<20&&!document.querySelector('[data-position-month]');i++)await pause();
    await pause();check('return from home');
    return {passed:true,toggleCount:24,writes,reads,date:new URLSearchParams(location.search).get('date')};
  } finally {window.fetch=original;}
})()
