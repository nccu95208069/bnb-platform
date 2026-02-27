export type ConversationStatus = "ai" | "human";

export type MessageRole = "user" | "assistant" | "system" | "owner";

export type ChannelType = "line";

export interface Conversation {
  id: string;
  channel: ChannelType;
  channel_user_id: string;
  display_name: string | null;
  status: ConversationStatus;
  is_active: boolean;
  last_message_at: string | null;
  created_at: string;
}

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  llm_model: string | null;
  created_at: string;
}

export interface ConversationDetail extends Conversation {
  messages: Message[];
}

export interface Document {
  id: string;
  filename: string;
  content_type: string;
  chunk_count: number;
  created_at: string;
}

export interface SettingsResponse {
  llm_provider: "claude" | "gemini";
  llm_api_key_set: boolean;
  line_channel_id: string;
  line_channel_secret_set: boolean;
  line_access_token_set: boolean;
  google_calendar_enabled: boolean;
  google_sheets_enabled: boolean;
}

export interface SettingsUpdate {
  llm_provider?: "claude" | "gemini";
  llm_api_key?: string;
  line_channel_id?: string;
  line_channel_secret?: string;
  line_access_token?: string;
  google_calendar_enabled?: boolean;
  google_sheets_enabled?: boolean;
}

export const CHANNEL_LABELS: Record<ChannelType, string> = {
  line: "LINE",
};
