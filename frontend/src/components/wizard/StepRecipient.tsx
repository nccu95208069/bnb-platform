"use client";

import { useWizardStore } from "@/stores/wizardStore";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const relationships = [
  { value: "partner", label: "伴侶" },
  { value: "spouse", label: "配偶" },
  { value: "parent", label: "父母" },
  { value: "child", label: "子女" },
  { value: "sibling", label: "兄弟姊妹" },
  { value: "friend", label: "朋友" },
  { value: "colleague", label: "同事" },
  { value: "other", label: "其他" },
];

export function StepRecipient() {
  const recipient = useWizardStore((s) => s.recipient);
  const setRecipient = useWizardStore((s) => s.setRecipient);
  const nextStep = useWizardStore((s) => s.nextStep);

  const isValid =
    recipient.name.trim() !== "" &&
    recipient.email.trim() !== "" &&
    recipient.relationship !== "";

  return (
    <Card>
      <CardHeader>
        <CardTitle>收件人資訊</CardTitle>
        <CardDescription>
          請填寫這封訊息的收件人資訊。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="recipient-name">收件人姓名 *</Label>
              <Input
                id="recipient-name"
                placeholder="請輸入收件人姓名"
                value={recipient.name}
                onChange={(e) => setRecipient({ name: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="recipient-email">電子信箱 *</Label>
              <Input
                id="recipient-email"
                type="email"
                placeholder="name@example.com"
                value={recipient.email}
                onChange={(e) => setRecipient({ email: e.target.value })}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="recipient-relationship">與您的關係 *</Label>
            <Select
              value={recipient.relationship}
              onValueChange={(value) => setRecipient({ relationship: value })}
            >
              <SelectTrigger className="w-full" id="recipient-relationship">
                <SelectValue placeholder="請選擇關係" />
              </SelectTrigger>
              <SelectContent>
                {relationships.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="recipient-note">備註（選填）</Label>
            <Textarea
              id="recipient-note"
              placeholder="任何想補充的備註..."
              value={recipient.note}
              onChange={(e) => setRecipient({ note: e.target.value })}
              rows={3}
            />
          </div>

          <div className="flex justify-end">
            <Button onClick={nextStep} disabled={!isValid}>
              下一步
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
