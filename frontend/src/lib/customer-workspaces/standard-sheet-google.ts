import { createSign } from "node:crypto";
import { spreadsheetId } from "./customer-google.ts";
import {
  STANDARD_SHEET_TABS,
  LEGACY_COLUMN_COUNTS,
  type StandardTabKey,
} from "./standard-sheet-schema.ts";
import {
  normalizedTable,
  toGoogleCell,
  type StandardWorkbook,
} from "./standard-sheet.ts";

export type StandardSnapshot = {
  spreadsheetId: string;
  url: string;
  tables: StandardWorkbook["tables"];
  allSheetIds?: number[];
  sheets: Partial<
    Record<
      StandardTabKey,
      { id: number; rows: number; columns: number; tableId?: string }
    >
  >;
};
export interface StandardSheetGateway {
  read(id: string): Promise<StandardSnapshot>;
  write(snapshot: StandardSnapshot, workbook: StandardWorkbook): Promise<void>;
  create?(
    workspaceId: string,
    workspaceName: string,
    options?: { lookupOnly?: boolean },
  ): Promise<string>;
}
type Credential = { client_email: string; private_key: string };
function credential(): Credential {
  try {
    const value = JSON.parse(
      process.env.CUSTOMER_STANDARD_SHEET_CREDENTIALS ||
        process.env.CUSTOMER_SHEET_READER_CREDENTIALS ||
        "",
    );
    if (
      typeof value.client_email !== "string" ||
      !value.client_email.endsWith(".gserviceaccount.com") ||
      typeof value.private_key !== "string" ||
      !value.private_key.includes("PRIVATE KEY")
    )
      throw Error();
    return value;
  } catch {
    throw new Error("STANDARD_WRITER_UNAVAILABLE");
  }
}
export function standardSheetConfiguration() {
  let email: string | null = null;
  try {
    email = credential().client_email;
  } catch {
    /* Expose capability only. */
  }
  return {
    configured: email !== null,
    writerEmail: email,
    canCreate: Boolean(
      email &&
      process.env.CUSTOMER_STANDARD_SHEET_TEMPLATE_ID &&
      process.env.CUSTOMER_STANDARD_SHEET_FOLDER_ID,
    ),
  };
}
const MAX_RESPONSE = 8_000_000;
async function json(response: Response) {
  if (!response.ok || !response.body)
    throw new Error("STANDARD_SHEET_UNAVAILABLE");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_RESPONSE) {
      await reader.cancel();
      throw new Error("STANDARD_SIZE");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("STANDARD_SHEET_UNAVAILABLE");
  }
}
function columnName(count: number) {
  let result = "";
  for (let n = count; n > 0; n = Math.floor((n - 1) / 26))
    result = String.fromCharCode(65 + ((n - 1) % 26)) + result;
  return result;
}

export function standardWriteRequests(
  snapshot: StandardSnapshot,
  workbook: StandardWorkbook,
) {
  const requests: Record<string, unknown>[] = [];
  let nextId =
    Math.max(
      0,
      ...(snapshot.allSheetIds ??
        Object.values(snapshot.sheets).map((s) => s!.id)),
    ) + 1;
  for (const tab of STANDARD_SHEET_TABS) {
    let sheet = snapshot.sheets[tab.key];
    const rows = workbook.tables[tab.key];
    const rowCount = Math.max(
      2,
      rows.length,
      snapshot.tables[tab.key]?.length ?? 0,
    );
    if (!sheet) {
      if (
        !["calendarSources", "blocks"].includes(tab.key) ||
        nextId > 2147483647
      )
        throw new Error("STANDARD_LAYOUT_CHANGED");
      sheet = { id: nextId++, rows: rowCount, columns: tab.columns.length };
      requests.push({
        addSheet: {
          properties: {
            sheetId: sheet.id,
            title: tab.title,
            gridProperties: {
              rowCount,
              columnCount: sheet.columns,
              frozenRowCount: 1,
            },
          },
        },
      });
      requests.push({
        repeatCell: {
          range: { sheetId: sheet.id, startRowIndex: 0, endRowIndex: 1 },
          cell: {
            userEnteredFormat: {
              textFormat: { bold: true },
              backgroundColor: { red: 0.92, green: 0.96, blue: 0.95 },
            },
          },
          fields: "userEnteredFormat",
        },
      });
      for (const [index, column] of tab.columns.entries())
        requests.push({
          updateDimensionProperties: {
            range: {
              sheetId: sheet.id,
              dimension: "COLUMNS",
              startIndex: index,
              endIndex: index + 1,
            },
            properties: { pixelSize: column.width ?? 140 },
            fields: "pixelSize",
          },
        });
    }
    const columnCount = tab.columns.length;
    if (sheet.rows < rowCount || sheet.columns < columnCount)
      requests.push({
        updateSheetProperties: {
          properties: {
            sheetId: sheet.id,
            gridProperties: {
              rowCount: Math.max(sheet.rows, rowCount),
              columnCount: Math.max(sheet.columns, columnCount),
            },
          },
          fields: "gridProperties(rowCount,columnCount)",
        },
      });
    requests.push({
      updateCells: {
        range: {
          sheetId: sheet.id,
          startRowIndex: 0,
          endRowIndex: rowCount,
          startColumnIndex: 0,
          endColumnIndex: columnCount,
        },
        rows: rows.map((row, i) => ({
          values: row.map((value, c) =>
            toGoogleCell(value, i === 0 ? undefined : tab.columns[c]),
          ),
        })),
        fields: "userEnteredValue",
      },
    });
    // Resizing a native table applies its default formats. Do this before
    // restoring our explicit date/money formats and readable header text.
    if (sheet.tableId) {
      requests.push({
        updateTable: {
          table: {
            tableId: sheet.tableId,
            range: {
              sheetId: sheet.id,
              startRowIndex: 0,
              endRowIndex: Math.max(2, rows.length),
              startColumnIndex: 0,
              endColumnIndex: columnCount,
            },
          },
          fields: "range",
        },
      });
      requests.push({
        repeatCell: {
          range: {
            sheetId: sheet.id,
            startRowIndex: 0,
            endRowIndex: 1,
            startColumnIndex: 0,
            endColumnIndex: columnCount,
          },
          cell: {
            userEnteredFormat: {
              textFormat: {
                fontFamily: "Arial",
                bold: true,
                foregroundColorStyle: {
                  rgbColor: { red: 0, green: 0, blue: 0 },
                },
              },
            },
          },
          fields: "userEnteredFormat.textFormat",
        },
      });
    }
    for (const [i, column] of tab.columns.entries()) {
      if (column.type && rowCount > 1)
        requests.push({
          repeatCell: {
            range: {
              sheetId: sheet.id,
              startRowIndex: 1,
              endRowIndex: rowCount,
              startColumnIndex: i,
              endColumnIndex: i + 1,
            },
            cell: {
              userEnteredFormat: {
                numberFormat:
                  column.type === "date"
                    ? { type: "DATE", pattern: "yyyy-mm-dd" }
                    : column.type === "datetime"
                      ? { type: "DATE_TIME", pattern: "yyyy-mm-dd hh:mm:ss" }
                      : {
                          type: column.type === "money" ? "CURRENCY" : "NUMBER",
                          pattern: column.type === "money" ? "#,##0.00" : "0",
                        },
              },
            },
            fields: "userEnteredFormat.numberFormat",
          },
        });
    }
  }
  return requests;
}

export class GoogleStandardSheetGateway implements StandardSheetGateway {
  private access: Promise<string> | null = null;
  private async token() {
    if (!this.access)
      this.access = (async () => {
        const c = credential(),
          now = Math.floor(Date.now() / 1000);
        const b64 = (v: object) =>
          Buffer.from(JSON.stringify(v)).toString("base64url");
        const scope = process.env.CUSTOMER_STANDARD_SHEET_FOLDER_ID
          ? "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive"
          : "https://www.googleapis.com/auth/spreadsheets";
        const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: c.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 600 })}`;
        const assertion = `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(c.private_key, "base64url")}`;
        const data = await json(
          await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            cache: "no-store",
            signal: AbortSignal.timeout(10000),
            body: new URLSearchParams({
              grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
              assertion,
            }),
          }),
        );
        if (typeof data.access_token !== "string")
          throw new Error("STANDARD_WRITER_UNAVAILABLE");
        return data.access_token as string;
      })();
    return this.access;
  }
  private async request(url: string, body?: unknown) {
    const text = body === undefined ? undefined : JSON.stringify(body);
    if (text && Buffer.byteLength(text) > 8_000_000)
      throw new Error("STANDARD_SIZE");
    return json(
      await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${await this.token()}`,
          ...(text ? { "Content-Type": "application/json" } : {}),
        },
        ...(text ? { body: text } : {}),
        cache: "no-store",
        signal: AbortSignal.timeout(25000),
      }),
    );
  }
  async read(rawId: string): Promise<StandardSnapshot> {
    const id = spreadsheetId(rawId);
    const metadata = await this.request(
      `https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=spreadsheetId,spreadsheetUrl,sheets(properties(sheetId,title,gridProperties),tables(tableId,range))`,
    );
    if (
      metadata.spreadsheetId !== id ||
      typeof metadata.spreadsheetUrl !== "string" ||
      spreadsheetId(metadata.spreadsheetUrl) !== id
    )
      throw new Error("STANDARD_SHEET_UNAVAILABLE");
    const sheets: StandardSnapshot["sheets"] = {} as StandardSnapshot["sheets"];
    const query = new URLSearchParams({
      valueRenderOption: "FORMULA",
      dateTimeRenderOption: "SERIAL_NUMBER",
    });
    for (const tab of STANDARD_SHEET_TABS) {
      const sheet = metadata.sheets?.find(
        (s: { properties?: { title?: string } }) =>
          s.properties?.title === tab.title,
      );
      if (!sheet && ["calendarSources", "blocks"].includes(tab.key)) continue;
      if (
        !sheet ||
        sheet.properties.gridProperties.rowCount > 50001 ||
        sheet.properties.gridProperties.columnCount > 200
      )
        throw new Error("STANDARD_LAYOUT_CHANGED");
      const props = sheet.properties;
      const tables = sheet.tables ?? [];
      if (tables.length > 1) throw new Error("STANDARD_LAYOUT_CHANGED");
      sheets[tab.key] = {
        id: props.sheetId,
        rows: props.gridProperties.rowCount,
        columns: props.gridProperties.columnCount,
        ...(tables[0] ? { tableId: tables[0].tableId } : {}),
      };
      query.append(
        "ranges",
        `'${tab.title.replaceAll("'", "''")}'!A1:${columnName(props.gridProperties.columnCount)}${props.gridProperties.rowCount}`,
      );
    }
    const values = await this.request(
      `https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchGet?${query}`,
    );
    const result = {} as StandardSnapshot["tables"];
    for (const tab of STANDARD_SHEET_TABS)
      if (!sheets[tab.key]) result[tab.key] = [];
    for (const [i, tab] of STANDARD_SHEET_TABS.filter(
      (t) => sheets[t.key],
    ).entries()) {
      const rows: unknown[][] = values.valueRanges?.[i]?.values ?? [];
      if (
        !rows.length ||
        rows.some((row) =>
          row
            .slice(tab.columns.length)
            .some((v) => v !== null && v !== "" && v !== undefined),
        )
      )
        throw new Error("STANDARD_LAYOUT_CHANGED");
      const header = rows[0];
      const legacyCount = LEGACY_COLUMN_COUNTS[tab.key];
      const count =
        legacyCount &&
        header.slice(legacyCount).every((v) => v == null || v === "")
          ? legacyCount
          : tab.columns.length;
      if (
        rows.some((row) => row.slice(count).some((v) => v != null && v !== ""))
      )
        throw new Error("STANDARD_LAYOUT_CHANGED");
      result[tab.key] = normalizedTable(rows, tab.key, count);
      if (
        JSON.stringify(result[tab.key][0]) !==
        JSON.stringify(tab.columns.slice(0, count).map((c) => c.label))
      )
        throw new Error("STANDARD_LAYOUT_CHANGED");
    }
    return {
      spreadsheetId: id,
      url: metadata.spreadsheetUrl,
      tables: result,
      sheets,
      allSheetIds: (metadata.sheets ?? []).map(
        (s: { properties: { sheetId: number } }) => s.properties.sheetId,
      ),
    };
  }
  async write(snapshot: StandardSnapshot, workbook: StandardWorkbook) {
    await this.request(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId(snapshot.spreadsheetId)}:batchUpdate`,
      { requests: standardWriteRequests(snapshot, workbook) },
    );
  }
  async create(
    workspaceId: string,
    workspaceName: string,
    options: { lookupOnly?: boolean } = {},
  ) {
    const template = process.env.CUSTOMER_STANDARD_SHEET_TEMPLATE_ID,
      folder = process.env.CUSTOMER_STANDARD_SHEET_FOLDER_ID;
    if (!template || !folder || !/^[\w-]{10,200}$/.test(folder))
      throw new Error("STANDARD_SETUP_REQUIRED");
    // Service accounts can create files in a shared drive. My Drive ownership
    // is intentionally not assumed; copying there can fail for lack of quota.
    const info = await this.request(
      `https://www.googleapis.com/drive/v3/files/${folder}?fields=id,mimeType,driveId&supportsAllDrives=true`,
    );
    if (info.mimeType !== "application/vnd.google-apps.folder" || !info.driveId)
      throw new Error("STANDARD_SETUP_REQUIRED");
    const tag = `workspace-${workspaceId}`;
    const q = `'${folder}' in parents and trashed = false and appProperties has { key='bnbStandardWorkspace' and value='${tag.replaceAll("'", "\\'")}' }`;
    const existing = await this.request(
      `https://www.googleapis.com/drive/v3/files?${new URLSearchParams({ q, fields: "files(id)", pageSize: "2", supportsAllDrives: "true", includeItemsFromAllDrives: "true" })}`,
    );
    if (existing.files?.length > 1) throw new Error("STANDARD_TARGET_CONFLICT");
    if (existing.files?.length === 1)
      return spreadsheetId(existing.files[0].id);
    if (options.lookupOnly) throw new Error("STANDARD_CREATE_UNCERTAIN");
    try {
      const created = await this.request(
        `https://www.googleapis.com/drive/v3/files/${spreadsheetId(template)}/copy?fields=id&supportsAllDrives=true`,
        {
          name: `${workspaceName.slice(0, 100)}｜標準帳本`,
          parents: [folder],
          appProperties: { bnbStandardWorkspace: tag },
        },
      );
      return spreadsheetId(created.id);
    } catch {
      throw new Error("STANDARD_CREATE_UNCERTAIN");
    }
  }
}
