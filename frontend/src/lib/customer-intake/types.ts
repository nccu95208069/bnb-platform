export type IntakeAnswers = {
  intent: "join" | "consultation";
  propertyName: string | null;
  kind: "villa" | "rooms" | "mixed" | null;
  rooms: string[];
  source: "sheet" | "other" | "unknown";
  sourceDescription: string | null;
  sheetUrl: string | null;
  providedLink: string | null;
  sharingDeclared: boolean;
  contactName: string;
  email: string;
  phone: string | null;
  note: string | null;
  consent: true;
};
export type IntakeRecord = {
  id: string;
  requestHash: string;
  createdAt: string;
  answers: IntakeAnswers;
  status: "awaiting_review";
  sheetAccess: "not_checked" | "not_provided" | "verified";
  notification: {
    status: "pending" | "sending" | "accepted" | "needs_attention";
    attemptedAt?: string;
    messageId?: string;
  };
};
export type IntakeResult = {
  preview?: boolean;
  id: string;
  saved: true;
  notification: "accepted" | "pending";
  applicantNotification?: "accepted" | "pending" | "preview";
  sheetAccess?: "verified" | "not_checked" | "not_provided";
  status: "awaiting_review";
};
