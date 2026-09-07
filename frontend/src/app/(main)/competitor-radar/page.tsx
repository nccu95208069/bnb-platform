"use client";

import { useMemo, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  FileCheck2,
  Globe2,
  Loader2,
  MapPin,
  Plus,
  Radar,
  Save,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api-client";
import type {
  CanonicalRoomDraft,
  CompetitorRadarAnalysis,
  IdentityEvidence,
  PlatformKey,
  PlatformSourceDraft,
} from "@/lib/competitor-radar/types";
import { cn } from "@/lib/utils";

const PLATFORM_ORDER: PlatformKey[] = ["official", "booking", "agoda", "trip"];

const PLATFORM_SHORT_LABELS: Record<PlatformKey, string> = {
  official: "官網",
  booking: "Booking",
  agoda: "Agoda",
  trip: "Trip.com",
};

const ORIGIN_LABELS: Record<CanonicalRoomDraft["origin"], string> = {
  website_detail: "官網詳情頁",
  website_jsonld: "官網結構化資料",
  website_listing: "官網房型列表",
  golden_fixture: "Golden fixture",
  manual: "使用者新增",
};

function scoreLabel(score: number) {
  return `${Math.round(score * 100)}%`;
}

function sourceStatusLabel(source: PlatformSourceDraft) {
  if (source.status === "discovered") return "已取得";
  if (source.status === "identity_review") return "待確認同一住宿";
  if (source.status === "fetch_failed") return "取得失敗";
  return "Adapter 待接入";
}

function sourceStatusVariant(source: PlatformSourceDraft) {
  if (source.status === "discovered") return "default" as const;
  if (source.status === "fetch_failed") return "destructive" as const;
  return "secondary" as const;
}

function evidenceIcon(evidence: IdentityEvidence) {
  if (evidence.strength === "conflict") {
    return <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />;
  }
  return <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />;
}

function dateRange(start: string, days: number) {
  const result: string[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  for (let index = 0; index < days; index += 1) {
    result.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

function formatDate(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  return new Intl.DateTimeFormat("zh-TW", {
    month: "numeric",
    day: "numeric",
    weekday: "short",
    timeZone: "UTC",
  }).format(date);
}

function PlatformCell({ source }: { source?: PlatformSourceDraft }) {
  if (!source) return <span className="text-xs text-muted-foreground">未建立</span>;
  return (
    <div className="space-y-1">
      <Badge variant={sourceStatusVariant(source)}>{sourceStatusLabel(source)}</Badge>
      {source.sourceUrl && (
        <a
          href={source.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="flex max-w-36 items-center gap-1 truncate text-[11px] text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="size-3 shrink-0" />
          查看候選
        </a>
      )}
    </div>
  );
}

export default function CompetitorRadarPage() {
  const [url, setUrl] = useState("https://www.sweetfuntw.com/");
  const [analysis, setAnalysis] = useState<CompetitorRadarAnalysis | null>(null);
  const [rooms, setRooms] = useState<CanonicalRoomDraft[]>([]);
  const [activePlatform, setActivePlatform] = useState<PlatformKey>("official");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sourceByPlatform = useMemo(
    () =>
      new Map<PlatformKey, PlatformSourceDraft>(
        analysis?.platformSources.map((source) => [source.platform, source] as const) ?? [],
      ),
    [analysis],
  );

  const dates = useMemo(
    () =>
      analysis
        ? dateRange(analysis.dateWindow.start, analysis.dateWindow.days)
        : [],
    [analysis],
  );

  async function analyze(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const result = await apiClient.post<CompetitorRadarAnalysis>(
        "/competitor-radar/analyze",
        { url },
      );
      setAnalysis(result);
      setRooms(result.canonicalRooms);
      setActivePlatform("official");
      toast.success("已建立住宿與房型草稿", {
        description: `辨識到 ${result.canonicalRooms.length} 個房型，請先檢查後再接入 OTA。`,
      });
    } catch (analysisError) {
      const message = analysisError instanceof Error ? analysisError.message : "無法分析網址";
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }

  function updateRoom(
    roomId: string,
    field: "name" | "capacity",
    value: string,
  ) {
    setRooms((current) =>
      current.map((room) => {
        if (room.id !== roomId) return room;
        if (field === "capacity") {
          const capacity = value ? Number(value) : undefined;
          return {
            ...room,
            capacity:
              typeof capacity === "number" && Number.isFinite(capacity)
                ? capacity
                : undefined,
          };
        }
        return { ...room, name: value };
      }),
    );
  }

  function addRoom() {
    setRooms((current) => [
      ...current,
      {
        id: `manual-${crypto.randomUUID()}`,
        name: "新房型",
        sourceName: "使用者新增",
        capacity: 2,
        bundle: false,
        features: [],
        origin: "manual",
        editable: true,
      },
    ]);
  }

  function removeRoom(roomId: string) {
    setRooms((current) => current.filter((room) => room.id !== roomId));
  }

  function saveDraft() {
    if (!analysis) return;
    localStorage.setItem(
      `competitor-radar:${analysis.property.websiteHost}`,
      JSON.stringify({ analysis, canonicalRooms: rooms, savedAt: new Date().toISOString() }),
    );
    toast.success("房型草稿已儲存在此瀏覽器", {
      description: "目前尚未寫入正式資料庫；後續 PR 會加入持久化與使用者確認紀錄。",
    });
  }

  const activeSource = sourceByPlatform.get(activePlatform);

  return (
    <div className="space-y-5 pb-12">
      <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
            <Radar className="size-4" />
            競品與市場雷達
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">從一個網址建立競品檔案</h1>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
            先從官網建立住宿身分與 canonical 房型，再以登記編號與模糊地址雙軌確認
            Booking、Agoda、Trip.com 是否為同一間住宿。
          </p>
        </div>
        {analysis && (
          <Badge variant="outline" className="w-fit px-3 py-1.5">
            分析時間 {new Date(analysis.analyzedAt).toLocaleString("zh-TW")}
          </Badge>
        )}
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">貼上住宿網址</CardTitle>
          <CardDescription>
            第一版可實際分析公開官網；OTA 搜尋與逐日價格 adapter 會在確認住宿身分後接入。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={analyze} className="flex flex-col gap-3 sm:flex-row">
            <div className="min-w-0 flex-1 space-y-2">
              <Label htmlFor="competitor-url" className="sr-only">
                住宿網址
              </Label>
              <div className="relative">
                <Globe2 className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="competitor-url"
                  type="url"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  className="pl-9"
                  placeholder="https://example.com"
                  required
                />
              </div>
            </div>
            <Button type="submit" disabled={loading} className="sm:min-w-36">
              {loading ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
              {loading ? "分析中" : "開始分析"}
            </Button>
          </form>
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            安全限制：只讀公開 HTTP/HTTPS 網頁；拒絕 localhost、私有 IP、非標準連接埠與超過
            2 MB 的頁面。只會跟進同網域、最多 12 個房型詳情頁。
          </p>
        </CardContent>
      </Card>

      {error && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>分析失敗</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {!analysis && !error && (
        <div className="grid gap-4 md:grid-cols-3">
          {[
            {
              icon: ShieldCheck,
              title: "1. 確認住宿身分",
              body: "登記編號是強識別；地址會先拆成行政區、道路、巷弄與門牌，村里缺漏不扣分。",
            },
            {
              icon: FileCheck2,
              title: "2. 建立房型草稿",
              body: "優先讀官網房型列表與詳情頁，把入住人數、房號、景觀、無窗、浴缸與包棟拆成結構化特徵。",
            },
            {
              icon: Radar,
              title: "3. 接入 OTA 監控",
              body: "每個平台保留自己的房型與 rate plan，再由使用者確認 mapping；抓取失敗不會被誤標為售罄。",
            },
          ].map(({ icon: Icon, title, body }) => (
            <Card key={title}>
              <CardHeader>
                <Icon className="size-5 text-primary" />
                <CardTitle className="text-base">{title}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm leading-6 text-muted-foreground">{body}</CardContent>
            </Card>
          ))}
        </div>
      )}

      {analysis && (
        <>
          {analysis.warnings.map((warning) => (
            <Alert key={warning}>
              <AlertTriangle className="size-4" />
              <AlertTitle>需要人工留意</AlertTitle>
              <AlertDescription>{warning}</AlertDescription>
            </Alert>
          ))}

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(340px,0.8fr)]">
            <Card>
              <CardHeader>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <CardDescription>住宿身分草稿</CardDescription>
                    <CardTitle className="mt-1 text-xl">{analysis.property.name}</CardTitle>
                  </div>
                  <Badge
                    variant={analysis.property.identityStatus === "confirmed" ? "default" : "secondary"}
                    className="w-fit"
                  >
                    {analysis.property.identityStatus === "confirmed" ? "官網身分足夠" : "需要補資料"}
                    · {scoreLabel(analysis.property.confidence)}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border p-3">
                    <p className="text-xs font-semibold text-muted-foreground">地址軌</p>
                    <div className="mt-2 flex items-start gap-2">
                      <MapPin className="mt-0.5 size-4 shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium">
                          {analysis.property.address ?? "官網未找到地址"}
                        </p>
                        {analysis.property.normalizedAddress && (
                          <p className="mt-1 break-all text-xs text-muted-foreground">
                            標準化：{analysis.property.normalizedAddress}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="rounded-xl border p-3">
                    <p className="text-xs font-semibold text-muted-foreground">登記編號軌</p>
                    <div className="mt-2 flex items-start gap-2">
                      <FileCheck2 className="mt-0.5 size-4 shrink-0" />
                      <div>
                        <p className="text-sm font-medium">
                          {analysis.property.registrationNumber ?? "本頁未找到登記編號"}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          缺少登記編號不阻擋；將改用地址、電話、經緯度與名稱補強。
                        </p>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  {analysis.identityEvidence.map((evidence) => (
                    <div key={`${evidence.field}-${evidence.detail}`} className="flex gap-2 text-sm">
                      {evidenceIcon(evidence)}
                      <div>
                        <p className="font-medium">{evidence.label}</p>
                        <p className="text-xs leading-5 text-muted-foreground">{evidence.detail}</p>
                      </div>
                    </div>
                  ))}
                </div>

                <a
                  href={analysis.finalUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
                >
                  <ExternalLink className="size-4" />
                  開啟分析來源
                </a>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardDescription>來源狀態</CardDescription>
                <CardTitle className="text-base">跨平台身分解析</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {PLATFORM_ORDER.map((platform) => {
                  const source = sourceByPlatform.get(platform);
                  if (!source) return null;
                  return (
                    <div key={platform} className="rounded-xl border p-3">
                      <div className="flex items-center justify-between gap-3">
                        <p className="font-semibold">{source.label}</p>
                        <Badge variant={sourceStatusVariant(source)}>{sourceStatusLabel(source)}</Badge>
                      </div>
                      <p className="mt-2 text-xs leading-5 text-muted-foreground">{source.message}</p>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <CardTitle className="text-base">Canonical 房型編輯器</CardTitle>
                  <CardDescription className="mt-1">
                    官網建立房型定義；OTA 保留自己的商品名稱，待 adapter 回傳後再進行 mapping。
                  </CardDescription>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={addRoom}>
                    <Plus className="size-4" />
                    新增房型
                  </Button>
                  <Button size="sm" onClick={saveDraft}>
                    <Save className="size-4" />
                    儲存草稿
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto rounded-xl border">
                <table className="min-w-[980px] w-full text-left text-sm">
                  <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-3 font-semibold">Canonical 房型</th>
                      <th className="w-24 px-3 py-3 font-semibold">標準人數</th>
                      <th className="w-40 px-3 py-3 font-semibold">官網來源</th>
                      <th className="w-36 px-3 py-3 font-semibold">Booking</th>
                      <th className="w-36 px-3 py-3 font-semibold">Agoda</th>
                      <th className="w-36 px-3 py-3 font-semibold">Trip.com</th>
                      <th className="w-14 px-3 py-3" />
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {rooms.map((room) => (
                      <tr key={room.id} className="align-top">
                        <td className="px-3 py-3">
                          <Input
                            value={room.name}
                            onChange={(event) => updateRoom(room.id, "name", event.target.value)}
                            aria-label={`${room.sourceName} canonical 名稱`}
                          />
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {room.bundle && <Badge variant="outline">包棟</Badge>}
                            {room.roomNumber && <Badge variant="outline">房號 {room.roomNumber}</Badge>}
                            {room.features.slice(0, 3).map((feature) => (
                              <Badge key={feature} variant="secondary">
                                {feature}
                              </Badge>
                            ))}
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <Input
                            type="number"
                            min={1}
                            max={30}
                            value={room.capacity ?? ""}
                            onChange={(event) => updateRoom(room.id, "capacity", event.target.value)}
                            aria-label={`${room.name} 標準入住人數`}
                          />
                        </td>
                        <td className="px-3 py-3">
                          <p className="line-clamp-2 font-medium">{room.sourceName}</p>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            {ORIGIN_LABELS[room.origin]}
                          </p>
                          {room.sourceUrl && (
                            <a
                              href={room.sourceUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="mt-1 inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
                            >
                              <ExternalLink className="size-3" />
                              詳情頁
                            </a>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <PlatformCell source={sourceByPlatform.get("booking")} />
                        </td>
                        <td className="px-3 py-3">
                          <PlatformCell source={sourceByPlatform.get("agoda")} />
                        </td>
                        <td className="px-3 py-3">
                          <PlatformCell source={sourceByPlatform.get("trip")} />
                        </td>
                        <td className="px-3 py-3 text-right">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => removeRoom(room.id)}
                            aria-label={`刪除 ${room.name}`}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                    {!rooms.length && (
                      <tr>
                        <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                          官網沒有辨識到房型；請按「新增房型」建立 canonical 房型。
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-xs leading-5 text-muted-foreground">
                使用者確認後的 mapping 才是最終真相。Rate plan（免費取消、不可退款、含早餐）不會被建立成另一個實體房型；包棟也不會被加總成額外房間。
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">未來 14 天平台檢視</CardTitle>
              <CardDescription>
                日期框架已建立；本 PR 只顯示真實採集狀態，不以推測值代替尚未接入的 OTA 資料。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2" role="tablist" aria-label="平台">
                {PLATFORM_ORDER.map((platform) => {
                  const source = sourceByPlatform.get(platform);
                  return (
                    <button
                      key={platform}
                      type="button"
                      role="tab"
                      aria-selected={activePlatform === platform}
                      onClick={() => setActivePlatform(platform)}
                      className={cn(
                        "rounded-lg border px-3 py-2 text-sm font-semibold transition-colors",
                        activePlatform === platform
                          ? "border-primary bg-primary text-primary-foreground"
                          : "bg-background text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {PLATFORM_SHORT_LABELS[platform]}
                      {source && (
                        <span className="ml-2 text-[10px] opacity-75">
                          {source.status === "discovered" ? "已取得" : "待接入"}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              <div className="rounded-xl border">
                <div className="flex flex-col gap-2 border-b bg-muted/25 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="font-semibold">{activeSource?.label ?? PLATFORM_SHORT_LABELS[activePlatform]}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {activeSource?.message ?? "尚未建立來源"}
                    </p>
                  </div>
                  {activeSource && (
                    <Badge variant={sourceStatusVariant(activeSource)}>
                      {sourceStatusLabel(activeSource)}
                    </Badge>
                  )}
                </div>

                <div className="overflow-x-auto">
                  <table className="min-w-[760px] w-full text-left text-sm">
                    <thead className="border-b bg-muted/20 text-xs text-muted-foreground">
                      <tr>
                        <th className="px-4 py-3 font-semibold">入住日</th>
                        <th className="px-4 py-3 font-semibold">房型</th>
                        <th className="px-4 py-3 font-semibold">價格</th>
                        <th className="px-4 py-3 font-semibold">可售狀態</th>
                        <th className="px-4 py-3 font-semibold">參考待售量</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {dates.map((date) => (
                        <tr key={`${activePlatform}-${date}`}>
                          <td className="whitespace-nowrap px-4 py-3 font-medium">{formatDate(date)}</td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {activePlatform === "official" ? `${rooms.length} 個 canonical 房型` : "待 mapping"}
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">尚未收集</td>
                          <td className="px-4 py-3">
                            <Badge variant="outline">not_collected</Badge>
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">未知</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <Alert>
                <ShieldCheck className="size-4" />
                <AlertTitle>資料語意</AlertTitle>
                <AlertDescription>
                  待售量只會標示為參考房量；日差分只會產生 observed availability change／possible pickup，永遠不會寫成 confirmed booking。
                </AlertDescription>
              </Alert>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
