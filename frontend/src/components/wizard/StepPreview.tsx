"use client";

import { useState } from "react";
import { useWizardStore } from "@/stores/wizardStore";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Monitor, Smartphone, FileImage, FileVideo, FileAudio, File } from "lucide-react";
import { cn } from "@/lib/utils";
import Image from "next/image";

const relationships: Record<string, string> = {
  partner: "伴侶",
  spouse: "配偶",
  parent: "父母",
  child: "子女",
  sibling: "兄弟姊妹",
  friend: "朋友",
  colleague: "同事",
  other: "其他",
};

function getFileIcon(type: string) {
  if (type.startsWith("image/")) return FileImage;
  if (type.startsWith("video/")) return FileVideo;
  if (type.startsWith("audio/")) return FileAudio;
  return File;
}

export function StepPreview() {
  const [viewMode, setViewMode] = useState<"desktop" | "mobile">("desktop");
  const recipient = useWizardStore((s) => s.recipient);
  const content = useWizardStore((s) => s.content);
  const mediaFiles = useWizardStore((s) => s.mediaFiles);
  const nextStep = useWizardStore((s) => s.nextStep);
  const prevStep = useWizardStore((s) => s.prevStep);

  const fontClass =
    content.fontFamily === "serif"
      ? "font-serif"
      : content.fontFamily === "monospace"
        ? "font-mono"
        : content.fontFamily === "sans-serif"
          ? "font-sans"
          : "";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>訊息預覽</CardTitle>
            <CardDescription>確認收件人看到的訊息樣貌。</CardDescription>
          </div>
          <div className="flex items-center gap-1 rounded-md border p-1">
            <button
              type="button"
              onClick={() => setViewMode("desktop")}
              className={cn(
                "rounded p-1.5 transition-colors",
                viewMode === "desktop" && "bg-accent"
              )}
            >
              <Monitor className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setViewMode("mobile")}
              className={cn(
                "rounded p-1.5 transition-colors",
                viewMode === "mobile" && "bg-accent"
              )}
            >
              <Smartphone className="h-4 w-4" />
            </button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-6">
          <div className="flex justify-center">
            <div
              className={cn(
                "rounded-lg border bg-background shadow-sm transition-all",
                viewMode === "desktop" ? "w-full max-w-2xl" : "w-full max-w-sm"
              )}
            >
              {/* Header */}
              <div className="border-b px-6 py-4">
                <p className="text-xs text-muted-foreground">
                  致 {recipient.name}（{relationships[recipient.relationship] || recipient.relationship}）
                </p>
              </div>

              {/* Content */}
              <div className={cn("px-6 py-6", fontClass)}>
                <h2 className="mb-4 text-xl font-semibold">{content.title}</h2>
                <div
                  className="prose prose-sm dark:prose-invert max-w-none"
                  dangerouslySetInnerHTML={{ __html: content.body }}
                />
              </div>

              {/* Media */}
              {mediaFiles.length > 0 && (
                <div className="border-t px-6 py-4">
                  <p className="mb-2 text-xs font-medium text-muted-foreground">
                    附件（{mediaFiles.length}）
                  </p>
                  <div className="grid grid-cols-3 gap-2">
                    {mediaFiles.map((file) => {
                      const Icon = getFileIcon(file.type);
                      return file.type.startsWith("image/") ? (
                        <Image
                          key={file.id}
                          src={file.url}
                          alt={file.name}
                          width={200}
                          height={200}
                          className="aspect-square rounded object-cover"
                        />
                      ) : (
                        <div
                          key={file.id}
                          className="flex aspect-square flex-col items-center justify-center rounded bg-muted"
                        >
                          <Icon className="h-6 w-6 text-muted-foreground" />
                          <p className="mt-1 truncate px-1 text-[10px] text-muted-foreground">
                            {file.name}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Footer */}
              {recipient.note && (
                <div className="border-t px-6 py-3">
                  <p className="text-xs text-muted-foreground">
                    {recipient.note}
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Summary */}
          <div className="rounded-md bg-muted p-4">
            <p className="mb-2 text-sm font-medium">摘要</p>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">收件人：{recipient.name}</Badge>
              <Badge variant="outline">
                關係：{relationships[recipient.relationship] || recipient.relationship}
              </Badge>
              <Badge variant="outline">
                附件：{mediaFiles.length} 個
              </Badge>
            </div>
          </div>

          <div className="flex justify-between">
            <Button variant="outline" onClick={prevStep}>
              上一步
            </Button>
            <Button onClick={nextStep}>確認並繼續</Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
