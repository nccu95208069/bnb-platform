"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Mail, Phone } from "lucide-react";
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
import { claimWorkspaceMembership, useAccessControl } from "@/lib/access-control";
import {
  requestPhoneOtp,
  signInWithEmail,
  signOut,
  signUpWithEmail,
  verifyPhoneOtp,
} from "@/lib/supabase/auth";
import { cn } from "@/lib/utils";

type LoginMode = "email" | "phone";

async function ensureMembership() {
  const data = (await claimWorkspaceMembership()) as {
    memberships?: unknown[];
  } | null;
  if (!data?.memberships?.length) {
    await signOut();
    throw new Error("這個帳號尚未被旅宿擁有者加入。請確認使用相同 Email 或手機登入。");
  }
}

export default function AdminLoginPage() {
  const router = useRouter();
  const resetAccess = useAccessControl((state) => state.reset);
  const [mode, setMode] = useState<LoginMode>("email");
  const [emailAction, setEmailAction] = useState<"login" | "activate">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  async function finishLogin() {
    await ensureMembership();
    resetAccess();
    router.replace("/calendar");
    router.refresh();
  }

  async function handleEmailSubmit(event: FormEvent) {
    event.preventDefault();
    setIsLoading(true);
    try {
      if (emailAction === "activate") {
        const { data, error } = await signUpWithEmail(email, password);
        if (error) throw error;
        if (!data.session) {
          toast.success("啟用信已寄出", {
            description: "請從 Email 完成驗證後，再回來登入。",
          });
          setEmailAction("login");
          return;
        }
      } else {
        const { error } = await signInWithEmail(email, password);
        if (error) throw error;
      }
      await finishLogin();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "登入失敗");
    } finally {
      setIsLoading(false);
    }
  }

  async function handlePhoneSubmit(event: FormEvent) {
    event.preventDefault();
    setIsLoading(true);
    try {
      if (!otpSent) {
        const { error } = await requestPhoneOtp(phone);
        if (error) throw error;
        setOtpSent(true);
        toast.success("驗證碼已寄出");
        return;
      }

      const { error } = await verifyPhoneOtp(phone, otp);
      if (error) throw error;
      await finishLogin();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "手機驗證失敗");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-muted/25 p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mb-2 flex size-10 items-center justify-center rounded-xl bg-primary font-bold text-primary-foreground">
            SF
          </div>
          <CardTitle>登入 Sweetfun OS</CardTitle>
          <CardDescription>
            請使用擁有者已加入的 Email 或手機登入。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-5 grid grid-cols-2 rounded-xl border bg-muted/35 p-1">
            <button
              type="button"
              onClick={() => setMode("email")}
              className={cn(
                "flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold",
                mode === "email"
                  ? "bg-background shadow-sm"
                  : "text-muted-foreground",
              )}
            >
              <Mail className="size-4" />
              Email
            </button>
            <button
              type="button"
              onClick={() => setMode("phone")}
              className={cn(
                "flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold",
                mode === "phone"
                  ? "bg-background shadow-sm"
                  : "text-muted-foreground",
              )}
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
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">密碼</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete={emailAction === "login" ? "current-password" : "new-password"}
                  minLength={8}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </div>
              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading && <Loader2 className="size-4 animate-spin" />}
                {emailAction === "login" ? "登入" : "建立並啟用帳號"}
              </Button>
              <button
                type="button"
                className="w-full text-center text-sm text-muted-foreground hover:text-foreground"
                onClick={() =>
                  setEmailAction((current) =>
                    current === "login" ? "activate" : "login",
                  )
                }
              >
                {emailAction === "login"
                  ? "第一次登入？建立密碼"
                  : "已有密碼？返回登入"}
              </button>
            </form>
          ) : (
            <form onSubmit={handlePhoneSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="phone">手機號碼</Label>
                <Input
                  id="phone"
                  type="tel"
                  autoComplete="tel"
                  placeholder="+886912345678"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  disabled={otpSent}
                  required
                />
                <p className="text-xs text-muted-foreground">
                  請使用含國碼的 E.164 格式。
                </p>
              </div>
              {otpSent && (
                <div className="space-y-2">
                  <Label htmlFor="otp">簡訊驗證碼</Label>
                  <Input
                    id="otp"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={otp}
                    onChange={(event) => setOtp(event.target.value)}
                    required
                  />
                </div>
              )}
              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading && <Loader2 className="size-4 animate-spin" />}
                {otpSent ? "驗證並登入" : "取得驗證碼"}
              </Button>
              {otpSent && (
                <button
                  type="button"
                  className="w-full text-center text-sm text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setOtpSent(false);
                    setOtp("");
                  }}
                >
                  更換手機號碼
                </button>
              )}
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
