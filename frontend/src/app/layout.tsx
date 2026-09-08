import {cookies} from "next/headers";
import {LanguageProvider} from "@/components/i18n/language-provider";
import {isLocale} from "@/lib/i18n/core";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
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

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const saved=(await cookies()).get("sweetfun-language")?.value;
  const locale=isLocale(saved)?saved:"zh-TW";
  return (
    <html lang={locale}>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <LanguageProvider initialLocale={locale}><CalendarAppearanceProvider>{children}</CalendarAppearanceProvider>
        <Toaster /></LanguageProvider>
      </body>
    </html>
  );
}
