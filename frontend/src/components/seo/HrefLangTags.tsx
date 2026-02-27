import { locales, localeHrefLangs, SITE_URL, type Locale } from '@/lib/seo/config';

interface HrefLangTagsProps {
  path: string;
  currentLocale: Locale;
}

export function HrefLangTags({ path }: HrefLangTagsProps) {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;

  return (
    <>
      {locales.map((locale) => (
        <link
          key={locale}
          rel="alternate"
          hrefLang={localeHrefLangs[locale]}
          href={`${SITE_URL}/${locale}${cleanPath}`}
        />
      ))}
      <link
        rel="alternate"
        hrefLang="x-default"
        href={`${SITE_URL}/en${cleanPath}`}
      />
    </>
  );
}
