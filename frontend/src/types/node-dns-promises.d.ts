import "node:dns/promises";
import type { LookupAddress } from "node:dns";

declare module "node:dns/promises" {
  /**
   * Preserve the array-returning overload as the final overload so
   * ReturnType<typeof lookup> is compatible with `{ all: true }` calls.
   */
  export function lookup(
    hostname: string,
    options: { all: true; verbatim?: boolean },
  ): Promise<LookupAddress[]>;
}
