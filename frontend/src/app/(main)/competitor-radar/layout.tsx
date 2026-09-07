"use client";

import type { ReactNode } from "react";

import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useActorPermissions } from "@/lib/access-control";

export default function CompetitorRadarLayout({ children }: { children: ReactNode }) {
  const permissions = useActorPermissions();

  if (!permissions.viewPrices) {
    return (
      <Card className="mx-auto max-w-xl">
        <CardHeader>
          <CardTitle>沒有權限</CardTitle>
          <CardDescription>
            此工具會顯示競品價格，無價格權限的角色不可使用。
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return children;
}
