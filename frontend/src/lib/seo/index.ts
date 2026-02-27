export {
  locales,
  defaultLocale,
  localeNames,
  localeHrefLangs,
  SITE_URL,
  SITE_NAME,
  pageSEO,
  type Locale,
  type PageSEO,
} from './config';

export { generatePageMetadata } from './metadata';

export {
  generateFAQSchema,
  generateWebApplicationSchema,
  generateOrganizationSchema,
  generateProductSchema,
  generateBreadcrumbSchema,
  JsonLd,
} from './structured-data';

export {
  generateStaticLocaleParams,
  generateStaticLocaleSlugParams,
} from './static-params';
