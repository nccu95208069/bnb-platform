'use client';

import { useState } from 'react';
import {
  grantAnalyticsConsent,
  revokeAnalyticsConsent,
} from './GoogleAnalytics';

export function CookieConsent() {
  const [showBanner, setShowBanner] = useState(() => {
    if (typeof window === 'undefined') return false;
    return !localStorage.getItem('analytics-consent');
  });

  if (!showBanner) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 border-t bg-background p-4 shadow-lg">
      <div className="mx-auto flex max-w-4xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          We use cookies to analyze site usage and improve your experience.
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => {
              revokeAnalyticsConsent();
              setShowBanner(false);
            }}
            className="rounded-md border px-4 py-2 text-sm hover:bg-muted"
          >
            Decline
          </button>
          <button
            onClick={() => {
              grantAnalyticsConsent();
              setShowBanner(false);
            }}
            className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90"
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
