import { MessageWizard } from "@/components/wizard/MessageWizard";

export default function CreateMessagePage() {
  return (
    <div className="mx-auto max-w-3xl py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold">建立新訊息</h1>
        <p className="mt-1 text-muted-foreground">
          透過以下步驟建立一封安全的訊息給您重要的人。
        </p>
      </div>
      <MessageWizard />
    </div>
  );
}
