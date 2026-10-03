// Test deployments can finish real email verification before the public domain
// is switched. The target comes only from Vercel's server environment, never
// from a request Host header or applicant input.
export function customerOrigin() {
  if (process.env.CUSTOMER_DEPLOYMENT_LINKS !== "true")
    return "https://sweetfun-os.vercel.app";
  const host = process.env.VERCEL_URL ?? "";
  if (!/^[a-z0-9-]+\.vercel\.app$/.test(host))
    throw new Error("FEATURE_UNAVAILABLE");
  return `https://${host}`;
}
