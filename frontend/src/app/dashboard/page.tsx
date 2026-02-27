import Link from "next/link";
import { Button } from "@/components/ui/button";
import { MessageList } from "@/components/dashboard/MessageList";
import { PenLine } from "lucide-react";

export default function DashboardPage() {
  return (
    <div className="mx-auto max-w-4xl py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">我的訊息</h1>
          <p className="mt-1 text-muted-foreground">
            管理您建立的所有訊息。
          </p>
        </div>
        <Button asChild>
          <Link href="/dashboard/create">
            <PenLine className="mr-2 h-4 w-4" />
            建立新訊息
          </Link>
        </Button>
      </div>
      <MessageList />
    </div>
  );
}
