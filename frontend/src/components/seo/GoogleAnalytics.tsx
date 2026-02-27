'use client';

import { useEffect, useState } from 'react';
import Script from 'next/script';

const GA_MEASUREMENT_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;

export function GoogleAnalytics() {
  const [hasConsent, setHasConsent] = useState(false);

  useEffect(() => {
    const consent = localStorage.getItem('analytics-consent');
    if (consent === 'granted') {
      setHasConsent(true);
    }
  }, []);

  if (!GA_MEASUREMENT_ID || !hasConsent) {
    return null;
  }

  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`}
        strategy="afterInteractive"
      />
      <Script id="google-analytics" strategy="afterInteractive">
        {`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());
          gtag('config', '${GA_MEASUREMENT_ID}', {
            page_path: window.location.pathname,
          });
        `}
      </Script>
    </>
  );
}

export function grantAnalyticsConsent() {
  localStorage.setItem('analytics-consent', 'granted');
  window.location.reload();
}

export function revokeAnalyticsConsent() {
  localStorage.setItem('analytics-consent', 'denied');
  window.location.reload();
}
