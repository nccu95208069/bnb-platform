"use client";

import { Badge } from "@/components/ui/badge";
import type { MessageStatus } from "@/lib/supabase/types";
import { FileEdit, CheckCircle, Send, Undo2 } from "lucide-react";

const statusConfig: Record<
  MessageStatus,
  {
    label: string;
    variant: "default" | "secondary" | "destructive" | "outline";
    icon: React.ElementType;
  }
> = {
  draft: {
    label: "草稿",
    variant: "secondary",
    icon: FileEdit,
  },
  confirmed: {
    label: "已確認",
    variant: "default",
    icon: CheckCircle,
  },
  sent: {
    label: "已寄送",
    variant: "outline",
    icon: Send,
  },
  recalled: {
    label: "已撤回",
    variant: "destructive",
    icon: Undo2,
  },
};

interface MessageStatusBadgeProps {
  status: MessageStatus;
  className?: string;
}

export function MessageStatusBadge({
  status,
  className,
}: MessageStatusBadgeProps) {
  const config = statusConfig[status];
  const Icon = config.icon;

  return (
    <Badge variant={config.variant} className={className}>
      <Icon className="mr-1 h-3 w-3" />
      {config.label}
    </Badge>
  );
}
