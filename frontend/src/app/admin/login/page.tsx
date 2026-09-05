"use client";

import { useState } from "react";
import { KeyRound, Loader2, Mail, Phone } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  claimWorkspaceMembership,
  sendEmailSignIn,
  sendPhoneSignIn,
  verifyPhoneSignIn,
} from "@/lib/supabase/auth";

type LoginMode = "email" | "phone";

export default function AdminLoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<LoginMode>("email");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [phoneCodeSent, setPhoneCodeSent] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  async function handleEmailSubmit(event: React.FormEvent) {
    event.preventDefault();
    setIsLoading(true);
    const { error } = await sendEmailSignIn(email);
    setIsLoading(false);
    if (error) {
      toast.error("登入信件寄送失敗", { description: error.message });
      return;
    }
    setEmailSent(true);
    toast.success("登入連結已寄出");
  }

  async function handlePhoneSubmit(event: React.FormEvent) {
    event.preventDefault();
    setIsLoading(true);

    if (!phoneCodeSent) {
      const { error } = await sendPhoneSignIn(phone);
      setIsLoading(false);
      if (error) {
        toast.error("驗證碼寄送失敗", {
          description:
            error.message.includes("provider") || error.message.includes("Phone")
              ? "手機登入需要先在 Supabase 啟用 SMS 供應商。"
              : error.message,
        });
        return;
      }
      setPhoneCodeSent(true);
      toast.success("手機驗證碼已寄出");
      return;
    }

    const { error } = await verifyPhoneSignIn(phone, code);
    if (error) {
      setIsLoading(false);
      toast.error("驗證碼不正確", { description: error.message });
      return;
    }

    await claimWorkspaceMembership();
    setIsLoading(false);
    router.replace("/calendar");
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-muted/20 p-4">
      <Card className="w-full max-w-md shadow-sm">
        <CardHeader>
          <div className="mb-2 flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <KeyRound className="size-5" />
          </div>
          <CardTitle>登入 Sweetfun OS</CardTitle>
          <CardDescription>
            使用管理者已授權的電子郵件或手機號碼登入。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-5 grid grid-cols-2 rounded-xl border bg-muted/30 p-1">
            <button
              type="button"
              onClick={() => setMode("email")}
              className={`flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium ${
                mode === "email" ? "bg-background shadow-sm" : "text-muted-foreground"
              }`}
            >
              <Mail className="size-4" />
              Email
            </button>
            <button
              type="button"
              onClick={() => setMode("phone")}
              className={`flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium ${
                mode === "phone" ? "bg-background shadow-sm" : "text-muted-foreground"
              }`}
            >
              <Phone className="size-4" />
              手機
            </button>
          </div>

          {mode === "email" ? (
            <form onSubmit={handleEmailSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">電子信箱</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  placeholder="name@example.com"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    setEmailSent(false);
                  }}
                  required
                />
              </div>
              {emailSent && (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm text-emerald-950">
                  已寄出一次性登入連結，請到信箱開啟。登入後系統會自動認領管理者建立的權限。
                </div>
              )}
              <Button type="submit" className="w-full" disabled={isLoading || !email.trim()}>
                {isLoading && <Loader2 className="size-4 animate-spin" />}
                寄送登入連結
              </Button>
            </form>
          ) : (
            <form onSubmit={handlePhoneSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="phone">手機號碼</Label>
                <Input
                  id="phone"
                  inputMode="tel"
                  autoComplete="tel"
                  placeholder="0912 345 678"
                  value={phone}
                  onChange={(event) => {
                    setPhone(event.target.value);
                    setPhoneCodeSent(false);
                    setCode("");
                  }}
                  required
                  disabled={phoneCodeSent}
                />
                <p className="text-xs text-muted-foreground">
                  台灣 09 開頭號碼會自動轉成 +886 格式。
                </p>
              </div>
              {phoneCodeSent && (
                <div className="space-y-2">
                  <Label htmlFor="phone-code">6 位數驗證碼</Label>
                  <Input
                    id="phone-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={code}
                    onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
                    required
                  />
                </div>
              )}
              <Button
                type="submit"
                className="w-full"
                disabled={isLoading || !phone.trim() || (phoneCodeSent && code.length !== 6)}
              >
                {isLoading && <Loader2 className="size-4 animate-spin" />}
                {phoneCodeSent ? "驗證並登入" : "寄送手機驗證碼"}
              </Button>
              {phoneCodeSent && (
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full"
                  onClick={() => {
                    setPhoneCodeSent(false);
                    setCode("");
                  }}
                >
                  更換手機號碼
                </Button>
              )}
            </form>
          )}

          <p className="mt-5 text-center text-xs leading-5 text-muted-foreground">
            尚未被加入工作區的帳號即使完成驗證，也無法查看訂單資料。
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
