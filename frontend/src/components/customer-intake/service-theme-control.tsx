"use client";

import { Moon, Sun, Monitor } from "lucide-react";
import {
  SERVICE_THEME_COOKIE,
  serviceTheme,
  type ServiceTheme,
} from "../../lib/customer-intake/theme";

export function ServiceThemeControl({
  value,
  onChange,
}: {
  value: ServiceTheme;
  onChange: (value: ServiceTheme) => void;
}) {
  const Icon = value === "dark" ? Moon : value === "light" ? Sun : Monitor;
  const label = { system: "跟隨系統", light: "淺色模式", dark: "深色模式" }[value];
  return (
    <label className="service-theme-control" title={`外觀：${label}`}>
      <Icon size={19} aria-hidden />
      <select
        aria-label="外觀模式"
        value={value}
        onChange={(event) => {
          const next = serviceTheme(event.target.value);
          onChange(next);
          try {
            // The server reads this preference so reloads start in the chosen theme.
            document.cookie = `${SERVICE_THEME_COOKIE}=${next}; Path=/join; Max-Age=31536000; SameSite=Lax${window.location.protocol === "https:" ? "; Secure" : ""}`;
          } catch {
            // Theme switching still works for this visit when cookies are blocked.
          }
        }}
      >
        <option value="system">跟隨系統</option>
        <option value="light">淺色模式</option>
        <option value="dark">深色模式</option>
      </select>
    </label>
  );
}
