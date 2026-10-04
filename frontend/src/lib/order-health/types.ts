export const FIELDS = [
  "checkIn",
  "checkOut",
  "booked",
  "room",
  "roomCount",
  "nights",
  "amount",
  "channel",
  "status",
  "orderId",
  "currency",
  "property",
] as const;
export type Field = (typeof FIELDS)[number];
export type Mapping = Partial<Record<Field, number>>;
export type Table = {
  id: string;
  title: string;
  headers: string[];
  mapping: Mapping;
  rows: { row: number; cells: string[]; source?: string }[];
  headerRow: number;
};
export type Scope = {
  workspace: string;
  property: string;
  actor: string;
  name: string;
  canWrite: boolean;
};
export type Question = {
  id: string;
  title: string;
  note: string;
  options: { value: string; label: string; description?: string }[];
};
export type Answers = Record<string, string>;
export type Night = {
  date: string;
  room: string;
  channel: string;
  amount: number | null;
  booked: string | null;
  refs: string[];
  count: number;
  allocated: boolean;
};
export type Fact = {
  id: string;
  label: string;
  value: number;
  unit: string;
  basis: string;
  refs: string[];
};
export type AnalysisCell = {
  date: string;
  channel: string;
  room: string;
  nights: number;
  amount: number;
  knownNights: number;
  pricedNights: number;
  arrivals: number;
  stayNights: number;
  leadTotal: number;
  leadCount: number;
  los: number[];
  lead: number[];
  refs: string[];
};
export type Analysis = {
  version: 2;
  asOf: string;
  unit: string;
  dimensions: boolean;
  cells: AnalysisCell[];
  bookingDates: { date: string; channel: string; room: string; nights: number; refs: string[] }[];
  quality: { included: number; excluded: number; cancelled: number; conflicts: number; unknownStatus: number };
};
export type Report = {
  id: string;
  snapshot: string;
  createdAt: string;
  sourceTitle: string;
  from: string;
  to: string;
  nights: number;
  amount: number | null;
  adr: number | null;
  occupancy: number | null;
  inventory: number | null;
  monthly: { month: string; nights: number; amount: number | null }[];
  channels: { channel: string; nights: number; amount: number | null }[];
  rooms: {
    room: string;
    nights: number;
    amount: number | null;
    weekdays: number[];
  }[];
  lead: { median: number | null; knownNights: number; totalNights: number };
  includedRows: number;
  excluded: { ref: string; reason: string }[];
  unknownAmountNights: number;
  limitations: string[];
  facts: Fact[];
  insights: { title: string; body: string; factIds: string[] }[];
  analysis?: Analysis;
};
export type Job = {
  id: string;
  workspace: string;
  property: string;
  actor: string;
  propertyName: string;
  createdAt: string;
  expiresAt: string;
  version: number;
  requestHash: string;
  sourceTitle: string;
  sourceHash: string;
  sourceKind: "file" | "sheet";
  state:
    | "checking_access"
    | "awaiting_share"
    | "reading"
    | "confirm"
    | "ready"
    | "analyzing"
    | "complete"
    | "failed"
    | "blocked";
  tables: Table[];
  questions: Question[];
  answers: Answers;
  mappingMode: "pending" | "gemini" | "rules";
  selected: string | null;
  report: Report | null;
  error: string | null;
  leaseUntil: number;
  attempts: number;
  connection?: {
    status: "checking" | "waiting" | "connected" | "paused" | "error";
    checkedAt: string | null;
    nextCheckAt: number;
    retryUntil: number;
    checks: number;
  };
  usage: { input: number; output: number };
};
