import type { ReceptionKind } from "../hospitality-mode.ts";
import type { Question } from "./types";

// Refresh wording for existing imports without changing saved answer values.
export function presentQuestion(question: Question, kind?: ReceptionKind, unit?: string): Question {
  const labels: Record<string, Record<string, string>> = {
    unit: {
      stay: "A. 每間房一列：201 房，9/1 入住、9/3 退房",
      night: "B. 每晚一列：201 房，9/1 一列、9/2 一列",
      multi: "C. 整筆訂單一列，房數填 1；訂多間也合在這列",
      skip: "不確定／都不符合",
    },
    money: {
      total: "這一列的房費總額",
      night: "一間房一晚的價格",
      none: "訂金、平台撥款或其他金額",
      skip: "不確定",
    },
  };
  if (kind === "villa") {
    labels.unit = {
      stay: "A. 一筆包棟一列：9/1 入住、9/3 退房",
      night: "B. 包棟每晚一列：9/1 一列、9/2 一列",
      split: "C. 同筆包棟按房間拆列（有共同訂單編號）", skip: "不確定／都不符合",
    };
    labels.money = { total: unit === "split" ? "每間房這列的房費，合計才是包棟總額" : "這列的包棟總房費",
      night: unit === "split" ? "這間房每晚房費，合計才是每晚包棟價格" : "整棟一晚的價格", none: "訂金、平台撥款或其他金額", skip: "不確定" };
  }
  if (kind === "mixed") labels.unit = { stay: "A. 包棟一筆一列；散客每間房一列", night: "B. 包棟或散客房間，都是每晚一列", multi: "C. 每筆訂單一列；散客有訂房間數", skip: "不確定／都不符合" };
  const copy = labels[question.id];
  if (!copy) return question;
  return {
    ...question,
    title: question.id === "unit" ? "這筆訂單，你會怎麼記？" : question.title,
    note: question.id === "unit" ? (kind === "villa" ? "例如：一組客人包棟，9/1 入住、9/3 退房，共 2 晚。" : kind === "mixed" ? "資料需有「接客形式」欄，逐筆填包棟或散客，才可分開計算。" : "例如：9/1 入住、9/3 退房，住「201 河景雙人房」，共 2 晚。") : "",
    options: question.options.map((option) => ({
      value: option.value,
      label: copy[option.value] ?? option.label,
    })),
  };
}
