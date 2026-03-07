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
    targetMinBalance: gn("Target Minumum Balance"),
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

  let lowestTx = null;
  windowTxs.forEach((tx) => {
    if (!lowestTx || tx.balance < lowestTx.balance) lowestTx = tx;
  });

  const lowestWindowBal = lowestTx ? lowestTx.balance : settings.checkingBalance;
  const bufferNeeded = Math.max(0, settings.targetMinBalance - lowestWindowBal);

  return {
    level: worstLevel || "LOW",
    lowestTx,
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
   6. HELPERS
══════════════════════════════════════════════════════════════ */
const fmt = (n) =>
  Number(n).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });

const fmtExact = (n) =>
  Number(n).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const fmtShort = (d) =>
  d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—";

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

function describeRisk(level) {
  switch ((level || "").toUpperCase()) {
    case "LOW":
      return "Stable";
    case "WATCH":
      return "Watch";
    case "MEDIUM":
    case "MODERATE":
      return "Caution";
    case "HIGH":
      return "High Risk";
    case "CRITICAL":
      return "Critical";
    default:
      return "Stable";
  }
}

function startOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? 0 : day;
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfWeek(date) {
  const d = startOfWeek(date);
  d.setDate(d.getDate() + 6);
  d.setHours(23, 59, 59, 999);
  return d;
}

/* ══════════════════════════════════════════════════════════════
   7. DOM HELPERS
══════════════════════════════════════════════════════════════ */
const $ = (id) => document.getElementById(id);

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

/* ══════════════════════════════════════════════════════════════
   8. SVG CHART
══════════════════════════════════════════════════════════════ */
function renderChart(container, chartPoints, settings, riskData) {
  if (!container || chartPoints.length < 2) return;

  const W = 600;
  const H = 220;
  const PL = 26;
  const PR = 18;
  const PT = 20;
  const PB = 34;
  const CW = W - PL - PR;
  const CH = H - PT - PB;

  const bals = chartPoints.map((p) => p.balance);
  const maxVal = Math.max(...bals, settings.checkingBalance, settings.targetMinBalance, settings.safeMinBalance);
  const minVal = Math.min(...bals, settings.checkingBalance, settings.safeMinBalance, 0);

  const topPad = Math.max(300, maxVal * 0.12);
  const bottomPad = Math.max(250, Math.abs(minVal) * 0.15);

  const yMax = maxVal + topPad;
  const yMin = Math.min(minVal - bottomPad, -100);
  const ySpan = yMax - yMin || 1;

  const xOf = (i) => PL + (i / (chartPoints.length - 1)) * CW;
  const yOf = (v) => PT + CH - ((v - yMin) / ySpan) * CH;

  const coords = chartPoints.map((p, i) => ({ x: xOf(i), y: yOf(p.balance), balance: p.balance, date: p.date }));

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

  const line = bezierPath(coords);
  const baseY = yOf(yMin);
  const area = `${line} L ${coords[coords.length - 1].x.toFixed(1)},${baseY.toFixed(1)} L ${coords[0].x.toFixed(1)},${baseY.toFixed(1)} Z`;

  const safeLineY = yOf(Math.max(settings.targetMinBalance || 0, settings.safeMinBalance || 0, 0));
  const cautionLineY = yOf(Math.max(settings.safeMinBalance || 0, 0));
  const zeroLineY = yOf(0);

  const first = chartPoints[0];
  const mid = chartPoints[Math.floor(chartPoints.length / 2)];
  const last = chartPoints[chartPoints.length - 1];

  const lowestTx = riskData.lowestTx;
  let lowMarker = "";
  if (lowestTx) {
    let nearestIndex = 0;
    let minDiff = Infinity;
    chartPoints.forEach((p, i) => {
      const diff = Math.abs(p.date.getTime() - lowestTx.date.getTime());
      if (diff < minDiff) {
        minDiff = diff;
        nearestIndex = i;
      }
    });

    const lowPoint = coords[nearestIndex];
    lowMarker = `
      <g>
        <path d="M ${lowPoint.x.toFixed(1)} ${(lowPoint.y - 30).toFixed(1)} 
                 L ${(lowPoint.x - 18).toFixed(1)} ${(lowPoint.y + 4).toFixed(1)} 
                 A 4 4 0 0 0 ${(lowPoint.x - 14).toFixed(1)} ${(lowPoint.y + 10).toFixed(1)}
                 L ${(lowPoint.x + 14).toFixed(1)} ${(lowPoint.y + 10).toFixed(1)}
                 A 4 4 0 0 0 ${(lowPoint.x + 18).toFixed(1)} ${(lowPoint.y + 4).toFixed(1)} Z"
              fill="var(--rose)"/>
        <rect x="${(lowPoint.x - 2).toFixed(1)}" y="${(lowPoint.y - 12).toFixed(1)}" width="4" height="14" rx="2" fill="#fff"/>
        <circle cx="${lowPoint.x.toFixed(1)}" cy="${(lowPoint.y + 6).toFixed(1)}" r="2.3" fill="#fff"/>
      </g>
    `;
  }

  container.innerHTML = `
    <svg class="runway-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="30-day runway chart">
      <defs>
        <linearGradient id="mm-area-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="rgba(37,99,235,0.28)"/>
          <stop offset="100%" stop-color="rgba(37,99,235,0.04)"/>
        </linearGradient>
      </defs>

      <rect x="${PL}" y="${PT}" width="${CW}" height="${Math.max(0, safeLineY - PT)}" fill="#dfead0" opacity="0.95"/>
      <rect x="${PL}" y="${safeLineY}" width="${CW}" height="${Math.max(0, cautionLineY - safeLineY)}" fill="#f3d78f" opacity="0.95"/>
      <rect x="${PL}" y="${cautionLineY}" width="${CW}" height="${Math.max(0, zeroLineY - cautionLineY)}" fill="#f2b16f" opacity="0.95"/>
      <rect x="${PL}" y="${zeroLineY}" width="${CW}" height="${Math.max(0, PT + CH - zeroLineY)}" fill="#ff6268" opacity="0.95"/>

      <line x1="${PL}" y1="${yOf(3000).toFixed(1)}" x2="${W - PR}" y2="${yOf(3000).toFixed(1)}" stroke="rgba(15,23,42,0.12)" stroke-dasharray="2 4"/>
      <line x1="${PL}" y1="${yOf(2000).toFixed(1)}" x2="${W - PR}" y2="${yOf(2000).toFixed(1)}" stroke="rgba(15,23,42,0.12)" stroke-dasharray="2 4"/>
      <line x1="${PL}" y1="${yOf(1000).toFixed(1)}" x2="${W - PR}" y2="${yOf(1000).toFixed(1)}" stroke="rgba(15,23,42,0.12)" stroke-dasharray="2 4"/>
      <line x1="${PL}" y1="${zeroLineY.toFixed(1)}" x2="${W - PR}" y2="${zeroLineY.toFixed(1)}" stroke="rgba(15,23,42,0.16)"/>

      <path d="${area}" fill="url(#mm-area-fill)"></path>
      <path d="${line}" fill="none" stroke="var(--sky)" stroke-width="4" stroke-linecap="round"></path>

      ${coords.map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="5.2" fill="var(--sky)"/>`).join("")}

      ${lowMarker}

      <text x="${PL - 6}" y="${(yOf(3000) + 4).toFixed(1)}" text-anchor="end" font-family="var(--mono)" font-size="10" fill="var(--ink-2)">$3000</text>
      <text x="${PL - 6}" y="${(yOf(2000) + 4).toFixed(1)}" text-anchor="end" font-family="var(--mono)" font-size="10" fill="var(--ink-2)">$2000</text>
      <text x="${PL - 6}" y="${(yOf(1000) + 4).toFixed(1)}" text-anchor="end" font-family="var(--mono)" font-size="10" fill="var(--ink-2)">$1000</text>
      <text x="${PL - 6}" y="${(zeroLineY + 4).toFixed(1)}" text-anchor="end" font-family="var(--mono)" font-size="10" fill="var(--ink-2)">$0</text>

      <text x="${(PL + CW * 0.52).toFixed(1)}" y="${(PT + (safeLineY - PT) / 2).toFixed(1)}" text-anchor="middle" font-family="var(--sans)" font-size="13" font-weight="700" fill="rgba(15,23,42,0.85)">Safe</text>
      <text x="${(PL + CW * 0.56).toFixed(1)}" y="${(safeLineY + (cautionLineY - safeLineY) / 2 + 4).toFixed(1)}" text-anchor="middle" font-family="var(--sans)" font-size="13" font-weight="700" fill="rgba(15,23,42,0.85)">Caution</text>
      <text x="${(PL + CW * 0.54).toFixed(1)}" y="${(cautionLineY + (zeroLineY - cautionLineY) / 2 + 4).toFixed(1)}" text-anchor="middle" font-family="var(--sans)" font-size="13" font-weight="700" fill="rgba(15,23,42,0.85)">Watch</text>
      <text x="${(PL + CW * 0.56).toFixed(1)}" y="${(zeroLineY + ((PT + CH) - zeroLineY) / 2 + 4).toFixed(1)}" text-anchor="middle" font-family="var(--sans)" font-size="13" font-weight="700" fill="#fff">Danger</text>

      <text x="${PL}" y="${H - 8}" font-family="var(--sans)" font-size="11" fill="var(--ink-2)">${esc(fmtShort(first.date))}</text>
      <text x="${W / 2}" y="${H - 8}" text-anchor="middle" font-family="var(--sans)" font-size="11" fill="var(--ink-2)">${esc(fmtShort(mid.date))}</text>
      <text x="${W - PR}" y="${H - 8}" text-anchor="end" font-family="var(--sans)" font-size="11" fill="var(--ink-2)">${esc(fmtShort(last.date))}</text>
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

  setText("hero-status-copy", describeRisk(riskData.level));
  setText("hero-lowest-balance", fmt(riskData.lowestWindowBal));
  setText("hero-lowest-date", riskData.lowestTx?.date ? fmtShort(riskData.lowestTx.date) : "—");
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
  setText("dd-pct", `${pct}% complete`);

  const remEl = $("dd-remaining");
  if (remEl) {
    if (pct >= 100) {
      remEl.textContent = "Goal reached";
    } else {
      remEl.textContent = `${fmt(remaining)} remaining`;
    }
  }

  requestAnimationFrame(() => {
    const fill = $("dd-fill");
    if (fill) fill.style.width = `${pct}%`;

    const bar = $("dd-progressbar");
    if (bar) bar.setAttribute("aria-valuenow", String(pct));
  });
}

function renderRunwayChart(chartPoints, settings, riskData) {
  const container = $("runway-chart");
  if (!container) return;

  const first = chartPoints[0];
  const last = chartPoints[chartPoints.length - 1];

  setText("chart-range-tag", first && last ? `${fmtShort(first.date)} – ${fmtShort(last.date)}` : "—");
  renderChart(container, chartPoints, settings, riskData);
}

function renderRunwaySummary(settings, riskData) {
  const el = $("runway-summary");
  if (!el) return;

  if (!riskData.lowestTx) {
    el.textContent = "No transactions in the current forecast window.";
    return;
  }

  const lowDate = fmtShort(riskData.lowestTx.date);
  const lowBal = fmtExact(riskData.lowestTx.balance);
  const eventName = riskData.lowestTx.event || "scheduled activity";

  let summary = `Lowest balance hits ${lowDate} at ${lowBal}`;

  if (eventName) {
    summary += ` after ${eventName}`;
  }

  if (riskData.bufferNeeded > 0) {
    summary += `. You are ${fmtExact(riskData.bufferNeeded)} below your target buffer.`;
  } else {
    summary += `. Balance stays above your target buffer.`;
  }

  el.textContent = summary;
}

function renderTransactions(windowTxs, settings) {
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

  const groupsEl = $("tx-groups");
  if (!groupsEl) return;
  groupsEl.innerHTML = "";

  if (!nonZero.length) {
    groupsEl.innerHTML = `<div class="tx-empty">No transactions in the next 30 days.</div>`;
    return;
  }

  const sorted = [...nonZero].sort((a, b) => a.date - b.date);

  const now = settings.balanceAsOf || new Date();
  const thisWeekEnd = endOfWeek(now);
  const nextWeekStart = new Date(thisWeekEnd);
  nextWeekStart.setDate(nextWeekStart.getDate() + 1);
  const nextWeekEnd = endOfWeek(nextWeekStart);

  const groups = {
    "This Week": [],
    "Next Week": [],
    "Later": [],
  };

  sorted.forEach((tx) => {
    if (tx.date <= thisWeekEnd) {
      groups["This Week"].push(tx);
    } else if (tx.date >= nextWeekStart && tx.date <= nextWeekEnd) {
      groups["Next Week"].push(tx);
    } else {
      groups["Later"].push(tx);
    }
  });

  Object.entries(groups).forEach(([label, items]) => {
    if (!items.length) return;

    const section = document.createElement("section");
    section.className = "week-group";

    const title = document.createElement("div");
    title.className = "week-group-title";
    title.textContent = label;
    section.appendChild(title);

    const list = document.createElement("ul");
    list.className = "week-list";

    items.forEach((tx) => {
      const isIncome = tx.amountSigned > 0;
      const amtClass = isIncome ? "week-amt--income" : "week-amt--expense";
      const amtStr = `${isIncome ? "+" : "−"}${fmt(Math.abs(tx.amountSigned))}`;

      const li = document.createElement("li");
      li.className = "week-item";
      li.innerHTML = `
        <div class="week-date">${esc(fmtShort(tx.date))}</div>
        <div class="week-main">
          <div class="week-name">${esc(tx.event || "Untitled Event")}</div>
          <div class="week-meta">${esc(tx.category || tx.type || "—")}</div>
        </div>
        <div class="week-amt ${amtClass}">${esc(amtStr)}</div>
        <div class="week-bal ${tx.riskFlag ? "week-bal--warn" : ""}">${esc(fmt(tx.balance))}</div>
      `;
      list.appendChild(li);
    });

    section.appendChild(list);
    groupsEl.appendChild(section);
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
  setText("hero-status-copy", "—");
  setText("hero-lowest-balance", "—");
  setText("hero-lowest-date", "—");
  setText("runway-summary", "Unable to load data. Check your Apps Script deployment or CSV files.");

  const badge = $("risk-level");
  if (badge) {
    badge.textContent = "ERROR";
    badge.dataset.level = "ERROR";
  }

  const groups = $("tx-groups");
  if (groups) {
    groups.innerHTML = `<div class="tx-empty">Unable to load transactions.</div>`;
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

    const now = new Date();
    const sourceLabel = source === "google-sheets" ? "Google Sheets" : "Local CSV";
    setText(
      "last-updated",
      now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + " · " + sourceLabel
    );

    renderHero(settings, riskData);
    renderRunwayChart(chartPts, settings, riskData);
    renderRunwaySummary(settings, riskData);
    renderTransactions(windowTxs, settings);
    renderDoorDash(settings);
  } catch (err) {
    renderError(err);
  }
}

document.addEventListener("DOMContentLoaded", init);