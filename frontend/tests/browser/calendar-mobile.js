(async()=>{
 const result=[];const wait=async(f,label)=>{for(let i=0;i<160;i++){if(f()){result.push(label);return;}await new Promise(r=>setTimeout(r,80));}throw Error(label+' '+location.href);};
 const click=(label)=>{const e=[...document.querySelectorAll('button')].find(b=>b.getClientRects().length&&(b.getAttribute('aria-label')===label||b.textContent.trim()===label));if(!e)throw Error('Missing '+label);e.click();};
 await wait(()=>document.querySelector('[data-unsold-date="2026-09-05"]')?.innerText.includes('$3,900'),'external mobile rates loaded');
 click('2026-09-05 101 房 可售 $3,900');await wait(()=>!!document.querySelector('[role=dialog]'),'room detail opened');
 click('查核每晚房況與價格');await wait(()=>document.body.innerText.includes('1 晚合計 $3,900'),'external nightly quote works');
 click('預演此房晚調價');await wait(()=>document.body.innerText.includes('調價預演與交辦'),'pricing proposal opened');
 click('儲存調價交辦');await wait(()=>document.body.innerText.includes('交辦已保存'),'synthetic mission saved');
 const link=[...document.querySelectorAll('a')].find(a=>a.textContent.includes('到任務中心查看'));link.click();await wait(()=>location.pathname==='/missions'&&document.body.innerText.includes('本機示範交辦已保存'),'mission center opens');
 history.back();await wait(()=>location.pathname==='/calendar'&&document.body.innerText.includes('交辦已保存'),'Back restores saved proposal, not a fresh form');
 history.back();await wait(()=>!document.body.innerText.includes('調價預演與交辦')&&!!document.querySelector('[role=dialog]'),'Back closes proposal and returns room detail');
 history.back();await wait(()=>!document.querySelector('[role=dialog]')&&!!document.querySelector('[data-unsold-date]'),'Back returns mobile calendar');
 return result;
})()
