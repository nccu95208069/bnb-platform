import type { Question } from "./types";

// Refresh wording for existing imports without changing saved answer values.
export function presentQuestion(question: Question): Question {
  const labels: Record<string, Record<string, string>> = {
    unit: {
      stay: "一間房，整段住宿記一列",
      night: "一間房，每晚分開記",
      multi: "多間房，合併記一列（有房數欄）",
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
    title: question.id === "unit" ? "一列記的是？" : question.title,
    note: "",
    options: question.options.map((option) => ({
      value: option.value,
      label: copy[option.value] ?? option.label,
    })),
  };
}
