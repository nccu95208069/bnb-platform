import test from 'node:test';
import assert from 'node:assert/strict';

test('owner login ignores a persisted hidden-price preview; deliberate preview stays temporary', async t => {
  process.env.NEXT_PUBLIC_CALENDAR_SOURCE = 'sheet_snapshot';
  process.env.NEXT_PUBLIC_DEMO_MODE = 'true';
  const values = new Map([
    ['sweetfun-os-account-ui-v1', JSON.stringify({state:{previewRole:'viewer_no_price',members:[]},version:0})],
  ]);
  const storage = {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
  globalThis.localStorage=storage;
  globalThis.window={localStorage:storage};
  t.after(()=>{delete globalThis.localStorage;delete globalThis.window;});
  const owner={id:'calendar-owner',role:'owner',allProperties:true,propertyIds:['sweetfun','offland']};
  let account=owner;
  t.mock.method(globalThis,'fetch',async()=>Response.json({membership:account}));
  const {useAccessControl:store,ROLE_DEFINITIONS}=await import('../src/lib/access-control.ts');
  assert.equal(store.getState().previewRole,null);
  await store.getState().initialize();
  assert.equal(store.getState().membership.role,'owner');
  assert.equal(ROLE_DEFINITIONS[store.getState().previewRole??store.getState().membership.role].permissions.viewPrices,true);
  store.getState().setPreviewRole('viewer_no_price');
  assert.equal(store.getState().previewRole,'viewer_no_price');
  assert.equal(JSON.parse(values.get('sweetfun-os-account-ui-v1')).state.previewRole,null);
  // Focus/session refresh should not end a preview the owner is currently testing.
  await store.getState().initialize();
  assert.equal(store.getState().previewRole,'viewer_no_price');
  await store.persist.rehydrate();
  assert.equal(store.getState().previewRole,null);
  // A real restricted account must still remain unable to see prices.
  account={...owner,id:'restricted-member',role:'viewer_no_price'};
  await store.getState().initialize();
  store.getState().setPreviewRole('owner');
  assert.equal(store.getState().previewRole,null);
  assert.equal(ROLE_DEFINITIONS[store.getState().membership.role].permissions.viewPrices,false);
});
