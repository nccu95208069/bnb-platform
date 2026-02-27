"use client";

import { useState } from "react";
import { useWizardStore } from "@/stores/wizardStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Check, Copy, Shield, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

function generateAccessToken(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let token = "";
  const array = new Uint8Array(24);
  crypto.getRandomValues(array);
  for (const byte of array) {
    token += chars[byte % chars.length];
  }
  return token;
}

export function StepConfirm() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [copied, setCopied] = useState(false);

  const recipient = useWizardStore((s) => s.recipient);
  const content = useWizardStore((s) => s.content);
  const mediaFiles = useWizardStore((s) => s.mediaFiles);
  const accessToken = useWizardStore((s) => s.accessToken);
  const setAccessToken = useWizardStore((s) => s.setAccessToken);
  const prevStep = useWizardStore((s) => s.prevStep);
  const reset = useWizardStore((s) => s.reset);

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      const token = generateAccessToken();
      setAccessToken(token);
      // TODO: API call to save the message
      await new Promise((resolve) => setTimeout(resolve, 1500));
      setIsSubmitted(true);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCopy = async () => {
    if (!accessToken) return;
    await navigator.clipboard.writeText(accessToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (isSubmitted && accessToken) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
              <Check className="h-5 w-5 text-green-600 dark:text-green-400" />
            </div>
            <div>
              <CardTitle>訊息已建立</CardTitle>
              <CardDescription>
                您的訊息已安全儲存。請妥善保管存取金鑰。
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-6">
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-900/20">
              <div className="mb-2 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                  重要提醒
                </p>
              </div>
              <p className="text-sm text-amber-700 dark:text-amber-300">
                此金鑰只會顯示一次，請立即複製並保存在安全的地方。收件人需要此金鑰才能查看訊息。
              </p>
            </div>

            <div className="space-y-2">
              <Label>存取金鑰</Label>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={accessToken}
                  className="font-mono text-sm"
                />
                <Button variant="outline" onClick={handleCopy}>
                  {copied ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>

            <div className="rounded-md bg-muted p-4">
              <p className="mb-2 text-sm font-medium">訊息摘要</p>
              <div className="space-y-1 text-sm text-muted-foreground">
                <p>收件人：{recipient.name}</p>
                <p>標題：{content.title}</p>
                <p>附件：{mediaFiles.length} 個</p>
              </div>
            </div>

            <Button onClick={reset} className="w-full">
              建立新訊息
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>最終確認</CardTitle>
        <CardDescription>
          請確認所有資訊正確無誤後，點擊送出。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-6">
          <div className="space-y-4">
            <div className="rounded-md border p-4">
              <p className="mb-2 text-sm font-medium">收件人</p>
              <div className="space-y-1 text-sm text-muted-foreground">
                <p>姓名：{recipient.name}</p>
                <p>信箱：{recipient.email}</p>
                <p>關係：{recipient.relationship}</p>
                {recipient.note && <p>備註：{recipient.note}</p>}
              </div>
            </div>

            <div className="rounded-md border p-4">
              <p className="mb-2 text-sm font-medium">訊息</p>
              <div className="space-y-1 text-sm text-muted-foreground">
                <p>標題：{content.title}</p>
                <p>字型：{content.fontFamily}</p>
              </div>
            </div>

            {mediaFiles.length > 0 && (
              <div className="rounded-md border p-4">
                <p className="mb-2 text-sm font-medium">
                  附件（{mediaFiles.length}）
                </p>
                <div className="flex flex-wrap gap-2">
                  {mediaFiles.map((f) => (
                    <Badge key={f.id} variant="secondary">
                      {f.name}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div
            className={cn(
              "flex items-start gap-3 rounded-lg border p-4",
              "bg-muted"
            )}
          >
            <Shield className="mt-0.5 h-5 w-5 text-primary" />
            <div className="text-sm">
              <p className="font-medium">安全保障</p>
              <p className="text-muted-foreground">
                您的訊息將被加密儲存，只有持有存取金鑰的收件人能夠查看。
              </p>
            </div>
          </div>

          <div className="flex justify-between">
            <Button variant="outline" onClick={prevStep}>
              上一步
            </Button>
            <Button onClick={handleSubmit} disabled={isSubmitting}>
              {isSubmitting ? "送出中..." : "確認送出"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
