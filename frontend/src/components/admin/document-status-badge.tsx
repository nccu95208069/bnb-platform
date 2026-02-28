"use client";

import { Badge } from "@/components/ui/badge";
import type { DocumentStatus } from "@/lib/types";
import { Clock, Loader2, CheckCircle, XCircle } from "lucide-react";

const statusConfig: Record<
  DocumentStatus,
  {
    label: string;
    variant: "default" | "secondary" | "destructive" | "outline";
    icon: React.ElementType;
  }
> = {
  pending: {
    label: "等待中",
    variant: "secondary",
    icon: Clock,
  },
  processing: {
    label: "處理中",
    variant: "default",
    icon: Loader2,
  },
  completed: {
    label: "完成",
    variant: "outline",
    icon: CheckCircle,
  },
  failed: {
    label: "失敗",
    variant: "destructive",
    icon: XCircle,
  },
};

interface DocumentStatusBadgeProps {
  status: DocumentStatus;
  className?: string;
}

export function DocumentStatusBadge({
  status,
  className,
}: DocumentStatusBadgeProps) {
  const config = statusConfig[status];
  const Icon = config.icon;

  return (
    <Badge variant={config.variant} className={className}>
      <Icon
        className={`mr-1 h-3 w-3 ${status === "processing" ? "animate-spin" : ""}`}
      />
      {config.label}
    </Badge>
  );
}
