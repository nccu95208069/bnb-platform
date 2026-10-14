import {cookies} from "next/headers";
import {LanguageProvider} from "@/components/i18n/language-provider";
import {isLocale} from "@/lib/i18n/core";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "next-themes";
import Script from "next/script";
import "./globals.css";
import { CalendarAppearanceProvider } from "@/components/calendar/calendar-appearance";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Sweetfun OS｜訂單與房況日曆",
  description: "水芳 Sweetfun 的月、週、日訂單與房況營運工作台",
};

const fontScaleBootstrap = `try {
  var value = Number(localStorage.getItem("sweetfun-font-scale"));
  if (Number.isInteger(value) && value >= 85 && value <= 130 && value % 5 === 0) {
    document.documentElement.style.setProperty("--sweetfun-root-size", String(value * 0.16) + "px");
  }
} catch {}`;

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const saved=(await cookies()).get("sweetfun-language")?.value;
  const locale=isLocale(saved)?saved:"zh-TW";
  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <Script id="sweetfun-font-scale" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: fontScaleBootstrap }} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem storageKey="sweetfun-theme" disableTransitionOnChange>
          <LanguageProvider initialLocale={locale}>
            <CalendarAppearanceProvider>{children}</CalendarAppearanceProvider>
            <Toaster />
          </LanguageProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
