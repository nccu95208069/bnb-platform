import type { Question } from "./types";

// Apply at the response boundary so in-progress imports also get clearer wording.
// Answer values and saved decisions remain unchanged.
export function presentQuestion(question: Question): Question {
  if (question.id === "unit") {
    const copy: Record<string, { label: string; description: string }> = {
      stay: {
        label: "一間房的整次住宿，記在同一列",
        description: "例如：一間房連住 3 晚 → 表上只有 1 列，記下入住、退房日期或晚數。",
      },
      night: {
        label: "一間房每天分開記，一晚一列",
        description: "例如：一間房連住 3 晚 → 表上有 3 列，每列是不同的住宿日期。",
      },
      multi: {
        label: "同一筆訂單的多間房，合併在一列",
        description: "例如：訂 2 間房、連住 3 晚 → 表上只有 1 列，另外有「房間數量」欄填 2。",
      },
      skip: {
        label: "都不符合，或我還不確定",
        description: "先略過這題。確認記錄方式後，才能計算住宿晚數；整棟出租或多種記法混用也請選這項。",
      },
    };
    return {
      ...question,
      title: "你的表格怎麼記錄住宿？",
      note: "想一下：客人連住 3 晚，你會怎麼填？選最接近你平常記帳方式的一項。",
      options: question.options.map((option) => ({ ...option, ...copy[option.value] })),
    };
  }
  if (question.id === "money") {
    const copy: Record<string, { label: string; description: string }> = {
      total: {
        label: "這一列所有住宿的房費總額",
        description: "例如：一間房每晚 3,000 元、住 2 晚，這一列填 6,000 元。若合併多間房，也包含全部房間的房費。",
      },
      night: {
        label: "一間房住一晚的價格",
        description: "例如：一間房每晚 3,000 元，不管住幾晚，這個欄位都填 3,000 元。",
      },
      none: {
        label: "只記訂金、平台撥款，或其他金額",
        description: "這不是完整房費。可以繼續分析住宿晚數，但不會用它計算營收或平均房價。",
      },
      skip: {
        label: "我還不確定這個金額代表什麼",
        description: "先不計算營收和平均房價，其他可用資料仍能繼續分析。",
      },
    };
    return {
      ...question,
      note: "請對照下方實際資料，確認這個金額是「全部房費」還是「單晚價格」。",
      options: question.options.map((option) => ({ ...option, ...copy[option.value] })),
    };
  }
  return question;
}
