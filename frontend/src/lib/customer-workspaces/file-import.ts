import { randomUUID } from "node:crypto";
import XLSX from "xlsx";
import { fromBuffer, type Entry, type ZipFile } from "yauzl";
import { digest } from "./auth.ts";
import { importAccess } from "./sheet-import.ts";
import type { SourceSnapshot } from "./customer-google.ts";
import type { CustomerStore } from "./store.ts";

export const FILE_IMPORT_LIMIT = 3 * 1024 * 1024;
const EXPANDED_LIMIT = 8 * 1024 * 1024;

function filename(value: string) {
  value = value.normalize("NFKC").trim();
  if (
    value.length < 5 ||
    value.length > 120 ||
    /[/\\\x00-\x1f]/.test(value) ||
    !/\.(csv|xlsx)$/i.test(value)
  ) throw new Error("FILE_IMPORT_FORMAT");
  return value;
}

async function guardXlsx(buffer: Buffer) {
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50)
    throw new Error("FILE_IMPORT_FORMAT");
  await new Promise<void>((resolve, reject) => {
    let zip: ZipFile | undefined;
    let finished = false;
    let declaredTotal = 0;
    let expandedTotal = 0;
    let entries = 0;
    const fail = (code: string) => {
      if (finished) return;
      finished = true;
      zip?.close();
      reject(new Error(code));
    };
    fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, opened) => {
      if (error || !opened) return fail("FILE_IMPORT_FORMAT");
      zip = opened;
      zip.on("error", () => fail("FILE_IMPORT_FORMAT"));
      zip.on("end", () => {
        if (finished) return;
        finished = true;
        resolve();
      });
      zip.on("entry", (entry: Entry) => {
        declaredTotal += entry.uncompressedSize;
        if (
          ++entries > 300 || declaredTotal > EXPANDED_LIMIT ||
          entry.isEncrypted() ||
          /(^|\/)\.\.(\/|$)|^\/|\\|^[A-Za-z]:/.test(entry.fileName) ||
          /vbaProject\.bin$/i.test(entry.fileName)
        ) return fail("FILE_IMPORT_SIZE");
        // ZIP headers are untrusted. Read each entry with yauzl's size checks
        // before handing the workbook to a second ZIP parser.
        zip!.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return fail("FILE_IMPORT_FORMAT");
          let entryBytes = 0;
          stream.on("error", () => fail("FILE_IMPORT_FORMAT"));
          stream.on("data", (chunk: Buffer) => {
            if (finished) return;
            entryBytes += chunk.length;
            expandedTotal += chunk.length;
            if (expandedTotal > EXPANDED_LIMIT || entryBytes > entry.uncompressedSize) {
              stream.destroy();
              fail("FILE_IMPORT_SIZE");
            }
          });
          stream.on("end", () => {
            if (finished) return;
            if (entryBytes !== entry.uncompressedSize) return fail("FILE_IMPORT_FORMAT");
            zip!.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

function textCell(value: unknown) {
  if (value == null) return "";
  return String(value).normalize("NFKC").trim();
}

export async function parseImportFile(buffer: Buffer, rawName: string) {
  const name = filename(rawName);
  if (!buffer.length || buffer.length > FILE_IMPORT_LIMIT)
    throw new Error("FILE_IMPORT_SIZE");
  let workbook: XLSX.WorkBook;
  try {
    if (/\.csv$/i.test(name)) {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      } catch {
        text = new TextDecoder("big5", { fatal: true }).decode(buffer);
      }
      workbook = XLSX.read(text.replace(/^\uFEFF/, ""), {
        type: "string", raw: true, cellFormula: false,
      });
    } else {
      await guardXlsx(buffer);
      workbook = XLSX.read(buffer, {
        type: "buffer", cellDates: false, cellFormula: false,
        cellHTML: false, bookVBA: false,
      });
    }
  } catch (error) {
    if (error instanceof Error && error.message === "FILE_IMPORT_SIZE") throw error;
    throw new Error("FILE_IMPORT_FORMAT");
  }
  if (!workbook.SheetNames.length || workbook.SheetNames.length > 12)
    throw new Error("FILE_IMPORT_SIZE");
  let tabs: { title: string; rows: string[][] }[];
  try {
    tabs = workbook.SheetNames.map((title) => {
      const sheet = workbook.Sheets[title];
      if (sheet["!ref"]) {
        const bounds = XLSX.utils.decode_range(sheet["!ref"]);
        if (bounds.e.r > 500 || bounds.e.c > 51)
          throw new Error("FILE_IMPORT_SIZE");
      }
      const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1, raw: false, dateNF: "yyyy-mm-dd", defval: "", blankrows: true,
      });
      const rows = matrix.map((row) => row.map(textCell));
      if (
        rows.length > 501 || rows.some((row) => row.length > 52 || row.some((cell) => cell.length > 2000)) ||
        JSON.stringify(rows).length > 250000
      ) throw new Error("FILE_IMPORT_SIZE");
      return { title: title.slice(0, 100), rows };
    }).filter((tab) => tab.rows.some((row) => row.some(Boolean)));
  } catch (error) {
    if (error instanceof Error && error.message === "FILE_IMPORT_SIZE") throw error;
    throw new Error("FILE_IMPORT_FORMAT");
  }
  if (!tabs.length) throw new Error("FILE_IMPORT_FORMAT");
  return { name, tabs };
}

export async function stageImportFile(
  store: CustomerStore,
  accountId: string,
  slug: string,
  propertyId: string,
  buffer: Buffer,
  rawName: string,
) {
  const { workspace, property } = await importAccess(store, accountId, slug, propertyId);
  if (
    property.setup?.mode === "calendar" || property.setup?.sheetUrl ||
    (workspace.properties[0]?.id === propertyId && workspace.onboarding?.sheetUrl) ||
    workspace.calendarSources?.some((source) => source.propertyId === propertyId)
  ) throw new Error("SOURCE_LOCKED");
  const parsed = await parseImportFile(buffer, rawName);
  // The filename and tab name form a stable source namespace across revised uploads.
  // Exact rows still receive a content hash in the preview and booking fingerprint.
  const spreadsheetId = `file:${digest(JSON.stringify([workspace.id, propertyId, parsed.name.toLowerCase()]))}`;
  const expiresAt = Date.now() + 3600000;
  const ids = new Set<number>();
  const snapshots: SourceSnapshot[] = parsed.tabs.map((tab) => {
    const sheetId = Number.parseInt(digest(tab.title.toLowerCase()).slice(0, 8), 16);
    if (ids.has(sheetId)) throw new Error("FILE_IMPORT_FORMAT");
    ids.add(sheetId);
    return {
      id: randomUUID(), accountId, workspaceId: workspace.id, propertyId, expiresAt,
      source: { spreadsheetId, sheetId, title: `${parsed.name} / ${tab.title}`, rows: tab.rows },
    };
  });
  await store.commit(snapshots.map((snapshot) => ({
    key: `sheet-source:${snapshot.id}`, before: null, after: snapshot, ttlSeconds: 3600,
  })));
  return {
    title: parsed.name,
    tabs: snapshots.map((snapshot) => ({
      id: snapshot.source.sheetId,
      title: snapshot.source.title,
      sourceId: snapshot.id,
    })),
  };
}
