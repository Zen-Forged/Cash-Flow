/**
 * MONEY MAP — app.js
 * Simplified app version aligned to the trimmed UI:
 * - Status / balance
 * - 30-day runway
 * - Upcoming transactions
 * - DoorDash weekly goal
 *
 * Data source priority:
 * 1) Google Apps Script web app
 * 2) Local CSV fallback
 */

"use strict";

/* ══════════════════════════════════════════════════════════════
   1. CSV PARSER
══════════════════════════════════════════════════════════════ */
const CSV = (() => {
  function parse(raw) {
    const lines = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    if (lines.length < 2) return [];
    const headers = splitLine(lines[0]);
    const rows = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const vals = splitLine(line);
      const row = {};
      headers.forEach((h, j) => {
        row[h.trim()] = (vals[j] ?? "").trim();
      });
      rows.push(row);
    }
    return rows;
  }

  function splitLine(line) {
    const fields = [];
    let cur = "";
    let inQ = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQ = !inQ;
        }
      } else if (ch === "," && !inQ) {
        fields.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }

    fields.push(cur);
    return fields;
  }

  return { parse };
})();

/* ══════════════════════════════════════════════════════════════
   2. TYPE COERCIONS
══════════════════════════════════════════════════════════════ */
const Cast = (() => {
  function date(str) {
    if (!str) return null;
    const clean = String(str).replace(/^\$/, "").trim();
    const [m, d, y] = clean.split("/").map(Number);
    if (!m || !d || !y) return null;
    return new Date(y, m - 1, d);
  }

  function num(str) {
    if (str == null || str === "") return 0;
    const n = parseFloat(String(str).replace(/[$,]/g, ""));
    return Number.isNaN(n) ? 0 : n;
  }

  function bool(str) {
    const s = String(str).trim().toLowerCase();
    return s === "yes" || s === "true";
  }

  return { date, num, bool };
})();

/* ══════════════════════════════════════════════════════════════
   3. SETTINGS LOADER
══════════════════════════════════════════════════════════════ */
function loadSettings(rows) {
  const map = {};
  rows.forEach((r) => {
    const key = (r["Setting"] || "").trim();
    if (key) map[key] = (r["Value"] || "").trim();
  });

  const g = (k) => map[k] ?? "";
  const gn = (k) => Cast.num(g(k));
  const gd = (k) => Cast.date(g(k));

  const balanceAsOf = gd("Balance As Of Date");
  const windowStart = balanceAsOf ? new Date(balanceAsOf) : new Date();
  const windowEnd = new Date(windowStart);
  windowEnd.setDate(windowEnd.getDate() + 30);

  return {
    checkingBalance: gn("Checking Balance"),
    safeMinBalance: gn("Safe Minimum Balance"),
    balanceAsOf,
    forecastEndDate: gd("Forecast End Date"),
    forecastWindowDays: gn("Forecast Window Days"),
    riskHighThreshold: gn("Risk High Threshold"),
    riskMediumThreshold: gn("Risk Medium Threshold"),
    riskLowThreshold: gn("Risk Low Threshold"),
    includeOptional: Cast.bool(g("Include Optional (Must Pay? = No)")),
    targetMinBalance: gn("Target Minumum Balance"), // workbook typo preserved
    doorDashWeeklyGoal: gn("Door Dash Weekly Goal"),
    doorDashEarned: gn("DoorDash Earned"),
    windowStart,
    windowEnd,
  };
}

/* ══════════════════════════════════════════════════════════════
   4. TRANSACTIONS LOADER
══════════════════════════════════════════════════════════════ */
function loadTransactions(rows) {
  return rows
    .map((r) => ({
      date: Cast.date(r["Date"]),
      event: (r["Event"] || "").trim(),
      type: (r["Type"] || "").trim(),
      category: (r["Category"] || "").trim(),
      income: Cast.num(r["Income"]),
      expense: Cast.num(r["Expense"]),
      amountSigned: Cast.num(r["Amount_Signed"]),
      mustPay: Cast.bool(r["Must Pay?"]),
      account: (r["Account"] || "").trim(),
      balance: Cast.num(r["Balance"]),
      riskLevel: (r["Risk Level"] || "").trim().toUpperCase(),
      riskFlag: Cast.bool(r["Risk Flag (<SafeMin)"]),
      inWindow: Cast.bool(r["Window (Next X Days)"]),
      daysUntil: Cast.num(r["Days Until"]),
    }))
    .filter((tx) => tx.date !== null);
}

/* ══════════════════════════════════════════════════════════════
   5. DERIVED DATA
══════════════════════════════════════════════════════════════ */
function inRange(date, start, end) {
  const d = date.getTime();
  const s = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
  const e = new Date(end.getFullYear(), end.getMonth(), end.getDate()).getTime();
  return d >= s && d <= e;
}

function getWindowTxs(txs, settings) {
  return txs.filter((tx) => {
    if (!inRange(tx.date, settings.windowStart, settings.windowEnd)) return false;
    if (!settings.includeOptional && !tx.mustPay) return false;
    return true;
  });
}

function deriveRisk(txs, windowTxs, settings) {
  const levelOrder = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, MODERATE: 2, WATCH: 1, LOW: 0 };
  let worstLevel = "LOW";

  windowTxs.forEach((tx) => {
    if ((levelOrder[tx.riskLevel] ?? 0) > (levelOrder[worstLevel] ?? 0)) {
      worstLevel = tx.riskLevel;
    }
  });

  const riskRow = txs.find((tx) => tx.riskFlag) ?? null;
  const windowBalances = windowTxs.map((tx) => tx.balance);
  const lowestWindowBal = windowBalances.length
    ? Math.min(...windowBalances)
    : settings.checkingBalance;

  const bufferNeeded = Math.max(0, settings.targetMinBalance - lowestWindowBal);

  return {
    level: worstLevel || "LOW",
    riskRow,
    lowestWindowBal,
    bufferNeeded,
  };
}

function buildChartPoints(txs, settings) {
  const sorted = [...txs].sort((a, b) => a.date - b.date);
  const points = [];

  for (let d = 0; d <= 30; d++) {
    const dt = new Date(settings.windowStart);
    dt.setDate(dt.getDate() + d);

    const lastTx = sorted.filter((tx) => tx.date <= dt).pop();
    const bal = lastTx ? lastTx.balance : settings.checkingBalance;

    points.push({
      date: dt,
      label: dt.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      balance: parseFloat(bal.toFixed(2)),
    });
  }

  return points;
}

/* ══════════════════════════════════════════════════════════════
   6. FORMATTING HELPERS
══════════════════════════════════════════════════════════════ */
const fmt = (n) =>
  Number(n).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  });

const fmtShort = (d) =>
  d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—";

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/* ══════════════════════════════════════════════════════════════
   7. DOM HELPERS
══════════════════════════════════════════════════════════════ */
const $ = (id) => document.getElementById(id);

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function setWidth(id, pct) {
  const el = $(id);
  if (el) el.style.width = `${pct}%`;
}

/* ══════════════════════════════════════════════════════════════
   8. SVG CHART RENDERER
══════════════════════════════════════════════════════════════ */
function renderChart(container, chartPoints, settings) {
  if (!container || chartPoints.length < 2) return;

  const W = 600;
  const H = 155;
  const PL = 8;
  const PR = 8;
  const PT = 20;
  const PB = 26;
  const CW = W - PL - PR;
  const CH = H - PT - PB;

  const bals = chartPoints.map((p) => p.balance);
  const rawMin = Math.min(...bals);
  const rawMax = Math.max(...bals);
  const span = rawMax - rawMin || 1;
  const yPad = span * 0.14;
  const yMin = rawMin - yPad;
  const yMax = rawMax + yPad;
  const ySpan = yMax - yMin;

  const xOf = (i) => PL + (i / (chartPoints.length - 1)) * CW;
  const yOf = (v) => PT + CH - ((v - yMin) / ySpan) * CH;

  function bezierPath(pts) {
    if (!pts.length) return "";
    let d = `M ${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1];
      const n = pts[i];
      const mx = (p.x + n.x) / 2;
      d += ` C ${mx.toFixed(1)},${p.y.toFixed(1)} ${mx.toFixed(1)},${n.y.toFixed(1)} ${n.x.toFixed(1)},${n.y.toFixed(1)}`;
    }
    return d;
  }

  const coords = chartPoints.map((p, i) => ({ x: xOf(i), y: yOf(p.balance) }));
  const line = bezierPath(coords);
  const baseY = (PT + CH).toFixed(1);
  const area = `${line} L ${coords[coords.length - 1].x.toFixed(1)},${baseY} L ${coords[0].x.toFixed(1)},${baseY} Z`;

  const watchY = yOf(settings.safeMinBalance || settings.targetMinBalance || rawMin);

  const first = chartPoints[0];
  const mid = chartPoints[Math.floor(chartPoints.length / 2)];
  const last = chartPoints[chartPoints.length - 1];

  container.innerHTML = `
    <svg class="runway-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="30-day runway chart">
      <defs>
        <linearGradient id="mm-area-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="rgba(75,143,224,0.28)"/>
          <stop offset="100%" stop-color="rgba(75,143,224,0.02)"/>
        </linearGradient>
      </defs>

      <line x1="${PL}" y1="${PT + CH * 0.2}" x2="${W - PR}" y2="${PT + CH * 0.2}" stroke="var(--wire-2)" stroke-width="1"/>
      <line x1="${PL}" y1="${PT + CH * 0.5}" x2="${W - PR}" y2="${PT + CH * 0.5}" stroke="var(--wire-2)" stroke-width="1"/>
      <line x1="${PL}" y1="${watchY.toFixed(1)}" x2="${W - PR}" y2="${watchY.toFixed(1)}" stroke="var(--amber)" stroke-width="1" stroke-dasharray="5 4" opacity="0.55"/>

      <path d="${area}" fill="url(#mm-area-fill)"></path>
      <path d="${line}" fill="none" stroke="var(--sky)" stroke-width="3" stroke-linecap="round"></path>

      <circle cx="${coords[0].x.toFixed(1)}" cy="${coords[0].y.toFixed(1)}" r="4.5" fill="var(--sky)"></circle>
      <circle cx="${coords[Math.floor(coords.length / 2)].x.toFixed(1)}" cy="${coords[Math.floor(coords.length / 2)].y.toFixed(1)}" r="4" fill="var(--jade)"></circle>
      <circle cx="${coords[coords.length - 1].x.toFixed(1)}" cy="${coords[coords.length - 1].y.toFixed(1)}" r="4.5" fill="var(--sky)"></circle>

      <text x="${PL + 4}" y="${PT + 4}" font-family="var(--mono)" font-size="9" fill="var(--ink-3)">${esc(fmt(rawMax))}</text>
      <text x="${PL + 4}" y="${PT + CH * 0.5 - 4}" font-family="var(--mono)" font-size="9" fill="var(--ink-3)">${esc(fmt((rawMin + rawMax) / 2))}</text>
      <text x="${PL + 4}" y="${watchY - 6}" font-family="var(--mono)" font-size="9" fill="var(--amber)">watch line</text>

      <text x="${PL + 2}" y="${H - 4}" font-family="var(--mono)" font-size="9" fill="var(--ink-3)">${esc(fmtShort(first.date))}</text>
      <text x="${W / 2}" y="${H - 4}" text-anchor="middle" font-family="var(--mono)" font-size="9" fill="var(--ink-3)">${esc(fmtShort(mid.date))}</text>
      <text x="${W - PR - 2}" y="${H - 4}" text-anchor="end" font-family="var(--mono)" font-size="9" fill="var(--ink-3)">${esc(fmtShort(last.date))}</text>
    </svg>
  `;
}

/* ══════════════════════════════════════════════════════════════
   9. RENDERERS
══════════════════════════════════════════════════════════════ */
function renderHero(settings, riskData) {
  setText("hero-asof", settings.balanceAsOf ? `As of ${fmtShort(settings.balanceAsOf)}` : "—");
  setText("hero-balance", fmt(settings.checkingBalance));

  const badge = $("risk-level");
  if (badge) {
    badge.textContent = riskData.level;
    badge.dataset.level = riskData.level;
  }

  const trackLabelEl = $("hero-track-label");
  if (trackLabelEl) {
    if (riskData.riskRow?.date) {
      trackLabelEl.textContent = `Watch ${fmtShort(riskData.riskRow.date)}`;
    } else {
      trackLabelEl.textContent = "Tracking stable";
    }
  }

  const safeMin = settings.safeMinBalance || 0;
  const targetMin = settings.targetMinBalance || 0;
  const checking = settings.checkingBalance || 0;
  const maxRef = Math.max(checking, safeMin, targetMin, 1);

  const balancePct = Math.max(0, Math.min(100, Math.round((checking / maxRef) * 100)));
  const safePct = Math.max(0, Math.min(100, (safeMin / maxRef) * 100));
  const targetPct = Math.max(0, Math.min(100, (targetMin / maxRef) * 100));

  setWidth("hero-bar", balancePct);

  const safePin = $("hero-pin-safe");
  if (safePin) safePin.style.left = `${safePct}%`;

  const targetPin = $("hero-pin-target");
  if (targetPin) targetPin.style.left = `${targetPct}%`;
}

function renderDoorDash(settings) {
  const earned = settings.doorDashEarned;
  const goal = settings.doorDashWeeklyGoal;
  const pct = goal > 0 ? Math.min(100, Math.round((earned / goal) * 100)) : 0;
  const remaining = Math.max(0, goal - earned);
  const weekLabel = settings.balanceAsOf
    ? "Wk of " + settings.balanceAsOf.toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : "This week";

  setText("dd-week-tag", weekLabel);
  setText("dd-earned", fmt(earned));
  setText("dd-goal", fmt(goal));
  setText("dd-pct", `${pct}%`);

  const remEl = $("dd-remaining");
  if (remEl) {
    if (pct >= 100) {
      remEl.textContent = "Goal reached 🎉";
      remEl.style.color = "var(--jade)";
    } else {
      remEl.textContent = `${fmt(remaining)} to go`;
      remEl.style.color = "";
    }
  }

  requestAnimationFrame(() => {
    const fill = $("dd-fill");
    if (fill) fill.style.width = `${pct}%`;

    const bar = $("dd-progressbar");
    if (bar) bar.setAttribute("aria-valuenow", String(pct));
  });
}

function renderRunwayChart(chartPoints) {
  const container = $("runway-chart");
  if (!container) return;

  const first = chartPoints[0];
  const last = chartPoints[chartPoints.length - 1];

  setText(
    "chart-range-tag",
    first && last ? `${fmtShort(first.date)} – ${fmtShort(last.date)}` : "—"
  );

  renderChart(container, chartPoints, window.__moneyMap.settings);
}

function renderTransactions(windowTxs) {
  const nonZero = windowTxs.filter((tx) => tx.amountSigned !== 0);
  setText("tx-count-tag", `${nonZero.length} items`);

  const totalOut = nonZero
    .filter((tx) => tx.amountSigned < 0)
    .reduce((sum, tx) => sum + Math.abs(tx.amountSigned), 0);

  const totalIn = nonZero
    .filter((tx) => tx.amountSigned > 0)
    .reduce((sum, tx) => sum + tx.amountSigned, 0);

  const net = totalIn - totalOut;

  setText("tx-total-out", fmt(totalOut));
  setText("tx-total-in", fmt(totalIn));

  const netEl = $("tx-net");
  if (netEl) {
    netEl.textContent = `${net >= 0 ? "+" : "-"}${fmt(Math.abs(net))}`;
    netEl.className = `tot-v ${net >= 0 ? "tot-v--pos" : "tot-v--neg"}`;
  }

  const list = $("tx-list");
  if (!list) return;
  list.innerHTML = "";

  if (!windowTxs.length) {
    const li = document.createElement("li");
    li.style.cssText =
      "padding:20px;text-align:center;font-family:var(--mono);font-size:.68rem;color:var(--ink-3);";
    li.textContent = "No transactions in the next 30 days.";
    list.appendChild(li);
    return;
  }

  const sorted = [...windowTxs].sort((a, b) => a.date - b.date);

  sorted.forEach((tx) => {
    const isIncome = tx.amountSigned > 0;
    const isZero = tx.amountSigned === 0;
    const pipCls = isZero ? "zero" : isIncome ? "income" : "expense";
    const amtCls = isZero ? "zero" : isIncome ? "income" : "expense";
    const amtStr = isZero ? "—" : `${isIncome ? "+" : "−"}${fmt(Math.abs(tx.amountSigned))}`;

    const li = document.createElement("li");
    li.className = "tx-row";
    li.innerHTML = `
      <div class="tx-main">
        <div class="tx-name">${esc(tx.event || "Untitled Event")}</div>
        <div class="tx-meta">${esc(fmtShort(tx.date))} · ${esc(tx.category || tx.type || "—")}</div>
      </div>
      <div class="tx-type"><span class="tx-pip tx-pip--${pipCls}"></span></div>
      <div class="tx-amt tx-amt--${amtCls}">${esc(amtStr)}</div>
      <div class="tx-bal ${tx.riskFlag ? "tx-bal--warn" : ""}">${esc(fmt(tx.balance))}</div>
    `;
    list.appendChild(li);
  });
}

/* ══════════════════════════════════════════════════════════════
   10. ERROR STATE
══════════════════════════════════════════════════════════════ */
function renderError(err) {
  console.error("[MoneyMap] Failed to initialize:", err);

  setText("last-updated", "Load failed");
  setText("hero-asof", "Unable to load data");
  setText("hero-balance", "—");

  const badge = $("risk-level");
  if (badge) {
    badge.textContent = "ERROR";
    badge.dataset.level = "—";
  }

  const txList = $("tx-list");
  if (txList) {
    txList.innerHTML = `
      <li style="padding:16px;color:var(--rose);font-family:var(--mono);font-size:.66rem;">
        Unable to load data. Check your Apps Script deployment or CSV files.
      </li>
    `;
  }
}

/* ══════════════════════════════════════════════════════════════
   11. DATA SOURCE CONFIG
══════════════════════════════════════════════════════════════ */
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxsHG1DHdA_0Re5jRr4M5Z494nuJD_Rz4J3Gh4kBLgMmzk1zmX343bef7dypKr0Pjc5/exec";

const SETTINGS_CSV_URL = "CashFlow_Template_-_Settings.csv";
const TRANSACTIONS_CSV_URL = "CashFlow_Template_-_Transactions.csv";

const APPS_SCRIPT_TIMEOUT_MS = 8000;

/* ══════════════════════════════════════════════════════════════
   12. LOADERS
══════════════════════════════════════════════════════════════ */
async function loadFromAppsScript() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), APPS_SCRIPT_TIMEOUT_MS);

  try {
    const res = await fetch(APPS_SCRIPT_URL, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) throw new Error(`Apps Script HTTP ${res.status}`);
    const json = await res.json();

    if (!json.settings || !json.transactions) {
      throw new Error("Apps Script response missing settings or transactions");
    }

    console.log(`[MoneyMap] Loaded from Google Sheets (${json.fetchedAt})`);
    return {
      settingsRows: json.settings,
      txRows: json.transactions,
      source: "google-sheets",
    };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function loadFromCSV() {
  const [sRaw, tRaw] = await Promise.all([
    fetch(SETTINGS_CSV_URL).then((r) => {
      if (!r.ok) throw new Error(`Settings CSV ${r.status}`);
      return r.text();
    }),
    fetch(TRANSACTIONS_CSV_URL).then((r) => {
      if (!r.ok) throw new Error(`Transactions CSV ${r.status}`);
      return r.text();
    }),
  ]);

  console.log("[MoneyMap] Loaded from local CSV files");
  return {
    settingsRows: CSV.parse(sRaw),
    txRows: CSV.parse(tRaw),
    source: "local-csv",
  };
}

async function loadData() {
  let raw;

  if (APPS_SCRIPT_URL && APPS_SCRIPT_URL.startsWith("https://")) {
    try {
      raw = await loadFromAppsScript();
    } catch (err) {
      console.warn(`[MoneyMap] Apps Script failed (${err.message}), falling back to CSV`);
      raw = await loadFromCSV();
    }
  } else {
    raw = await loadFromCSV();
  }

  const settings = loadSettings(raw.settingsRows);
  const allTxs = loadTransactions(raw.txRows);
  const windowTxs = getWindowTxs(allTxs, settings);
  const riskData = deriveRisk(allTxs, windowTxs, settings);
  const chartPts = buildChartPoints(allTxs, settings);

  return { settings, allTxs, windowTxs, riskData, chartPts, source: raw.source };
}

/* ══════════════════════════════════════════════════════════════
   13. BOOTSTRAP
══════════════════════════════════════════════════════════════ */
async function init() {
  try {
    const data = await loadData();
    const { settings, windowTxs, riskData, chartPts, source } = data;

    window.__moneyMap = data;

    const now = new Date();
    const sourceLabel = source === "google-sheets" ? "Google Sheets" : "Local CSV";
    setText(
      "last-updated",
      now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + " · " + sourceLabel
    );

    renderHero(settings, riskData);
    renderRunwayChart(chartPts);
    renderTransactions(windowTxs);
    renderDoorDash(settings);

    console.log("[MoneyMap] Loaded ✓", data);
  } catch (err) {
    renderError(err);
  }
}

document.addEventListener("DOMContentLoaded", init);