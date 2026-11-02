export const standardSheetErrors: Record<string, [number, string]> = {
  STANDARD_WRITER_UNAVAILABLE: [
    503,
    "標準帳本的寫入服務尚未設定。可先下載標準資料，或請服務人員完成連結。",
  ],
  STANDARD_SETUP_REQUIRED: [
    503,
    "自動建立帳本尚未設定。請服務人員準備標準帳本副本後連結。",
  ],
  STANDARD_SHEET_UNAVAILABLE: [
    503,
    "目前無法讀寫標準帳本，請確認帳本連結及寫入分享設定，再重試。",
  ],
  STANDARD_SOURCE_IS_TARGET: [
    400,
    "這是客戶原始來源 Sheet。請改用獨立的標準帳本副本，原表不會被修改。",
  ],
  STANDARD_MASTER_TEMPLATE: [
    400,
    "這是共用格式範本，請先建立此工作區專用的副本。",
  ],
  STANDARD_TARGET_NOT_EMPTY: [
    409,
    "目的帳本已有訂單或已綁定工作區，請使用空白的標準帳本副本。",
  ],
  STANDARD_TARGET_CONFLICT: [
    409,
    "此工作區或帳本已有其他綁定，請先核對既有帳本。",
  ],
  STANDARD_LAYOUT_CHANGED: [
    409,
    "帳本欄位或結構與標準格式不同，尚未覆寫。請先核對欄位與範本版本。",
  ],
  STANDARD_EXTERNAL_CHANGE: [
    409,
    "標準帳本被直接修改，系統已停止覆寫。請先核對修改內容，工作區訂單仍保留。",
  ],
  STANDARD_WRITE_UNCONFIRMED: [
    503,
    "工作區資料已保留，但標準帳本的更新尚未確認。重試只會核對及更新帳本，不會重複登記訂單或款項。",
  ],
  STANDARD_SYNC_BUSY: [409, "帳本正在更新，請稍後重新查看狀態。"],
  STANDARD_DATA_INVALID: [
    409,
    "工作區資料有不一致之處，帳本尚未覆寫。請聯絡服務人員核對。",
  ],
  STANDARD_SIZE: [
    400,
    "資料超過目前單次帳本輸出的容量，尚未部分寫入，請聯絡服務人員協助。",
  ],
  STANDARD_CREATE_UNCERTAIN: [
    503,
    "建立帳本的結果尚未確認。請重試查詢既有結果，系統不會直接建立第二份。",
  ],
};
