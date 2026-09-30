import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/seo/config';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/api/',
          '/dashboard/',
          '/app/',
          '/auth/',
          '/settings/',
          '/conversations/',
          '/documents/',
        ],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
