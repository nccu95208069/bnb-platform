// Test deployments can finish real email verification before the public domain
// is switched. The target comes only from the server environment, never
// from a request Host header or applicant input.
export function customerOrigin() {
  if (process.env.CUSTOMER_DEPLOYMENT_LINKS !== "true")
    return "https://sweetfun-os.vercel.app";
  // A protected stable alias keeps email proof cookies on the same origin as
  // the registered Google callback across candidate deployments.
  const origin = process.env.CUSTOMER_DEPLOYMENT_ORIGIN;
  if (origin !== undefined) {
    if (!/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin))
      throw new Error("FEATURE_UNAVAILABLE");
    return origin;
  }
  const host = process.env.VERCEL_URL ?? "";
  if (!/^[a-z0-9-]+\.vercel\.app$/.test(host))
    throw new Error("FEATURE_UNAVAILABLE");
  return `https://${host}`;
}
