/** Only the Node primitives used by the synchronous transaction proof path. */
declare module "node:crypto" {
  export function createHash(algorithm: string): {
    update(data: string, encoding: "utf8"): { digest(encoding: "hex"): string };
  };
  export function createHmac(algorithm: string, key: string): {
    update(data: string, encoding: "utf8"): { digest(): Uint8Array };
  };
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}
