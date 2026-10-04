import type { Question } from "./types";

// Refresh wording for existing imports without changing saved answer values.
export function presentQuestion(question: Question): Question {
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
  const copy = labels[question.id];
  if (!copy) return question;
  return {
    ...question,
    title: question.id === "unit" ? "這筆訂單，你會怎麼記？" : question.title,
    note: question.id === "unit" ? "例如：9/1 入住、9/3 退房，住「201 河景雙人房」，共 2 晚。" : "",
    options: question.options.map((option) => ({
      value: option.value,
      label: copy[option.value] ?? option.label,
    })),
  };
}
