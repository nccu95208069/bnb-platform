import {cardSyncAuthorized,cardSyncConfig,previewCardSync,commitCardSync} from '@/lib/booking-sources/iron-gate-card-sync.server';
export const dynamic='force-dynamic';
export const maxDuration=120;
export async function POST(request:Request) {
  const headers={'cache-control':'private, no-store'};
  try {
    const config=cardSyncConfig();
    if(!cardSyncAuthorized(request.headers.get('authorization')??'',config.secret))return Response.json({ok:false,error:'UNAUTHORIZED'},{status:401,headers});
    if(!request.headers.get('content-type')?.startsWith('application/json'))throw Error('INVALID_CARD_INPUT');
    const reader=request.body?.getReader();if(!reader)throw Error('INVALID_CARD_INPUT');
    let text='',size=0;const decoder=new TextDecoder('utf-8',{fatal:true});
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>16384){await reader.cancel();throw Error('INVALID_CARD_INPUT');}text+=decoder.decode(value,{stream:true});}text+=decoder.decode();
    const body=JSON.parse(text);
    if(!body||Array.isArray(body)||Object.keys(body).sort().join(',')!=='mode,payload'||!['preview','commit'].includes(body.mode))throw Error('INVALID_CARD_INPUT');
    const result=body.mode==='preview'?await previewCardSync(body.payload,config):await commitCardSync(body.payload,config);
    return Response.json({ok:true,...result},{headers});
  }catch(error){const message=error instanceof Error?error.message:'';const code=/^(?:CARD_[A-Z_]+|INVALID_CARD_INPUT|VERSION_CONFLICT)$/.test(message)?message:'CARD_SYNC_UNAVAILABLE';
    return Response.json({ok:false,error:code,write_state:code==='CARD_RESULT_UNKNOWN'?'unknown':'not_started'},{status:code==='CARD_RESULT_UNKNOWN'||code==='CARD_SYNC_UNAVAILABLE'?503:409,headers});}
}
