import type { OwnerCredential } from "../owner-password.ts";
export type Account = {
  id: string;
  email: string;
  credential: OwnerCredential;
  workspaces: {
    id: string;
    slug: string;
    name: string;
    creationKey: string;
    creationHash: string;
  }[];
};
export type Role =
  "owner" | "admin" | "housekeeper" | "viewer" | "viewer_no_price";
export type Membership = {
  accountId: string;
  role: Role;
  active: boolean;
  allProperties: boolean;
  propertyIds: string[];
};
export type Property = {
  id: string;
  name: string;
  kind: "villa" | "rooms" | "mixed";
  rooms: { id: string; name: string }[];
  villaRoomIds: string[];
  sourceMode: "native";
};
export type Payment = {
  id: string;
  amount: number;
  kind: "deposit" | "balance" | "full" | "other";
  receivedAt: string;
  method: string | null;
  actor: string;
};
export type Booking = {
  id: string;
  version: number;
  propertyId: string;
  guestName: string | null;
  checkIn: string;
  checkOut: string;
  roomIds: string[];
  total: number | null;
  payments: Payment[];
  contact: string | null;
  notes: string | null;
  status: "confirmed" | "cancelled";
  guestNotified: false;
  createdAt: string;
  actor: string;
  entry: "os";
  requestKey: string;
  requestHash: string;
};
export type Workspace = {
  id: string;
  slug: string;
  name: string;
  version: number;
  members: Membership[];
  properties: Property[];
  bookings: Booking[];
  audit: { at: string; actor: string; action: string; targetId: string }[];
};
export type WorkspaceView = {
  id: string;
  slug: string;
  name: string;
  version: number;
  role: Role;
  properties: Property[];
  bookings: Omit<Booking, "requestKey" | "requestHash" | "actor">[];
};
