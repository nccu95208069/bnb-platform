import { locales } from './config';

export function generateStaticLocaleParams() {
  return locales.map((locale) => ({ locale }));
}

export function generateStaticLocaleSlugParams(slugs: string[]) {
  return locales.flatMap((locale) =>
    slugs.map((slug) => ({ locale, slug }))
  );
}
