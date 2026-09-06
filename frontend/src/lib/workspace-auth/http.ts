import {NextRequest,NextResponse} from 'next/server';
export const privateHeaders={'Cache-Control':'private, no-store',Vary:'Cookie','Referrer-Policy':'no-referrer'};
export function sameOrigin(request:NextRequest) {if(request.headers.get('origin')!==`${request.nextUrl.protocol}//${request.headers.get('host')}`)throw new Error('FORBIDDEN');}
export async function inputBody(request:NextRequest) {
  const text=await request.text();if(text.length>5000)throw new Error('INVALID_INPUT');
  try {const input=JSON.parse(text);if(!input||typeof input!=='object'||Array.isArray(input))throw new Error();return input;}catch{throw new Error('INVALID_INPUT');}
}
export function authFailure(error:unknown) {
  const code=error instanceof Error?error.message:'';
  const errors:Record<string,[number,string]>={
    FORBIDDEN:[403,'只有管理者可以執行這個操作，請確認已登入。'],UNAUTHORIZED:[401,'信箱或密碼不正確，或帳號尚未啟用。'],
    INVALID_INPUT:[400,'請確認名稱、Email、角色與旅宿範圍。'],EMAIL_EXISTS:[409,'這個 Email 已有帳號，請在成員清單編輯或重寄邀請。'],
    VERSION_CONFLICT:[409,'資料剛被更新，請重新載入後再操作。'],WRITE_UNCONFIRMED:[503,'儲存结果暫時無法確認，請重新載入查看。'],
    RATE_LIMITED:[429,'操作次數較多，請稍後再試。'],INVITE_INVALID:[400,'邀請連結已失效、已使用或帳號已停用，請管理者重寄。'],
    PASSWORD_INVALID:[400,'密碼需為不易猜測的 12～128 個字元，且兩次輸入一致。'],MAIL_NOT_CONFIGURED:[503,'尚未完成 Gmail 寄信設定，請管理者先到設定連接寄信信箱。'],
    MAIL_FAILED:[503,'Gmail 尚未確認寄出，請檢查寄信授權並重試。'],NOT_FOUND:[404,'找不到這位成員。'],
  };
  const [status,detail]=errors[code]??[503,'服務暫時無法使用，請稍後再試。'];
  return NextResponse.json({detail,code:errors[code]?code:'SERVICE_UNAVAILABLE'},{status,headers:privateHeaders});
}
