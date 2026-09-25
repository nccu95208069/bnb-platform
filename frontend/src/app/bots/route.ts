import {NextRequest,NextResponse} from 'next/server';
import {principalFor} from '@/lib/workspace-auth/session';
import {shell} from '@/lib/bots/shell.mjs';
export const dynamic='force-dynamic';
export async function GET(request:NextRequest){
 const principal=await principalFor(request).catch(()=>null);
 if(!principal)return NextResponse.redirect(new URL('/calendar-access?next=/bots',request.url));
 if(principal.role!=='owner')return new Response('Bot 工作台目前僅供業主使用。',{status:403});
 return new Response(shell,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, no-store','Vary':'Cookie','X-Robots-Tag':'noindex, nofollow','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"}});
}
