import test from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';

const enabled=process.env.IRON_GATE_FINANCE_TEST_DATABASE==='iron_gate_finance_test3';
const poolConfig={host:'/private/tmp',port:55432,database:'iron_gate_finance_test3'};
const workspace='20000000-0000-4000-8000-000000000001';
const first='20000000-0000-4000-8000-000000000002';
const second='20000000-0000-4000-8000-000000000003';
const connectorA='20000000-0000-4000-8000-000000000004';
const connectorB='20000000-0000-4000-8000-000000000005';

test('connector metadata has immutable versioned audit and property-scoped reads',
  {skip:!enabled},async()=>{
    const admin=new Pool(poolConfig),runtime=new Pool(poolConfig);
    try{
      await admin.query('TRUNCATE iron_gate.property_state CASCADE');
      for(const property of [first,second]){
        await admin.query(`INSERT INTO iron_gate.property_state
          (property_id,workspace_id,authority_epoch,inventory_version,state_json)
          VALUES ($1,$2,1,1,$3::jsonb)`,[property,workspace,
          JSON.stringify({propertyId:property,workspaceId:workspace,authorityEpoch:1,
            version:1,roomIds:[],readOnly:false,bookings:[]})]);
      }
      for(const [property,source] of [[first,connectorA],[second,connectorB]])
        await admin.query(`INSERT INTO iron_gate.finance_connector
          (source_instance_id,property_id,source_system,adapter_key,
           source_sheet_ref,enabled,confirm_policy)
          VALUES ($1,$2,'sheet_bulk','sheet_bulk_v1',$3,false,'manual')`,
          [source,property,'SyntheticSheet_0123456789']);
      await admin.query(`UPDATE iron_gate.finance_connector
        SET version=2,enabled=true,updated_at=clock_timestamp(),watermark='synthetic-v2'
        WHERE property_id=$1 AND source_instance_id=$2`,[first,connectorA]);
      const history=await admin.query(`SELECT version,config_json->>'enabled' AS enabled,
        config_json->>'watermark' AS watermark
        FROM iron_gate.finance_connector_config_history
        WHERE property_id=$1 ORDER BY version`,[first]);
      assert.deepEqual(history.rows.map(row=>Number(row.version)),[1,2]);
      assert.deepEqual(history.rows.map(row=>row.enabled),['false','true']);
      assert.equal(history.rows[1].watermark,'synthetic-v2');
      await assert.rejects(admin.query(`UPDATE iron_gate.finance_connector_config_history
        SET actor_ref='changed' WHERE property_id=$1 AND source_instance_id=$2`,
        [first,connectorA]),error=>/FINANCE_CONNECTOR_HISTORY_IMMUTABLE/.test(error.message));
      await assert.rejects(admin.query(`DELETE FROM iron_gate.finance_connector_config_history
        WHERE property_id=$1 AND source_instance_id=$2`,
        [first,connectorA]),error=>/FINANCE_CONNECTOR_HISTORY_IMMUTABLE/.test(error.message));
      await assert.rejects(admin.query(`UPDATE iron_gate.finance_connector
        SET enabled=false,updated_at=clock_timestamp()
        WHERE property_id=$1 AND source_instance_id=$2`,[first,connectorA]),
      error=>/FINANCE_CONNECTOR_VERSION_CONFLICT/.test(error.message));
      const client=await runtime.connect();
      try{
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE iron_gate_runtime');
        await client.query("SELECT set_config('iron_gate.property_id',$1,true)",[first]);
        const visible=await client.query(`SELECT source_instance_id
          FROM iron_gate.finance_connector_config_history ORDER BY source_instance_id,version`);
        assert.equal(visible.rows.length,2);
        assert.ok(visible.rows.every(row=>row.source_instance_id===connectorA));
        await client.query('ROLLBACK');
      }finally{client.release();}
    }finally{
      await admin.query('TRUNCATE iron_gate.property_state CASCADE');
      await runtime.end();await admin.end();
    }
  });
