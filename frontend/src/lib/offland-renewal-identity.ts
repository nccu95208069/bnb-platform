import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export const RENEWAL_AUDIENCE = 'https://sweetfun-os.vercel.app/api/internal/offland-credential-health';
export const RENEWAL_IDENTITY = 'offland-credential-renewal@essential-truth-478816-v1.iam.gserviceaccount.com';
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export async function authorizedRenewal(header: string | null, keys: JWTVerifyGetKey = googleKeys) {
  if (!header?.startsWith('Bearer ') || header.length > 8192) return false;
  try {
    const { payload } = await jwtVerify(header.slice(7), keys, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: RENEWAL_AUDIENCE, algorithms: ['RS256'], maxTokenAge: '65m',
    });
    return payload.email === RENEWAL_IDENTITY && payload.email_verified === true &&
      typeof payload.sub === 'string' && /^\d+$/.test(payload.sub);
  } catch { return false; }
}
