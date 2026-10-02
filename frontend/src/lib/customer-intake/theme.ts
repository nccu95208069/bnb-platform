export const SERVICE_THEME_COOKIE = "bnb-service-theme-v1";
export type ServiceTheme = "system" | "light" | "dark";
export function serviceTheme(value: unknown): ServiceTheme {
  return value === "light" || value === "dark" ? value : "system";
}
