(async () => {
 const results=[];
 const wait=async(test,label)=>{for(let i=0;i<100;i++){if(test()){results.push(label);return;}await new Promise(r=>setTimeout(r,60));}throw new Error(label+' failed; '+location.href);};
 const p=(key)=>new URLSearchParams(location.search).get(key);
 const visible=(el)=>!!el?.getClientRects().length;
 const click=(selector)=>{const el=[...document.querySelectorAll(selector)].find(visible);if(!el)throw new Error('Missing '+selector);el.click();};
 const button=(text)=>{const el=[...document.querySelectorAll('button')].find(e=>visible(e)&&e.textContent.trim()===text);if(!el)throw new Error('Missing button '+text);el.click();};
 await wait(()=>document.querySelector('[data-unsold-date="2026-09-05"]'),'month loaded');
 click('[aria-label="2026-09-05 展開其餘房間"]');
 await wait(()=>p('expanded')==='2026-08-31'&&document.querySelector('[data-unsold-date="2026-09-05"]').innerText.includes('302'),'expand stays in month with all six rooms');
 history.back();await wait(()=>!p('expanded')&&document.querySelector('[data-unsold-date="2026-09-05"]').innerText.includes('另 3 房'),'Back collapses original week');
 history.forward();await wait(()=>p('expanded')==='2026-08-31','Forward restores expansion');
 click('[aria-label="2026-09-09 查看日曆"]');await wait(()=>p('view')==='day'&&p('date')==='2026-09-09'&&document.body.innerText.includes('202 房'),'date enters day in one entry');
 button('查看房晚與價格');await wait(()=>!!p('stay')&&!!document.querySelector('[role=dialog]'),'room details addressable');
 history.back();await wait(()=>!p('stay')&&!document.querySelector('[role=dialog]')&&p('view')==='day','Back closes details, stays on same day');
 history.forward();await wait(()=>!!p('stay')&&!!document.querySelector('[role=dialog]'),'Forward reopens details');
 history.back();await wait(()=>!p('stay')&&!document.querySelector('[role=dialog]'),'close details again');
 history.back();await wait(()=>p('view')==='month'&&p('date')==='2026-09-05'&&p('expanded')==='2026-08-31','Back restores original month, date and expansion');
 button('週');await wait(()=>p('view')==='week'&&!!document.querySelector('table'),'week rendered');
 click('[aria-label="下一個未售區間"]');await wait(()=>p('date')==='2026-09-12','next week recorded');
 history.back();await wait(()=>p('date')==='2026-09-05','Back returns original week');
 history.back();await wait(()=>p('view')==='month'&&!!document.querySelector('[data-unsold-date]'),'Back restores month');
 button('已售訂單');await wait(()=>p('mode')==='sold'&&!document.querySelector('[data-unsold-date]'),'sold calendar rendered');
 history.back();await wait(()=>p('mode')==='unsold'&&p('view')==='month'&&!!document.querySelector('[data-unsold-date]'),'Back restores unsold month');
 return results;
})()
