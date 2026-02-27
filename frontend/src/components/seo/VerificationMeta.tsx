export function VerificationMeta() {
  const googleVerification = process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION;
  const bingVerification = process.env.NEXT_PUBLIC_BING_SITE_VERIFICATION;

  return (
    <>
      {googleVerification && (
        <meta
          name="google-site-verification"
          content={googleVerification}
        />
      )}
      {bingVerification && (
        <meta
          name="msvalidate.01"
          content={bingVerification}
        />
      )}
    </>
  );
}
