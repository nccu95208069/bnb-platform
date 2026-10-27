import {FINANCE_SHEET_HEADERS,FINANCE_SHEET_INPUT_TAB}
  from './finance-sheet-bulk-core.ts';

export const FINANCE_SHEET_TABS=[FINANCE_SHEET_INPUT_TAB,'匯入預覽與待核對',
  '訂單財務摘要','收支事件','各館成本','同步紀錄'] as const;

/** One atomic Google Sheets batchUpdate creates the input and read-only tabs. */
export function financeSheetTemplateRequests(sheetIds:number[],serviceEmail:string,
  propertyDisplay:string){
  if(sheetIds.length!==FINANCE_SHEET_TABS.length||
    new Set(sheetIds).size!==sheetIds.length||
    sheetIds.some(id=>!Number.isSafeInteger(id)||id<1||id>2_147_483_647)||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(serviceEmail)||
    !propertyDisplay||propertyDisplay.length>80)
    throw Error('SHEET_TEMPLATE_INVALID');
  const requests:Record<string,unknown>[]=[];
  for(let index=0;index<FINANCE_SHEET_TABS.length;index++){
    requests.push({addSheet:{properties:{sheetId:sheetIds[index],
      title:FINANCE_SHEET_TABS[index],gridProperties:{rowCount:501,
        columnCount:index===0?20:12}}}});
  }
  requests.push({updateCells:{range:{sheetId:sheetIds[0],startRowIndex:0,
    endRowIndex:1,startColumnIndex:0,endColumnIndex:20},
    rows:[{values:FINANCE_SHEET_HEADERS.map(value=>({userEnteredValue:{
      stringValue:value},userEnteredFormat:{textFormat:{bold:true}}}))}],
    fields:'userEnteredValue,userEnteredFormat.textFormat'}});
  requests.push({repeatCell:{range:{sheetId:sheetIds[0],startRowIndex:1,
    endRowIndex:501,startColumnIndex:15,endColumnIndex:16},
    cell:{userEnteredValue:{stringValue:propertyDisplay}},fields:'userEnteredValue'}});
  const editors={users:[serviceEmail]};
  const protect=(sheetId:number,startColumnIndex:number,endColumnIndex:number,
    startRowIndex=0,endRowIndex?:number)=>requests.push({addProtectedRange:{
      protectedRange:{range:{sheetId,startColumnIndex,endColumnIndex,startRowIndex,
        ...(endRowIndex?{endRowIndex}:{})},warningOnly:false,editors}}});
  protect(sheetIds[0],0,20,0,1); // Header labels are part of the import contract.
  protect(sheetIds[0],0,2);
  protect(sheetIds[0],16,20);
  for(const sheetId of sheetIds.slice(1))protect(sheetId,0,12);
  return requests;
}
