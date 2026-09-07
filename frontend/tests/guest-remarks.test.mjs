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
