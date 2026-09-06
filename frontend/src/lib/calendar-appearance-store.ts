import { DEFAULT_PALETTE, isPaletteId, type PaletteId } from "./calendar-palettes.ts";

// Account identity must come from verified server authentication, never request input.
export class CalendarAppearanceStore {
  private prefix = process.env.CALENDAR_APPEARANCE_NAMESPACE || "sweetfun-os:appearance:v1";
  private async command(command: string[]) {
    const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
    if (!url || !token || new URL(url).protocol !== "https:") throw new Error("APPEARANCE_UNAVAILABLE");
    const response = await fetch(url, { method: "POST", cache: "no-store", signal: AbortSignal.timeout(8000), headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(command) });
    if (!response.ok) throw new Error("APPEARANCE_UNAVAILABLE");
    const result = await response.json();
    if (result.error) throw new Error("APPEARANCE_UNAVAILABLE");
    return result.result;
  }
  private key(accountId: string) { return `${this.prefix}:${encodeURIComponent(accountId)}`; }
  async read(accountId: string): Promise<PaletteId> {
    const value = await this.command(["GET", this.key(accountId)]);
    if (value === null) return DEFAULT_PALETTE;
    if (!isPaletteId(value)) throw new Error("APPEARANCE_UNAVAILABLE");
    return value;
  }
  async save(accountId: string, palette: PaletteId): Promise<PaletteId> {
    if (!isPaletteId(palette)) throw new Error("INVALID_PALETTE");
    await this.command(["SET", this.key(accountId), palette]);
    const verified = await this.read(accountId);
    if (verified !== palette) throw new Error("APPEARANCE_WRITE_UNCONFIRMED");
    return verified;
  }
}
