import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateDatabaseTransport } from "./runtime-safety.mjs";

/** Bind remote connections to the bundled Supabase CA and hostname. */
export function databaseUrlForVercel(rawUrl) {
  validateDatabaseTransport(rawUrl);
  const url = new URL(rawUrl);
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return rawUrl;
  if (["sslrootcert", "sslcert", "sslkey"].some((name) => url.searchParams.has(name)))
    throw Error("UNSAFE_DATABASE_TRANSPORT");
  const caPath = fileURLToPath(new URL("../certs/prod-ca-2021.crt", import.meta.url));
  const ca = readFileSync(caPath, "utf8");
  if (!ca.startsWith("-----BEGIN CERTIFICATE-----") ||
    !ca.includes("-----END CERTIFICATE-----")) throw Error("INVALID_DATABASE_CA");
  url.searchParams.set("sslrootcert", caPath);
  return url.toString();
}
