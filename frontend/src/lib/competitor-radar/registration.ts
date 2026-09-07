const URL_LIKE = /(?:^[a-z][a-z0-9+.-]*:\/\/|\.(?:com|net|org|tw|io|app)(?:\/|$))/i;
const REGISTRATION_LABEL = /(?:登記(?:證)?|證號|字號|編號|registration|licen[cs]e)/i;
const CODE = "[A-Z]?\\d{1,10}(?:-\\d+)?";
const CHINESE_LODGING_NUMBER = new RegExp(
  `^(?:(?:臺|台|新北|宜蘭|花蓮|臺東|台東|澎湖|金門|連江)?[^:：\\s]{0,12})?(?:民宿|旅館)(?:登記(?:證)?|證號|字號|編號)?[:：]?(?:第)?${CODE}號?$`,
  "i",
);
const LABELED_NUMBER = new RegExp(
  `^(?:[^:：\\s]{0,24})?(?:登記(?:證)?|證號|字號|編號|registration|licen[cs]e)(?:no\\.?|number)?[:：#-]?(?:第)?${CODE}號?$`,
  "i",
);
const BARE_CODE = new RegExp(`^${CODE}號?$`, "i");

function compact(value: string): string {
  return value
    .normalize("NFKC")
    .replaceAll("台", "臺")
    .replace(/\s+/g, "")
    .trim();
}

export function isRegistrationLabel(value: string | undefined): boolean {
  return Boolean(value && REGISTRATION_LABEL.test(value));
}

/**
 * Fail-closed registration-shape check.
 *
 * Generic brand identifiers such as `Hotel 81`, bare URLs, and arbitrary
 * numeric JSON-LD identifiers are intentionally rejected. A bare code is only
 * accepted by `registrationFromLabeledValue` when a separate field label
 * explicitly says registration/license.
 */
export function isPlausibleRegistrationNumber(value: string | undefined): boolean {
  if (!value) return false;
  const candidate = compact(value);
  if (!candidate || URL_LIKE.test(candidate)) return false;
  if (/(?:電話|手機|fax|tel)/i.test(candidate)) return false;
  return CHINESE_LODGING_NUMBER.test(candidate) || LABELED_NUMBER.test(candidate);
}

export function registrationFromLabeledValue(
  label: string | undefined,
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  if (isPlausibleRegistrationNumber(value)) return value.trim();
  if (!isRegistrationLabel(label)) return undefined;

  const candidate = compact(value);
  if (URL_LIKE.test(candidate) || !BARE_CODE.test(candidate)) return undefined;
  return `${label?.trim()}: ${value.trim()}`;
}
