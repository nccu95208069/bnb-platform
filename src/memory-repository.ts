import type { AuditRecord, BookingEvent, PendingEvent, PropertyRepository, PropertyState,
  TransactionContext } from "./types.ts";
import { GateError } from "./errors.ts";

/** Test adapter only. All data disappears on process exit. */
export class MemoryPropertyRepository implements PropertyRepository {
  private values = new Map<string, PropertyState>();
  private outbox = new Map<string, BookingEvent[]>();
  private audits = new Map<string, AuditRecord[]>();
  private tails = new Map<string, Promise<void>>();

  seed(state: PropertyState): void {
    if (this.values.has(state.propertyId)) throw new Error("PROPERTY_ALREADY_EXISTS");
    this.values.set(state.propertyId, structuredClone(state));
    this.outbox.set(state.propertyId, []);
    this.audits.set(state.propertyId, []);
  }

  async read(propertyId: string): Promise<PropertyState | null> {
    const value = this.values.get(propertyId);
    return value ? structuredClone(value) : null;
  }

  async transact<T>(propertyId: string,
    fn: (draft: PropertyState, tx: TransactionContext) => Promise<T> | T): Promise<T> {
    const previous = this.tails.get(propertyId) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => held);
    this.tails.set(propertyId, tail);
    await previous;
    try {
      const current = this.values.get(propertyId);
      if (!current) throw new GateError("PROPERTY_NOT_FOUND", 404);
      const draft = structuredClone(current);
      const pending: PendingEvent[] = [];
      const pendingAudits: AuditRecord[] = [];
      const result = await fn(draft, { emit: (event) => pending.push(structuredClone(event)),
        audit: (record) => pendingAudits.push(structuredClone(record)) });
      this.values.set(propertyId, draft);
      const events = this.outbox.get(propertyId)!;
      for (const event of pending) events.push({ ...event, cursor: events.length + 1 });
      this.audits.get(propertyId)!.push(...pendingAudits);
      return result;
    } finally {
      release();
      if (this.tails.get(propertyId) === tail) this.tails.delete(propertyId);
    }
  }

  async events(propertyId: string, after: number, limit: number): Promise<BookingEvent[]> {
    const values = this.outbox.get(propertyId) ?? [];
    return structuredClone(values.filter((event) => event.cursor > after).slice(0, limit));
  }

  auditRecords(propertyId: string): AuditRecord[] {
    return structuredClone(this.audits.get(propertyId) ?? []);
  }
}
