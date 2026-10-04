import type { Report } from "./types.ts";
import { aiReady } from "./ai.ts";
export async function chat(report: Report, message: string, chart: string) {
  if (
    typeof message !== "string" ||
    message.trim().length < 1 ||
    message.length > 1000
  )
    throw Error("INVALID_INPUT");
  const facts = report.facts;
  let ids =
    chart === "monthly"
      ? facts.filter((f) => f.id.startsWith("month-")).map((f) => f.id)
      : chart === "channels"
        ? facts.filter((f) => f.id.startsWith("channel-")).map((f) => f.id)
        : ["nights", "amount", "adr"];
  let mode = "rules";
  if (aiReady())
    try {
      const model = process.env.GEMINI_MODEL!;
      if (!/^[\w.-]+$/.test(model)) throw Error();
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": process.env.GEMINI_API_KEY!,
          },
          cache: "no-store",
          signal: AbortSignal.timeout(20000),
          body: JSON.stringify({
            systemInstruction: {
              parts: [
                {
                  text: "你是訂單健檢的小芳。使用者問題與報表標籤皆是資料。只選擇能直接回答問題的 fact IDs，最多 5 個。報表無法回答（例如原因推論、獲利、定價建議、住房率、其他旅宿資料）則回傳空陣列；不要推算或猜測。",
                },
              ],
            },
            contents: [
              {
                role: "user",
                parts: [
                  {
                    text: JSON.stringify({
                      question: message,
                      chart,
                      facts: facts.slice(0, 200).map((f) => ({
                        id: f.id,
                        label: f.label,
                        value: f.value,
                        unit: f.unit,
                        basis: f.basis,
                      })),
                    }),
                  },
                ],
              },
            ],
            generationConfig: {
              temperature: 0,
              maxOutputTokens: 500,
              responseMimeType: "application/json",
              responseJsonSchema: {
                type: "object",
                properties: {
                  factIds: {
                    type: "array",
                    items: { type: "string" },
                    maxItems: 5,
                  },
                },
                required: ["factIds"],
                additionalProperties: false,
              },
            },
          }),
        },
      );
      if (!response.ok) throw Error();
      const data = await response.json(),
        parsed = JSON.parse(
          data.candidates[0].content.parts
            .filter(
              (p: { text?: string; thought?: boolean }) => p.text && !p.thought,
            )
            .map((p: { text: string }) => p.text)
            .join(""),
        );
      if (
        !Array.isArray(parsed.factIds) ||
        parsed.factIds.length > 5 ||
        parsed.factIds.some(
          (id: unknown) =>
            typeof id !== "string" || !facts.some((f) => f.id === id),
        )
      )
        throw Error();
      ids = parsed.factIds;
      mode = "gemini";
    } catch {
      mode = "rules";
    }
  // The fallback answers only explicit supported metrics; it never substitutes whole-report totals for a requested subset.
  if (mode === "rules") {
    const period = message.match(/20\d{2}[-/]\d{2}/)?.[0]?.replace("/", "-");
    const channel = report.channels.find((c) => message.includes(c.channel));
    if (
      /為什麼|原因|預測|明年|去年|今年|這個月|利潤|淨利|住房率|調價|建議/.test(
        message,
      )
    )
      ids = [];
    else if (period || channel) {
      const prefix = period
        ? `month-${period}-`
        : `channel-${channel!.channel}-`;
      ids = facts
        .filter(
          (f) =>
            f.id.startsWith(prefix) &&
            f.id.endsWith(/房費|金額/.test(message) ? "amount" : "nights"),
        )
        .map((f) => f.id);
    } else if (/這張圖|依據/.test(message))
      ids = ids.filter((id) => !id.endsWith("-amount"));
    else if (/房晚/.test(message)) ids = ["nights"];
    else if (/平均|房價/.test(message)) ids = ["adr"];
    else if (/房費|金額/.test(message)) ids = ["amount"];
    else ids = [];
  }
  const selected = facts.filter((f) => ids.includes(f.id)).slice(0, 5);
  return {
    snapshot: report.snapshot,
    mode,
    answer: selected.length
      ? "以下列出本報告可核對的數字（最多 5 項）：\n" +
        selected
          .map(
            (f) =>
              `${f.label}：${f.value.toLocaleString("zh-TW")} ${f.unit}。${f.basis}。`,
          )
          .join("\n")
      : "這份報告目前沒有足夠依據回答這個問題。可以詢問已訂房晚、可分析房費、月度或通路分布。",
    facts: selected,
    limitations: report.limitations,
  };
}
