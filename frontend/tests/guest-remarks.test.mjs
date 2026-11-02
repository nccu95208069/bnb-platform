import test from 'node:test';
import assert from 'node:assert/strict';
import {parseGuestRemarks} from '../src/lib/guest-remarks.ts';
test('independent travel-card/subsidy and operational requests',()=>{
 const raw='測試旅客 加床 +1人 國旅/國旅補 需要收據 需要嬰兒床';
 assert.deepEqual(parseGuestRemarks(raw).map(r=>r.label),['加床','+1人','國旅卡','國旅補','收據','嬰兒床']);
 assert.deepEqual(parseGuestRemarks('測試 國旅補助 國旅補').map(r=>r.label),['國旅補']);
 assert.deepEqual(parseGuestRemarks('測試 +1人').map(r=>r.label),['+1人']);
 assert.deepEqual(parseGuestRemarks('測試 不需要嬰兒床 不用加床 不要收據 加床取消'),[]);
 assert.deepEqual(parseGuestRemarks('測試旅客 安靜房 高樓層'),[]);
});
test('contact channel and invited influencer are distinct; supplies have searchable labels',()=>{
 assert.deepEqual(parseGuestRemarks('測試旅客(IG)').map(r=>r.label),['IG聯繫']);
 assert.deepEqual(parseGuestRemarks('測試帳號(IG網紅)').map(r=>r.label),['IG網紅邀請']);
 assert.deepEqual(parseGuestRemarks('測試旅客(澡盆) 浴室的塑膠椅子 消毒鍋').map(r=>r.label),['嬰兒澡盆','浴室塑膠椅','消毒鍋']);
 assert.deepEqual(parseGuestRemarks('BIG NAME'),[]);
});
test('compact priority exposes subsidy without changing card distinction or source order',async()=>{const {prioritizeGuestRemarks}=await import('../src/lib/guest-remarks.ts');const tags=parseGuestRemarks('Test 加床 國旅卡 國旅補 消毒鍋');assert.equal(prioritizeGuestRemarks(tags)[0].kind,'travel_subsidy');assert.equal(tags[0].kind,'extra_bed');assert.equal(prioritizeGuestRemarks(tags).filter(t=>t.kind==='travel_card').length,1);});
