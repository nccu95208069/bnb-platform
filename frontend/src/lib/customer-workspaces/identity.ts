import { randomBytes } from "node:crypto";
import {
  credentialBinding,
  credentialMatches,
  type OwnerCredential,
} from "../owner-password.ts";
export type CustomerCredential =
  OwnerCredential | { schema: 1; kind: "passwordless"; revision: string };
export const newPasswordlessCredential = (): CustomerCredential => ({
  schema: 1,
  kind: "passwordless",
  revision: randomBytes(32).toString("hex"),
});
export const customerCredentialBinding = (credential: CustomerCredential) =>
  credential.kind === "passwordless"
    ? credential.revision
    : credentialBinding(credential);
export const customerPasswordMatches = (
  password: unknown,
  credential: CustomerCredential,
) =>
  credential.kind === "passwordless"
    ? Promise.resolve(false)
    : credentialMatches(password, credential);
