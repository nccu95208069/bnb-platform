"use client";

import { useState, useEffect } from "react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
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
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiClient, ApiError } from "@/lib/api-client";
import type { SettingsResponse, SettingsUpdate } from "@/lib/types";
import { Save, Loader2, Eye, EyeOff, Check } from "lucide-react";
import { toast } from "sonner";

export default function SettingsPage() {
  const [loaded, setLoaded] = useState<SettingsResponse | null>(null);
  const [formValues, setFormValues] = useState<SettingsUpdate>({
    llm_provider: "claude",
    line_channel_id: "",
    google_calendar_enabled: false,
    google_sheets_enabled: false,
  });
  const [secretInputs, setSecretInputs] = useState({
    llm_api_key: "",
    line_channel_secret: "",
    line_access_token: "",
  });
  const [systemPrompt, setSystemPrompt] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});

  useEffect(() => {
    loadSettings();
  }, []);

  async function loadSettings() {
    try {
      const [settingsData, promptData] = await Promise.all([
        apiClient.get<SettingsResponse>("/settings"),
        apiClient.get<{ system_prompt: string }>("/settings/system-prompt"),
      ]);
      setLoaded(settingsData);
      setFormValues({
        llm_provider: settingsData.llm_provider,
        line_channel_id: settingsData.line_channel_id,
        google_calendar_enabled: settingsData.google_calendar_enabled,
        google_sheets_enabled: settingsData.google_sheets_enabled,
      });
      setSystemPrompt(promptData.system_prompt || "");
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        // No settings yet, use defaults
      } else {
        toast.error("載入設定失敗");
      }
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSave() {
    setIsSaving(true);
    try {
      const update: SettingsUpdate = { ...formValues };
      if (secretInputs.llm_api_key) {
        update.llm_api_key = secretInputs.llm_api_key;
      }
      if (secretInputs.line_channel_secret) {
        update.line_channel_secret = secretInputs.line_channel_secret;
      }
      if (secretInputs.line_access_token) {
        update.line_access_token = secretInputs.line_access_token;
      }

      await Promise.all([
        apiClient.post("/settings", update),
        apiClient.post("/settings/system-prompt", {
          system_prompt: systemPrompt,
        }),
      ]);
      toast.success("設定已儲存");
      setSecretInputs({
        llm_api_key: "",
        line_channel_secret: "",
        line_access_token: "",
      });
      await loadSettings();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "儲存失敗");
    } finally {
      setIsSaving(false);
    }
  }

  function toggleSecret(key: string) {
    setShowSecrets((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="設定"
        description="管理 LLM、渠道與 Google 服務串接設定"
        actions={
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            儲存設定
          </Button>
        }
      />

      <Tabs defaultValue="llm">
        <TabsList>
          <TabsTrigger value="llm">LLM 設定</TabsTrigger>
          <TabsTrigger value="channels">渠道設定</TabsTrigger>
          <TabsTrigger value="google">Google 串接</TabsTrigger>
          <TabsTrigger value="prompt">系統提示詞</TabsTrigger>
        </TabsList>

        <TabsContent value="llm" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>LLM Provider</CardTitle>
              <CardDescription>
                選擇語言模型提供者及設定 API 金鑰
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="provider">Provider</Label>
                <Select
                  value={formValues.llm_provider}
                  onValueChange={(v) =>
                    setFormValues((prev) => ({
                      ...prev,
                      llm_provider: v as "claude" | "gemini",
                    }))
                  }
                >
                  <SelectTrigger id="provider">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="claude">Claude (Anthropic)</SelectItem>
                    <SelectItem value="gemini">Gemini (Google)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <SecretField
                id="api-key"
                label="API Key"
                value={secretInputs.llm_api_key}
                isSet={loaded?.llm_api_key_set ?? false}
                show={showSecrets["llm_api_key"] ?? false}
                onToggle={() => toggleSecret("llm_api_key")}
                onChange={(v) =>
                  setSecretInputs((prev) => ({ ...prev, llm_api_key: v }))
                }
                placeholder={
                  formValues.llm_provider === "claude"
                    ? "sk-ant-..."
                    : "AIza..."
                }
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="channels" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>LINE Messaging API</CardTitle>
              <CardDescription>
                設定 LINE Official Account 的 Messaging API 憑證
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="line-channel-id">Channel ID</Label>
                <Input
                  id="line-channel-id"
                  value={formValues.line_channel_id ?? ""}
                  onChange={(e) =>
                    setFormValues((prev) => ({
                      ...prev,
                      line_channel_id: e.target.value,
                    }))
                  }
                  placeholder="1234567890"
                />
              </div>
              <SecretField
                id="line-channel-secret"
                label="Channel Secret"
                value={secretInputs.line_channel_secret}
                isSet={loaded?.line_channel_secret_set ?? false}
                show={showSecrets["line_channel_secret"] ?? false}
                onToggle={() => toggleSecret("line_channel_secret")}
                onChange={(v) =>
                  setSecretInputs((prev) => ({
                    ...prev,
                    line_channel_secret: v,
                  }))
                }
              />
              <SecretField
                id="line-access-token"
                label="Access Token"
                value={secretInputs.line_access_token}
                isSet={loaded?.line_access_token_set ?? false}
                show={showSecrets["line_access_token"] ?? false}
                onToggle={() => toggleSecret("line_access_token")}
                onChange={(v) =>
                  setSecretInputs((prev) => ({
                    ...prev,
                    line_access_token: v,
                  }))
                }
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="google" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Google 服務串接</CardTitle>
              <CardDescription>
                啟用 Google Calendar 和 Sheets 整合
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Google Calendar</Label>
                  <p className="text-sm text-muted-foreground">
                    自動同步訂房資訊到 Google 日曆
                  </p>
                </div>
                <Switch
                  checked={formValues.google_calendar_enabled ?? false}
                  onCheckedChange={(v) =>
                    setFormValues((prev) => ({
                      ...prev,
                      google_calendar_enabled: v,
                    }))
                  }
                />
              </div>
              <Separator />
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Google Sheets</Label>
                  <p className="text-sm text-muted-foreground">
                    記錄對話資料到 Google 試算表
                  </p>
                </div>
                <Switch
                  checked={formValues.google_sheets_enabled ?? false}
                  onCheckedChange={(v) =>
                    setFormValues((prev) => ({
                      ...prev,
                      google_sheets_enabled: v,
                    }))
                  }
                />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="prompt" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>系統提示詞</CardTitle>
              <CardDescription>
                自訂 LLM 的 system prompt，定義 AI 助手的行為和回覆風格
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="你是一個民宿的 AI 客服助手，請用友善、專業的語氣回覆客人的問題..."
                className="min-h-[300px] font-mono text-sm"
              />
              <p className="mt-2 text-xs text-muted-foreground">
                此提示詞會作為 AI 回覆的前置指令
              </p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SecretField({
  id,
  label,
  value,
  isSet,
  show,
  onToggle,
  onChange,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  isSet: boolean;
  show: boolean;
  onToggle: () => void;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Label htmlFor={id}>{label}</Label>
        {isSet && !value && (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Check className="h-3 w-3 text-green-600" />
            已設定
          </span>
        )}
      </div>
      <div className="relative">
        <Input
          id={id}
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={isSet ? "留空保持不變" : placeholder}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute right-0 top-0"
          onClick={onToggle}
        >
          {show ? (
            <EyeOff className="h-4 w-4" />
          ) : (
            <Eye className="h-4 w-4" />
          )}
        </Button>
      </div>
    </div>
  );
}
