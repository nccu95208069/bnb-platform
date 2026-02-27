export type MessageStatus = "draft" | "confirmed" | "sent" | "recalled";

export interface DbMessage {
  id: string;
  user_id: string;
  recipient_name: string;
  recipient_email: string;
  recipient_relationship: string;
  recipient_note: string | null;
  title: string;
  body: string;
  font_family: string;
  media_urls: string[];
  media_count: number;
  status: MessageStatus;
  access_token_hash: string | null;
  created_at: string;
  updated_at: string;
  confirmed_at: string | null;
  sent_at: string | null;
  viewed_at: string | null;
}

export interface Database {
  public: {
    Tables: {
      messages: {
        Row: DbMessage;
        Insert: Omit<DbMessage, "id" | "created_at" | "updated_at">;
        Update: Partial<Omit<DbMessage, "id" | "created_at">>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: {
      message_status: MessageStatus;
    };
    CompositeTypes: Record<string, never>;
  };
}
