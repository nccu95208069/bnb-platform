export const STANDARD_SHEET_VERSION = 1;
export const STANDARD_SHEET_MARKER = "bnb-standard-workbook";
export type StandardColumn = {
  key: string;
  label: string;
  type?: "date" | "datetime" | "money" | "number";
  width?: number;
};
const col = (
  key: string,
  label: string,
  type?: StandardColumn["type"],
  width?: number,
): StandardColumn => ({
  key,
  label,
  ...(type ? { type } : {}),
  ...(width ? { width } : {}),
});
export const STANDARD_SHEET_TABS = [
  {
    key: "orders",
    title: "訂單",
    columns: [
      col("orderId", "訂單ID", undefined, 280),
      col("propertyId", "館別ID", undefined, 230),
      col("propertyName", "館別", undefined, 150),
      col("sourceOrderId", "來源訂單編號", undefined, 170),
      col("guestName", "客人", undefined, 160),
      col("status", "狀態", undefined, 95),
      col("checkIn", "最早入住", "date", 120),
      col("checkOut", "最晚退房", "date", 120),
      col("roomNights", "房晚數", "number", 95),
      col("total", "訂單總額", "money", 130),
      col("sourcePaid", "來源累計已付", "money", 145),
      col("received", "匯入後收款", "money", 135),
      col("refunds", "匯入後退款", "money", 135),
      col("sourceRemaining", "依來源計算未付", "money", 160),
      col("cashReceived", "已確認旅宿實收", "money", 160),
      col("cashRemaining", "已確認實收後尾款", "money", 180),
      col("currency", "幣別", undefined, 80),
      col("version", "資料版本", "number", 105),
    ],
  },
  {
    key: "nights",
    title: "住宿明細",
    columns: [
      col("nightId", "房晚ID", undefined, 280),
      col("orderId", "訂單ID", undefined, 280),
      col("propertyId", "館別ID", undefined, 230),
      col("roomId", "房間ID", undefined, 220),
      col("roomName", "房間", undefined, 110),
      col("date", "住宿日", "date", 120),
      col("checkOut", "退房日", "date", 120),
      col("status", "狀態", undefined, 100),
      col("amount", "來源每房每晚房費", "money", 185),
      col("currency", "幣別", undefined, 80),
    ],
  },
  {
    key: "payments",
    title: "收付款",
    columns: [
      col("paymentId", "紀錄ID", undefined, 280),
      col("orderId", "訂單ID", undefined, 280),
      col("propertyId", "館別ID", undefined, 230),
      col("kind", "紀錄類型", undefined, 160),
      col("amount", "金額", "money", 130),
      col("receivedAt", "收付款時間", "datetime", 180),
      col("asOf", "摘要基準日", "date", 120),
      col("method", "方式", undefined, 135),
      col("note", "說明", undefined, 300),
      col("currency", "幣別", undefined, 80),
    ],
  },
  {
    key: "sources",
    title: "來源對照",
    columns: [
      col("orderId", "訂單ID", undefined, 280),
      col("batchId", "匯入批次ID", undefined, 280),
      col("spreadsheetId", "來源檔案ID", undefined, 300),
      col("sheetId", "來源分頁ID", "number", 130),
      col("row", "來源列", "number", 100),
      col("column", "來源欄", "number", 100),
      col("sourceOrderId", "來源訂單編號", undefined, 170),
      col("fingerprint", "來源指紋", undefined, 330),
      col("version", "轉換版本", "number", 100),
    ],
  },
  {
    key: "rules",
    title: "轉換規則",
    columns: [
      col("id", "規則", undefined, 105),
      col("category", "分類", undefined, 130),
      col("rule", "處理方式", undefined, 670),
    ],
  },
  {
    key: "meta",
    title: "系統設定",
    columns: [
      col("key", "項目", undefined, 220),
      col("value", "內容", undefined, 680),
    ],
  },
] as const;
export type StandardTabKey = (typeof STANDARD_SHEET_TABS)[number]["key"];

export const STANDARD_SHEET_RULES: (string | number)[][] = [
  [
    "R01",
    "來源",
    "原始 Sheet 唯讀；建立者與使用者可以是不同帳號，不查擁有者或編輯者身分。",
  ],
  [
    "R02",
    "分組",
    "同一來源檔案、分頁及館別內，按明確來源訂單編號合併；不跨客戶合併。",
  ],
  [
    "R03",
    "整筆訂單",
    "一列完整訂單可含多房、多晚；依入住與退房展開每房每晚明細。",
  ],
  [
    "R04",
    "分房分段",
    "同一訂單的多房與不同日期區間合併；中間沒有住宿的日期不占房。",
  ],
  [
    "R05",
    "一晚一列",
    "住宿日加一天得到該列退房日，再按訂單編號合併，不要求修改原表。",
  ],
  [
    "R06",
    "房況格",
    "日期橫排時需有完整年份；格子是訂單編號，或逐格指定其訂單編號。",
  ],
  ["R07", "歧義", "不按同名、相鄰格、顏色或空白延續推定同一張訂單。"],
  [
    "R08",
    "日期",
    "入住日包含、退房日不包含。10/10 入住、10/12 退房占用 10/10、10/11。",
  ],
  ["R09", "總額", "整筆總額同組只取一次；多列非空金額不一致時整組待核對。"],
  [
    "R10",
    "每列金額",
    "只有設定為每列完整金額才相加；任何必要金額空白時，總額仍是未知。",
  ],
  ["R11", "每晚金額", "每晚金額乘該列晚數；只有明確設定每房每晚才再乘房間數。"],
  [
    "R12",
    "已付與訂金",
    "來源累計已付或訂金重複出現只取一次；不同值不相加、不擅自取最大值。",
  ],
  [
    "R13",
    "來源摘要",
    "只有累計金額、沒有交易日期時，列為來源累計摘要，收付款時間留空。",
  ],
  [
    "R14",
    "款項語意",
    "來源累計已付不直接視為銀行實收。舊資料已明確註記的實收或旅客已付仍保留原意。",
  ],
  [
    "R15",
    "期初與本期",
    "來源累計、期初實收不計入匯入後的逐筆現金收入；新增收退款另列。",
  ],
  [
    "R16",
    "尾款",
    "依來源計算未付是訂單總額減來源累計已付，未含匯入後變動；現金尾款另按已確認實收計算。",
  ],
  [
    "R17",
    "原始房價",
    "來源沒有每房每晚價格時，住宿明細房費留空，不用平均分攤冒充原始房價。",
  ],
  [
    "R18",
    "未知與零",
    "空白代表未知；0 代表已知零。所有金額以整數分計算，使用新臺幣。",
  ],
  [
    "R19",
    "衝突",
    "同一房間同一住宿日重複占用，或與有效訂單重疊時，整組待核對。",
  ],
  [
    "R20",
    "完整性",
    "同組任何日期、房間、客人或金額矛盾，不能只匯入該組的一部分。",
  ],
  [
    "R21",
    "重跑",
    "相同匯入請求重試不新增第二張訂單或第二筆訂金；來源變動後須重新預覽。",
  ],
  [
    "R22",
    "追溯",
    "來源對照保留原檔案、分頁、列及房況格欄號，原表不須新增系統欄位。",
  ],
  [
    "R23",
    "目的帳本",
    "只寫入與工作區綁定的獨立標準帳本，禁止把來源 Sheet 當成目的地。",
  ],
  ["R24", "文字", "姓名、編號及備註以文字儲存，不能執行成試算表公式。"],
  [
    "R25",
    "更新",
    "此帳本由系統輸出；直接改帳本不會回寫來源或工作區。偵測到外部修改時停止覆寫，請先核對。",
  ],
  [
    "R26",
    "範例",
    "兩房各兩晚、總額 12,000、累計已付 3,000：一張訂單、四個房晚、一筆來源累計摘要。",
  ],
];
