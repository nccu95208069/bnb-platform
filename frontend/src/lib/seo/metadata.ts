import type { Metadata } from 'next';
import {
  type Locale,
  SITE_URL,
  SITE_NAME,
  locales,
  localeHrefLangs,
  pageSEO,
} from './config';

export function generatePageMetadata(
  page: string,
  locale: Locale,
  overrides?: Partial<Metadata>
): Metadata {
  const seo = pageSEO[page]?.[locale] ?? pageSEO[page]?.en;
  if (!seo) {
    return { title: SITE_NAME, ...overrides };
  }

  const canonicalPath = page === 'home' ? '' : `/${page}`;
  const canonicalUrl = `${SITE_URL}/${locale}${canonicalPath}`;
  const ogImageUrl =
    seo.ogImage ?? `${SITE_URL}/og/${locale}/${page}.png`;

  const alternates: Record<string, string> = {};
  for (const loc of locales) {
    alternates[localeHrefLangs[loc]] = `${SITE_URL}/${loc}${canonicalPath}`;
  }
  alternates['x-default'] = `${SITE_URL}/en${canonicalPath}`;

  return {
    title: seo.title,
    description: seo.description,
    keywords: seo.keywords,
    alternates: {
      canonical: canonicalUrl,
      languages: alternates,
    },
    openGraph: {
      title: seo.title,
      description: seo.description,
      url: canonicalUrl,
      siteName: SITE_NAME,
      images: [
        {
          url: ogImageUrl,
          width: 1200,
          height: 630,
          alt: seo.title,
        },
      ],
      locale: localeHrefLangs[locale],
      type: 'website',
    },
    twitter: {
      card: 'summary_large_image',
      title: seo.title,
      description: seo.description,
      images: [ogImageUrl],
    },
    robots: {
      index: true,
      follow: true,
      googleBot: {
        index: true,
        follow: true,
        'max-video-preview': -1,
        'max-image-preview': 'large',
        'max-snippet': -1,
      },
    },
    ...overrides,
  };
}

