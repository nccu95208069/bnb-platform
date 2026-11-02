import { calendarSessionFor, type CookieRequest } from './workspace-auth/session';

// Time the server I/O outside the React component. The serialized result is the
// public session projection plus a duration; no credential data leaves here.
export async function calendarBootstrapFor(request: CookieRequest) {
  const started = performance.now();
  const session = await calendarSessionFor(request);
  return { session, authMs: performance.now() - started };
}
