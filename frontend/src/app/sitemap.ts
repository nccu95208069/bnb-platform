import type { MetadataRoute } from 'next';
import { locales, SITE_URL, localeHrefLangs } from '@/lib/seo/config';

type ChangeFrequency =
  | 'always'
  | 'hourly'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'yearly'
  | 'never';

interface SitemapPage {
  path: string;
  changeFrequency: ChangeFrequency;
  priority: number;
  lastModified?: Date;
}

const marketingPages: SitemapPage[] = [
  { path: '', changeFrequency: 'weekly', priority: 1.0 },
  { path: '/pricing', changeFrequency: 'monthly', priority: 0.8 },
  { path: '/about', changeFrequency: 'monthly', priority: 0.7 },
  { path: '/faq', changeFrequency: 'monthly', priority: 0.7 },
  { path: '/terms', changeFrequency: 'yearly', priority: 0.3 },
  { path: '/privacy', changeFrequency: 'yearly', priority: 0.3 },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const entries: MetadataRoute.Sitemap = [];

  for (const page of marketingPages) {
    for (const locale of locales) {
      const url = `${SITE_URL}/${locale}${page.path}`;
      const alternates: Record<string, string> = {};

      for (const altLocale of locales) {
        alternates[localeHrefLangs[altLocale]] =
          `${SITE_URL}/${altLocale}${page.path}`;
      }

      entries.push({
        url,
        lastModified: page.lastModified ?? new Date(),
        changeFrequency: page.changeFrequency,
        priority: page.priority,
        alternates: {
          languages: alternates,
        },
      });
    }
  }

  return entries;
}
