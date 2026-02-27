export const locales = ['en', 'ja', 'ko', 'zh-tw', 'es'] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = 'en';

export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://beyondnbeyond.com';
export const SITE_NAME = 'Beyond & Beyond';

export const localeNames: Record<Locale, string> = {
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  'zh-tw': '繁體中文',
  es: 'Español',
};

export const localeHrefLangs: Record<Locale, string> = {
  en: 'en',
  ja: 'ja',
  ko: 'ko',
  'zh-tw': 'zh-Hant-TW',
  es: 'es',
};

export interface PageSEO {
  title: string;
  description: string;
  keywords?: string[];
  ogImage?: string;
}

export const pageSEO: Record<string, Record<Locale, PageSEO>> = {
  home: {
    en: {
      title: 'Beyond & Beyond — Leave Messages for the Future',
      description:
        'Create heartfelt messages for your loved ones, delivered when the time is right. Secure, private, and meaningful.',
      keywords: [
        'future messages',
        'digital legacy',
        'time capsule',
        'letter to loved ones',
      ],
    },
    ja: {
      title: 'Beyond & Beyond — 未来へのメッセージを残す',
      description:
        '大切な人へ心のこもったメッセージを作成し、適切なタイミングで届けます。安全でプライベートな、意味のあるサービスです。',
      keywords: [
        'メッセージ',
        'デジタル遺産',
        'タイムカプセル',
        '手紙',
      ],
    },
    ko: {
      title: 'Beyond & Beyond — 미래를 위한 메시지를 남기세요',
      description:
        '사랑하는 사람들에게 진심 어린 메시지를 만들어 적절한 시기에 전달하세요. 안전하고 프라이빗하며 의미 있는 서비스입니다.',
      keywords: [
        '미래 메시지',
        '디지털 유산',
        '타임캡슐',
        '편지',
      ],
    },
    'zh-tw': {
      title: 'Beyond & Beyond — 留下給未來的訊息',
      description:
        '為摯愛的人撰寫真摯的訊息，在適當的時刻傳遞。安全、私密且充滿意義。',
      keywords: [
        '未來訊息',
        '數位遺產',
        '時空膠囊',
        '給親人的信',
      ],
    },
    es: {
      title: 'Beyond & Beyond — Deja mensajes para el futuro',
      description:
        'Crea mensajes sinceros para tus seres queridos, entregados en el momento adecuado. Seguro, privado y significativo.',
      keywords: [
        'mensajes futuros',
        'legado digital',
        'cápsula del tiempo',
        'carta a seres queridos',
      ],
    },
  },
  pricing: {
    en: {
      title: 'Pricing — Beyond & Beyond',
      description:
        'Choose the plan that fits your needs. Free, Premium, and Family plans available.',
      keywords: ['pricing', 'plans', 'subscription'],
    },
    ja: {
      title: '料金プラン — Beyond & Beyond',
      description:
        'ニーズに合ったプランをお選びください。無料、プレミアム、ファミリープランをご用意。',
      keywords: ['料金', 'プラン', 'サブスクリプション'],
    },
    ko: {
      title: '요금제 — Beyond & Beyond',
      description:
        '필요에 맞는 플랜을 선택하세요. 무료, 프리미엄, 패밀리 플랜을 제공합니다.',
      keywords: ['요금', '플랜', '구독'],
    },
    'zh-tw': {
      title: '方案與價格 — Beyond & Beyond',
      description:
        '選擇最適合您的方案。提供免費、進階及家庭方案。',
      keywords: ['價格', '方案', '訂閱'],
    },
    es: {
      title: 'Precios — Beyond & Beyond',
      description:
        'Elige el plan que se adapte a tus necesidades. Planes Gratuito, Premium y Familiar.',
      keywords: ['precios', 'planes', 'suscripción'],
    },
  },
  about: {
    en: {
      title: 'About — Beyond & Beyond',
      description:
        'Learn about our mission to help people leave meaningful messages for their loved ones.',
      keywords: ['about', 'mission', 'team'],
    },
    ja: {
      title: '私たちについて — Beyond & Beyond',
      description:
        '大切な人への意味のあるメッセージを残すお手伝いをする、私たちのミッションについて。',
      keywords: ['について', 'ミッション', 'チーム'],
    },
    ko: {
      title: '소개 — Beyond & Beyond',
      description:
        '사랑하는 사람에게 의미 있는 메시지를 남기도록 돕는 우리의 미션을 알아보세요.',
      keywords: ['소개', '미션', '팀'],
    },
    'zh-tw': {
      title: '關於我們 — Beyond & Beyond',
      description:
        '了解我們的使命 — 幫助人們為摯愛留下有意義的訊息。',
      keywords: ['關於', '使命', '團隊'],
    },
    es: {
      title: 'Acerca de — Beyond & Beyond',
      description:
        'Conoce nuestra misión de ayudar a las personas a dejar mensajes significativos para sus seres queridos.',
      keywords: ['acerca de', 'misión', 'equipo'],
    },
  },
  faq: {
    en: {
      title: 'FAQ — Beyond & Beyond',
      description:
        'Frequently asked questions about Beyond & Beyond. Learn how it works, security, pricing, and more.',
      keywords: ['FAQ', 'questions', 'help', 'support'],
    },
    ja: {
      title: 'よくある質問 — Beyond & Beyond',
      description:
        'Beyond & Beyondに関するよくある質問。仕組み、セキュリティ、料金などについて。',
      keywords: ['よくある質問', 'FAQ', 'ヘルプ'],
    },
    ko: {
      title: '자주 묻는 질문 — Beyond & Beyond',
      description:
        'Beyond & Beyond에 대한 자주 묻는 질문. 작동 방식, 보안, 요금 등에 대해 알아보세요.',
      keywords: ['자주 묻는 질문', 'FAQ', '도움말'],
    },
    'zh-tw': {
      title: '常見問題 — Beyond & Beyond',
      description:
        '關於 Beyond & Beyond 的常見問題。了解運作方式、安全性、價格等。',
      keywords: ['常見問題', 'FAQ', '幫助'],
    },
    es: {
      title: 'Preguntas Frecuentes — Beyond & Beyond',
      description:
        'Preguntas frecuentes sobre Beyond & Beyond. Aprende cómo funciona, seguridad, precios y más.',
      keywords: ['preguntas frecuentes', 'FAQ', 'ayuda'],
    },
  },
};
