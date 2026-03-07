/**
 * ════════════════════════════════════════════════════════════════
 * MONEY MAP — Google Apps Script Web App
 * FILE: CODE.gs
 * ────────────────────────────────────────────────────────────────
 * PURPOSE
 *   Exposes your Google Sheet as a read-only JSON API for the
 *   Money Map dashboard. The dashboard fetches this URL once on
 *   load and uses the data exactly like it would use the CSV files.
 *
 * HOW TO DEPLOY
 *   1. Open your Google Sheet (the one with Settings + Transactions tabs)
 *   2. Click  Extensions → Apps Script
 *   3. Delete any existing code and paste this entire file
 *   4. Click  Deploy → New deployment
 *        · Type:             Web app
 *        · Execute as:       Me  (your Google account)
 *        · Who has access:   Anyone
 *   5. Click Deploy — Google will ask you to authorise the script
 *      (it only needs permission to READ the spreadsheet it lives in)
 *   6. Copy the Web App URL  (looks like https://script.google.com/macros/s/…/exec)
 *   7. Paste it into  APPS_SCRIPT_URL  in  app.js
 *
 * RE-DEPLOYING AFTER CHANGES
 *   If you edit this file later, you must create a NEW deployment
 *   (Deploy → New deployment) to get an updated URL. Editing a
 *   deployed version does NOT update the live URL automatically.
 *   Alternatively, use "Manage deployments" to update an existing one.
 *
 * SECURITY
 *   · This script is READ-ONLY — it cannot modify your sheet.
 *   · "Anyone" access means anyone with the URL can read the data.
 *     For a private dashboard, keep the URL secret or switch access
 *     to "Anyone with Google account" and add auth headers in app.js.
 *   · CORS is handled automatically by the doGet() response below.
 *
 * TAB NAMES
 *   Update TAB_SETTINGS and TAB_TRANSACTIONS below if your sheet
 *   tabs have different names.
 * ════════════════════════════════════════════════════════════════
 */

// ── TAB NAMES ─────────────────────────────────────────────────
// Update these if your sheet tabs are named differently
const TAB_SETTINGS     = "Settings";       // ← your Settings tab name
const TAB_TRANSACTIONS = "Transactions";   // ← your Transactions tab name
// ──────────────────────────────────────────────────────────────


/**
 * doGet()
 * ───────
 * Entry point — Google calls this when the Web App URL is fetched.
 * Returns all sheet data as JSON with CORS headers so the browser
 * can fetch it from any origin.
 */
function doGet(e) {
  try {
    const payload = getData();
    return buildResponse(payload, 200);
  } catch (err) {
    const error = {
      error:   true,
      message: err.message || "Unknown error in Apps Script",
      stack:   err.stack   || ""
    };
    return buildResponse(error, 500);
  }
}


/**
 * getData()
 * ─────────
 * Reads both tabs and returns a plain object that the dashboard
 * can consume directly — the same shape as the CSV rows.
 */
function getData() {
  const ss          = SpreadsheetApp.getActiveSpreadsheet();
  const settingsTab = getSheet(ss, TAB_SETTINGS);
  const txTab       = getSheet(ss, TAB_TRANSACTIONS);

  return {
    source:        "google-sheets",
    spreadsheetId: ss.getId(),
    spreadsheetName: ss.getName(),
    fetchedAt:     new Date().toISOString(),
    settings:      sheetToObjects(settingsTab),
    transactions:  sheetToObjects(txTab)
  };
}


/**
 * sheetToObjects(sheet)
 * ─────────────────────
 * Converts a sheet's data range into an array of plain objects,
 * using the first row as column headers — identical to what
 * the CSV parser produces in app.js.
 *
 * Empty trailing rows (all cells blank) are skipped automatically.
 *
 * @param  {Sheet}   sheet  - A Google Sheets Sheet object
 * @return {Object[]}       - Array of row objects keyed by header
 */
function sheetToObjects(sheet) {
  const range  = sheet.getDataRange();
  const values = range.getValues();     // 2D array, all cells as-stored

  if (values.length < 2) return [];     // nothing but a header row

  // Row 0 = headers; trim whitespace so they match what app.js expects
  const headers = values[0].map(h => String(h).trim());

  const rows = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];

    // Skip entirely blank rows
    const hasContent = row.some(cell => cell !== "" && cell !== null && cell !== undefined);
    if (!hasContent) continue;

    const obj = {};
    headers.forEach((header, c) => {
      const raw = row[c];

      // Normalise to string, matching how the CSV files look
      obj[header] = cellToString(raw);
    });
    rows.push(obj);
  }
  return rows;
}


/**
 * cellToString(value)
 * ───────────────────
 * Converts a Sheets cell value to a string that matches what
 * the CSV files contain, so app.js can parse them identically.
 *
 * Key cases:
 *   · Dates   → "M/D/YYYY"    (matches the date format in the sheet)
 *   · Numbers → plain digits  (no $ or , added here; Cast.num strips them anyway)
 *   · Booleans→ "Yes"/"No"    (matches the Must Pay? column)
 *   · null/undefined → ""
 */
function cellToString(value) {
  if (value === null || value === undefined || value === "") return "";

  // Date objects (Sheets stores date cells as JS Date)
  if (value instanceof Date) {
    const m = value.getMonth() + 1;   // 0-indexed
    const d = value.getDate();
    const y = value.getFullYear();
    return `${m}/${d}/${y}`;
  }

  // Booleans — map to the text the CSV uses
  if (typeof value === "boolean") return value ? "Yes" : "No";

  // Numbers — return as plain string (no formatting)
  if (typeof value === "number") return String(value);

  // Everything else (strings already)
  return String(value).trim();
}


/**
 * getSheet(ss, name)
 * ──────────────────
 * Returns the named sheet or throws a clear error if it doesn't exist.
 */
function getSheet(ss, name) {
  const sheet = ss.getSheetByName(name);
  if (!sheet) {
    throw new Error(
      `Sheet tab "${name}" not found. ` +
      `Check TAB_SETTINGS / TAB_TRANSACTIONS at the top of CODE.gs. ` +
      `Available tabs: ${ss.getSheets().map(s => s.getName()).join(", ")}`
    );
  }
  return sheet;
}


/**
 * buildResponse(payload, statusCode)
 * ────────────────────────────────────
 * Wraps a plain object as a JSON ContentService response with
 * permissive CORS headers so the browser can fetch it from
 * any origin (localhost, file://, your hosting domain, etc.).
 *
 * Note: Apps Script ContentService doesn't support setting arbitrary
 * HTTP status codes — errors are indicated via the `error` field in
 * the JSON body instead.
 */
function buildResponse(payload) {
  const json = JSON.stringify(payload);
  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}


/**
 * ── MANUAL TEST ─────────────────────────────────────────────────
 * Run testGetData() from the Apps Script editor (▶ Run) to verify
 * your sheet is being read correctly before deploying.
 *
 * You'll see the output in  View → Logs  (or press Ctrl+Enter).
 */
function testGetData() {
  const data = getData();
  Logger.log("=== SETTINGS (%d rows) ===", data.settings.length);
  data.settings.forEach(row => Logger.log(JSON.stringify(row)));
  Logger.log("=== TRANSACTIONS (%d rows) ===", data.transactions.length);
  Logger.log("First row: %s", JSON.stringify(data.transactions[0]));
  Logger.log("Last row:  %s", JSON.stringify(data.transactions[data.transactions.length - 1]));
  Logger.log("Fetched at: %s", data.fetchedAt);
  return data;
}
