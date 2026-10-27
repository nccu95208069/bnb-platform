'use client';

import {useState} from 'react';

type Row={row_id:string;sheet_row:number;action:string;event_kind:string;
  amount_cents:number;booking_id:string|null;base_version:number;
  effective_on:string;cash_on:string;service_on:string|null;
  category_code:string|null;receipt_purpose:string|null;
  payment_method_code:string;allocation_start_month:string|null;
  allocation_months:number|null;safe_description:string|null;source_version:number};
type Issue={sheet_row:number;row_id:string|null;code:string};
type Preview={status:'preview';preview_token:string;expires_at:number;
  workbook_url:string;
  rows:Row[];issues:Issue[];unassigned:{sheet_row:number;content_hash:string}[]};
type Commit={status:'completed';results:{row_id:string;status:string;
  projection?:string;code?:string;version?:number}[];issues:Issue[]};

const endpoint='/api/v1/finance-sheet-bulk';
const labels:Record<string,string>={create:'新增',amend:'修正',void:'作廢登錄',
  property_receipt:'收款',expense_paid:'支出',room:'房費',deposit:'訂金',
  extra:'其他收入',SHEET_VERSION_CONFLICT:'資料版本已變，請核對工作簿與帳本',
  SHEET_BOOKING_REVIEW_REQUIRED:'訂單尚未精確核對',
  SHEET_MISSING_ACCEPTED_ROW:'已入帳的原始列不在工作簿，請查核',
  SHEET_BATCH_PAGE_LIMIT:'本次最多預覽 50 列',
  SHEET_PROJECTION_GAP:'工作簿回寫版本落後，請查核',
  VERSION_CONFLICT:'訂單或資料版本已變，請重新預覽',
  WRITE_UNCONFIRMED:'結果仍在核對，請保留原列，稍後查詢',
  SOURCE_MAPPING_REVIEW_REQUIRED:'收款來源可能重複或訂單對應不明'};
const label=(value:string|null|undefined)=>value?labels[value]??value:'—';
const money=(cents:number)=>new Intl.NumberFormat('zh-TW',{style:'currency',
  currency:'TWD',maximumFractionDigits:2}).format(cents/100);

async function call(body:Record<string,unknown>){
  const response=await fetch(endpoint,{method:'POST',credentials:'same-origin',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(body),cache:'no-store'});
  const result=await response.json() as Record<string,unknown>;
  if(!response.ok)throw Error(String(result.code??'UNAVAILABLE'));
  return result;
}

export function FinanceSheetBulkWorkspace(){
  const [preview,setPreview]=useState<Preview|null>(null);
  const [selected,setSelected]=useState<string[]>([]);
  const [result,setResult]=useState<Commit|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  async function refresh(){
    setBusy(true);setError('');setResult(null);setPreview(null);setSelected([]);
    try{setPreview(await call({action:'preview'}) as Preview);}
    catch(cause){setError(label(cause instanceof Error?cause.message:'UNAVAILABLE'));}
    finally{setBusy(false);}
  }
  async function assign(sheetRow:number,contentHash:string){
    setBusy(true);setError('');
    try{await call({action:'assign',sheet_row:sheetRow,content_hash:contentHash});
      setPreview(await call({action:'preview'}) as Preview);setSelected([]);}
    catch(cause){setError(label(cause instanceof Error?cause.message:'UNAVAILABLE'));}
    finally{setBusy(false);}
  }
  async function commit(){
    if(!preview||!selected.length||selected.length>10)return;
    setBusy(true);setError('');
    try{
      const committed=await call({action:'commit',preview_token:preview.preview_token,
        row_ids:selected}) as Commit;
      setResult(committed);setPreview(null);setSelected([]);
    }catch(cause){setError(label(cause instanceof Error?cause.message:'UNAVAILABLE'));}
    finally{setBusy(false);}
  }
  return <main className="mx-auto max-w-6xl space-y-5 p-5">
    <header className="space-y-2">
      <h1 className="text-2xl font-semibold">Sweetfun 批次補登</h1>
      <p className="text-sm text-muted-foreground">先在專用 Google 工作簿的「批次輸入」編輯，再到這裡預覽並選擇要提交的列。只有確認成功的列會進入正式帳本。</p>
      <button type="button" disabled={busy} onClick={refresh}
        className="rounded bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">
        {busy?'處理中…':'讀取工作簿並預覽'}
      </button>
    </header>
    {error&&<p role="alert" className="rounded border border-red-300 p-3 text-sm text-red-700">{error}</p>}
    {preview&&<>
      <a href={preview.workbook_url} target="_blank" rel="noopener noreferrer"
        className="text-sm underline">開啟專用 Google 工作簿</a>
      <p className="text-sm">預覽有效至 {new Date(preview.expires_at).toLocaleString('zh-TW',
        {timeZone:'Asia/Taipei'})}；每次最多提交 10 列。</p>
      {preview.unassigned.length>0&&<section className="space-y-2 rounded border p-4">
        <h2 className="font-semibold">新列需要固定編號</h2>
        <p className="text-sm">先核對列號，派發編號後再重新預覽。</p>
        {preview.unassigned.map(item=><div key={item.sheet_row} className="flex items-center gap-3 text-sm">
          <span>第 {item.sheet_row} 列</span>
          <button type="button" disabled={busy} onClick={()=>assign(item.sheet_row,item.content_hash)}
            className="rounded border px-3 py-1 disabled:opacity-50">派發編號</button>
        </div>)}
      </section>}
      {preview.issues.length>0&&<section className="rounded border border-amber-300 p-4">
        <h2 className="font-semibold">待核對列</h2>
        <ul className="mt-2 space-y-1 text-sm">{preview.issues.map((issue,index)=><li key={`${issue.sheet_row}-${index}`}>
          {issue.sheet_row?`第 ${issue.sheet_row} 列`:'已入帳列'}：{label(issue.code)}
        </li>)}</ul>
      </section>}
      <section className="space-y-3">
        <h2 className="font-semibold">可提交列</h2>
        {preview.rows.length===0?<p className="text-sm">目前沒有可提交列。</p>:
          <div className="space-y-3">{preview.rows.map(row=><label key={row.row_id}
            className="block rounded border p-4 text-sm">
            <span className="flex items-center gap-3 font-semibold">
              <input type="checkbox" checked={selected.includes(row.row_id)} disabled={busy}
                onChange={event=>setSelected(current=>event.target.checked?
                  current.length<10?[...current,row.row_id]:current:
                  current.filter(id=>id!==row.row_id))}/>
              第 {row.sheet_row} 列　{label(row.action)} · {label(row.event_kind)} · {money(row.amount_cents)}
            </span>
            <span className="mt-2 block pl-7 text-muted-foreground">
              收付日 {row.cash_on} · 事件日 {row.effective_on} · 服務日 {row.service_on??'—'}
              <br/>訂單 {row.booking_id??'無'} · 用途 {label(row.receipt_purpose)} · 分類 {label(row.category_code)}
              <br/>方式 {label(row.payment_method_code)} · 攤提起始 {row.allocation_start_month??'—'} · 月數 {row.allocation_months??'—'}
              <br/>備註 {row.safe_description??'—'} · 來源版本 {row.base_version} → {row.source_version}
            </span>
          </label>)}</div>}
        <button type="button" disabled={busy||!selected.length||selected.length>10}
          onClick={commit} className="rounded bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">
          確認提交已選 {selected.length} 列
        </button>
      </section>
    </>}
    {result&&<section className="rounded border p-4">
      <h2 className="font-semibold">提交結果</h2>
      <ul className="mt-2 space-y-1 text-sm">{result.results.map(item=><li key={item.row_id}>
        {item.row_id}：{item.status==='accepted'?'帳本已接受':
          item.status==='unknown'?'結果待核對':'未入帳'}
        {item.projection==='pending'?'（工作簿狀態稍後更新）':''}
        {item.code?` · ${label(item.code)}`:''}
      </li>)}</ul>
      <button type="button" disabled={busy} onClick={refresh}
        className="mt-3 rounded border px-3 py-1">重新讀取</button>
    </section>}
  </main>;
}
