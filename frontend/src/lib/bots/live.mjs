const round=n=>Math.round(n*100)/100;
export function liveProjection(snapshot){
 return {rows:snapshot.bookings.map(b=>({room:b.room_number,day:b.check_in,channel:b.platform,fee:b.source_conflict||b.price_hidden?null:b.room_rate,ambiguous:!!b.source_conflict})),rooms:snapshot.rooms||['101','102','201','202','301','302'],asof:snapshot.source.sync.last_checked_at,hash:snapshot.source.snapshot_version};
}
export function liveQuery(snapshot,c,tool,r,a){
 if(!snapshot)throw Error('SOURCE_UNAVAILABLE');
 const bookings=snapshot.bookings.filter(b=>a.id?b.id===a.id:b.check_in<r.end&&b.check_out>r.start);
 const source={title:snapshot.source.title||'水芳目前訂單・唯讀',asof:snapshot.source.sync.last_checked_at,version:snapshot.source.snapshot_version};
 const note='來源每列代表一個房晚；表載房費不等於實收、平台入帳或淨利。房況未包含所有停賣條件，不能推定 OTA 可售庫存。';
 if(tool==='orders.list')return {kind:'table',title:'目前訂單房晚（匿名唯讀）',range:r,source,note:note+(bookings.length>200?' 本次顯示前 200 列，請縮小期間。':''),rows:bookings.slice(0,200).map(b=>({房晚識別:b.id,訂單識別:b.source_order_linked?b.order_id:'未提供共同訂單編號',房間:b.room_number,入住:b.check_in,退房:b.check_out,通路:b.platform,表載房費:b.source_conflict||b.price_hidden?null:b.room_rate,核對:b.source_conflict?'待核對':'已核對',客人付款標記:b.source_conflict?'未知':b.source_payment_flag==='done'?'已付清；平台入帳未知':b.source_payment_flag==='not_yet'?'來源標記未完成付款':'未知'}))};
 if(tool==='availability')return {kind:'table',title:'表載房況（非可售庫存）',range:r,source,note,rows:(snapshot.rooms||['101','102','201','202','301','302']).map(room=>({房間:room,期間房況:bookings.some(b=>b.room_number===room&&b.source_conflict)?'有待核對房晚':bookings.some(b=>b.room_number===room)?'有已登記房晚':'未見登記房晚；可售狀態待確認'}))};
 const good=bookings.filter(b=>!b.source_conflict&&!b.price_hidden);
 if(tool==='finance.summary')return {kind:'table',title:'表載房費核對（唯讀）',range:r,source,note,rows:[{已核對房晚:good.length,待核對房晚:bookings.length-good.length,表載房費合計:good.length?round(good.reduce((n,b)=>n+b.room_rate,0)):bookings.length?null:0,客人已付清標記房晚:good.filter(b=>b.source_payment_flag==='done').length,實際入帳:null,未收餘額:null,淨利:null}]};
 return {kind:'table',title:'目前營運房晚概況',range:r,source,note,rows:[{表載房晚:bookings.length,待核對房晚:bookings.length-good.length,來源:'水芳訂單同步・唯讀',查詢開始:r.start,查詢結束不含:r.end}]};
}
