import { SITE_URL, SITE_NAME, type Locale } from './config';

interface FAQItem {
  question: string;
  answer: string;
}

export function generateFAQSchema(items: FAQItem[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: item.answer,
      },
    })),
  };
}

export function generateWebApplicationSchema(locale: Locale) {
  const names: Record<Locale, string> = {
    en: 'Beyond & Beyond — Digital Legacy Messaging',
    ja: 'Beyond & Beyond — デジタルレガシーメッセージ',
    ko: 'Beyond & Beyond — 디지털 레거시 메시지',
    'zh-tw': 'Beyond & Beyond — 數位遺產訊息',
    es: 'Beyond & Beyond — Mensajería de Legado Digital',
  };

  const descriptions: Record<Locale, string> = {
    en: 'Create and schedule meaningful messages for your loved ones.',
    ja: '大切な人への意味のあるメッセージを作成・スケジュールします。',
    ko: '사랑하는 사람에게 의미 있는 메시지를 만들고 예약하세요.',
    'zh-tw': '為摯愛的人建立並排程有意義的訊息。',
    es: 'Crea y programa mensajes significativos para tus seres queridos.',
  };

  return {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: names[locale],
    description: descriptions[locale],
    url: `${SITE_URL}/${locale}`,
    applicationCategory: 'LifestyleApplication',
    operatingSystem: 'Web',
    offers: {
      '@type': 'AggregateOffer',
      lowPrice: '0',
      highPrice: '29.99',
      priceCurrency: 'USD',
      offerCount: 3,
    },
  };
}

export function generateOrganizationSchema() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: SITE_NAME,
    url: SITE_URL,
    logo: `${SITE_URL}/logo.png`,
    sameAs: [],
    contactPoint: {
      '@type': 'ContactPoint',
      contactType: 'customer service',
      email: 'support@beyondnbeyond.com',
    },
  };
}

interface PricingTier {
  name: string;
  description: string;
  price: string;
  priceCurrency: string;
  billingPeriod?: string;
  features: string[];
}

export function generateProductSchema(tier: PricingTier) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: `${SITE_NAME} — ${tier.name}`,
    description: tier.description,
    brand: {
      '@type': 'Brand',
      name: SITE_NAME,
    },
    offers: {
      '@type': 'Offer',
      price: tier.price,
      priceCurrency: tier.priceCurrency,
      availability: 'https://schema.org/InStock',
      ...(tier.billingPeriod && {
        priceSpecification: {
          '@type': 'UnitPriceSpecification',
          price: tier.price,
          priceCurrency: tier.priceCurrency,
          billingDuration: tier.billingPeriod,
        },
      }),
    },
  };
}

interface BreadcrumbItem {
  name: string;
  href: string;
}

export function generateBreadcrumbSchema(items: BreadcrumbItem[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: item.href.startsWith('http')
        ? item.href
        : `${SITE_URL}${item.href}`,
    })),
  };
}

export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
