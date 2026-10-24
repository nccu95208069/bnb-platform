import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { normalizeLineSucceededJournal, sweetfunOrderFingerprint,
  verifyGmailSheetWitness, verifyLineJournalTransition } from
  "../src/sweetfun-writer-evidence.mjs";

const header = Array(19).fill("header");
function row(id, order = "ORDER-1", amount = "100") {
  const values = Array(19).fill("");
  values[0] = "202";
  values[1] = "王小明";
  values[6] = amount;
  values[9] = id;
  values[11] = order;
  return values;
}
function hash(domain, value) {
  return createHash("sha256").update(`${domain}\0${value}`).digest("hex");
}

test("Gmail A:S fingerprint agrees with the independent Python writer vector", () => {
  const actual = sweetfunOrderFingerprint([header, row("ROW-1")], "ORDER-1");
  assert.deepEqual(actual, {
    count: 1,
    rows: [{ rowIdHash: "2e4cce0d4350d01cfa7d6abb226b5a300f7cecc039193bd615b23d73885a784e",
      valueHash: "9c7b5e4d6145e1d2fdb517fcfd829fadbd2e3d743ffea0e125b4ba82f582a529" }],
    digest: "1efde39b57faf4fd50bf1ea9a5e4a123c295954278b5a75f4e2a37785f7edc23",
  });
});

test("Gmail verified claim must match both fixed source observations", () => {
  const before = [header], after = [header, row("ROW-1")];
  const witness = { schema: 1, state: "verified", kind: "new",
    orderIdHash: hash("sweetfun-order-id-v1", "ORDER-1"),
    before: sweetfunOrderFingerprint(before, "ORDER-1"),
    after: sweetfunOrderFingerprint(after, "ORDER-1") };
  assert.equal(verifyGmailSheetWitness(witness, before, after, "ORDER-1").kind, "new");
  assert.throws(() => verifyGmailSheetWitness(witness, before,
    [header, row("ROW-1", "ORDER-1", "101")], "ORDER-1"),
  /GMAIL_WITNESS_SOURCE_MISMATCH/);
  assert.throws(() => verifyGmailSheetWitness({ ...witness, state: "prepared" },
    before, after, "ORDER-1"), /GMAIL_WITNESS_SOURCE_MISMATCH/);
});

test("LINE succeeded journal proves an exact source change and rejects a forged phase", () => {
  const original = row("ROW-1"), changed = row("ROW-1", "ORDER-1", "200");
  const record = { phase: "succeeded", operation_id: "SYNTHETIC-OP",
    completed_at: 1782020000, plan: { property: "sweetfun", action: "modify",
      old: [original], new: [changed] } };
  const event = verifyLineJournalTransition(record, [header, original], [header, changed]);
  assert.equal(event.kind, "modify");
  assert.equal(event.oldRows.length, 1);
  assert.throws(() => verifyLineJournalTransition(record,
    [header, original], [header, row("ROW-1", "ORDER-1", "300")]),
  /LINE_JOURNAL_SOURCE_MISMATCH/);
  assert.throws(() => normalizeLineSucceededJournal({ ...record, phase: "verifying" }),
    /LINE_JOURNAL_NOT_VERIFIED/);
});

test("LINE cancelled J cannot remain in the after copy", () => {
  const original = row("ROW-1");
  const record = { phase: "succeeded", operation_id: "SYNTHETIC-CANCEL",
    completed_at: 1782020000, plan: { property: "sweetfun", action: "delete",
      old: [original], new: [] } };
  assert.equal(verifyLineJournalTransition(record, [header, original], [header]).kind, "delete");
  assert.throws(() => verifyLineJournalTransition(record,
    [header, original], [header, original]), /LINE_JOURNAL_SOURCE_MISMATCH/);
});
