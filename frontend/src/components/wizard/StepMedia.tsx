"use client";

import { useCallback } from "react";
import { useWizardStore, type MediaFile } from "@/stores/wizardStore";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Upload, X, FileImage, FileVideo, FileAudio, File } from "lucide-react";
import { cn } from "@/lib/utils";
import Image from "next/image";

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const ACCEPTED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/wav",
  "application/pdf",
];

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(type: string) {
  if (type.startsWith("image/")) return FileImage;
  if (type.startsWith("video/")) return FileVideo;
  if (type.startsWith("audio/")) return FileAudio;
  return File;
}

export function StepMedia() {
  const mediaFiles = useWizardStore((s) => s.mediaFiles);
  const addMediaFile = useWizardStore((s) => s.addMediaFile);
  const removeMediaFile = useWizardStore((s) => s.removeMediaFile);
  const nextStep = useWizardStore((s) => s.nextStep);
  const prevStep = useWizardStore((s) => s.prevStep);

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files) return;
      Array.from(files).forEach((file) => {
        if (!ACCEPTED_TYPES.includes(file.type)) return;
        if (file.size > MAX_FILE_SIZE) return;

        const mediaFile: MediaFile = {
          id: crypto.randomUUID(),
          file,
          url: URL.createObjectURL(file),
          name: file.name,
          size: file.size,
          type: file.type,
          status: "uploaded",
        };
        addMediaFile(mediaFile);
      });
    },
    [addMediaFile]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      handleFiles(e.dataTransfer.files);
    },
    [handleFiles]
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>附加媒體</CardTitle>
        <CardDescription>
          上傳照片、影片、音訊或文件（選填）。單檔最大 50MB。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-6">
          <div
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            className={cn(
              "flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-8 transition-colors",
              "hover:border-primary/50 hover:bg-accent/50"
            )}
          >
            <Upload className="h-10 w-10 text-muted-foreground" />
            <div className="text-center">
              <p className="text-sm font-medium">拖放檔案至此處</p>
              <p className="text-xs text-muted-foreground">或點擊選擇檔案</p>
            </div>
            <label>
              <input
                type="file"
                multiple
                accept={ACCEPTED_TYPES.join(",")}
                onChange={(e) => handleFiles(e.target.files)}
                className="hidden"
              />
              <Button variant="outline" size="sm" asChild>
                <span>選擇檔案</span>
              </Button>
            </label>
          </div>

          {mediaFiles.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium">
                已上傳檔案（{mediaFiles.length}）
              </p>
              <div className="space-y-2">
                {mediaFiles.map((file) => {
                  const Icon = getFileIcon(file.type);
                  return (
                    <div
                      key={file.id}
                      className="flex items-center gap-3 rounded-md border p-3"
                    >
                      {file.type.startsWith("image/") ? (
                        <Image
                          src={file.url}
                          alt={file.name}
                          width={48}
                          height={48}
                          className="h-12 w-12 rounded object-cover"
                        />
                      ) : (
                        <div className="flex h-12 w-12 items-center justify-center rounded bg-muted">
                          <Icon className="h-6 w-6 text-muted-foreground" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="truncate text-sm font-medium">
                          {file.name}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {formatFileSize(file.size)}
                        </p>
                      </div>
                      <Badge
                        variant={
                          file.status === "uploaded"
                            ? "secondary"
                            : file.status === "error"
                              ? "destructive"
                              : "outline"
                        }
                      >
                        {file.status === "uploaded"
                          ? "已上傳"
                          : file.status === "error"
                            ? "失敗"
                            : "上傳中"}
                      </Badge>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => removeMediaFile(file.id)}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex justify-between">
            <Button variant="outline" onClick={prevStep}>
              上一步
            </Button>
            <Button onClick={nextStep}>下一步</Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
