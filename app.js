/**
 * MONEY MAP — app.js
 * ─────────────────────────────────────────────────────────────────────
 * Source of truth: Google Sheet (Settings + Transactions tabs) via
 * Apps Script Web App, with local CSV fallback.
 *
 * Section map (matches index.html):
 *   §1  Hero card          — renderHero()
 *   §2  DoorDash           — renderDoorDash()
 *   §3  Monthly Flow       — renderFlowGrid()
 *   §4  Financial Outlook  — renderRunwayChart()
 *   §5  7-Day Forecast     — render7Day()
 *   §6  14-Day Forecast    — render14Day()
 * ─────────────────────────────────────────────────────────────────────
 */

"use strict";

/* ══════════════════════════════════════════════════════════════
   1. CSV PARSER — zero-dependency, handles CRLF / quoted commas
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
      const row  = {};
      headers.forEach((h, j) => { row[h.trim()] = (vals[j] ?? "").trim(); });
      rows.push(row);
    }
    return rows;
  }

  function splitLine(line) {
    const fields = [];
    let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (ch === ',' && !inQ) { fields.push(cur); cur = ""; }
      else cur += ch;
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
    const clean = str.replace(/^\$/, "").trim();
    const [m, d, y] = clean.split("/").map(Number);
    if (!m || !d || !y) return null;
    return new Date(y, m - 1, d);
  }

  function num(str) {
    if (str == null || str === "") return 0;
    const n = parseFloat(String(str).replace(/[$,]/g, ""));
    return isNaN(n) ? 0 : n;
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
  rows.forEach(r => {
    const k = (r["Setting"] || "").trim();
    if (k) map[k] = (r["Value"] || "").trim();
  });

  const g  = k => map[k] ?? "";
  const gn = k => Cast.num(g(k));
  const gd = k => Cast.date(g(k));

  const balanceAsOf = gd("Balance As Of Date");
  const windowStart = balanceAsOf ? new Date(balanceAsOf) : new Date();
  const windowEnd   = new Date(windowStart);
  windowEnd.setDate(windowEnd.getDate() + 30);

  return {
    checkingBalance:     gn("Checking Balance"),
    safeMinBalance:      gn("Safe Minimum Balance"),
    balanceAsOf,
    forecastEndDate:     gd("Forecast End Date"),
    forecastWindowDays:  gn("Forecast Window Days") || 14,
    riskHighThreshold:   gn("Risk High Threshold"),
    riskMediumThreshold: gn("Risk Medium Threshold"),
    riskLowThreshold:    gn("Risk Low Threshold"),
    includeOptional:     Cast.bool(g("Include Optional (Must Pay? = No)")),
    targetMinBalance:    gn("Target Minumum Balance"),   // workbook typo preserved
    doorDashWeeklyGoal:  gn("Door Dash Weekly Goal"),
    doorDashEarned:      gn("DoorDash Earned"),
    dasherAppAmount:     gn("Dasher App Amount"),
    windowStart,
    windowEnd,
  };
}


/* ══════════════════════════════════════════════════════════════
   4. TRANSACTIONS LOADER
══════════════════════════════════════════════════════════════ */
function loadTransactions(rows) {
  return rows
    .map(r => ({
      date:         Cast.date(r["Date"]),
      event:        (r["Event"]       || "").trim(),
      type:         (r["Type"]        || "").trim(),
      category:     (r["Category"]    || "").trim(),
      income:       Cast.num(r["Income"]),
      expense:      Cast.num(r["Expense"]),
      amountSigned: Cast.num(r["Amount_Signed"]),
      mustPay:      Cast.bool(r["Must Pay?"]),
      account:      (r["Account"]     || "").trim(),
      balance:      Cast.num(r["Balance"]),
      riskLevel:    (r["Risk Level"]  || "").trim().toUpperCase(),
      riskFlag:     Cast.bool(r["Risk Flag (<SafeMin)"]),
      inWindow:     Cast.bool(r["Window (Next X Days)"]),
      daysUntil:    Cast.num(r["Days Until"]),
    }))
    .filter(tx => tx.date !== null);
}


/* ══════════════════════════════════════════════════════════════
   5. DERIVED DATA
══════════════════════════════════════════════════════════════ */
function inRange(date, start, end) {
  const d = date.getTime();
  const s = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
  const e = new Date(end.getFullYear(),   end.getMonth(),   end.getDate()).getTime();
  return d >= s && d <= e;
}

function getWindowTxs(txs, settings) {
  return txs.filter(tx => {
    if (!inRange(tx.date, settings.windowStart, settings.windowEnd)) return false;
    if (!settings.includeOptional && !tx.mustPay) return false;
    return true;
  });
}

function deriveRisk(txs, windowTxs, settings) {
  const levelOrder = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, MODERATE: 2, WATCH: 1, LOW: 0 };
  let worstLevel = "LOW";
  windowTxs.forEach(tx => {
    if ((levelOrder[tx.riskLevel] ?? 0) > (levelOrder[worstLevel] ?? 0)) {
      worstLevel = tx.riskLevel;
    }
  });

  const riskRow         = txs.find(tx => tx.riskFlag);
  const windowBalances  = windowTxs.map(tx => tx.balance);
  const lowestWindowBal = windowBalances.length ? Math.min(...windowBalances) : settings.checkingBalance;
  const bufferNeeded    = Math.max(0, settings.targetMinBalance - lowestWindowBal);

  return { level: worstLevel || "LOW", riskRow: riskRow ?? null, lowestWindowBal, bufferNeeded };
}

function buildChartPoints(txs, settings) {
  const sorted = [...txs].sort((a, b) => a.date - b.date);
  const points = [];
  for (let d = 0; d <= 30; d++) {
    const dt     = new Date(settings.windowStart);
    dt.setDate(dt.getDate() + d);
    const lastTx = sorted.filter(tx => tx.date <= dt).pop();
    const bal    = lastTx ? lastTx.balance : settings.checkingBalance;
    points.push({
      date:    dt,
      label:   dt.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      balance: parseFloat(bal.toFixed(2)),
    });
  }
  return points;
}


/* ══════════════════════════════════════════════════════════════
   6. FORMATTING HELPERS
══════════════════════════════════════════════════════════════ */
const fmt      = n => Number(n).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
const fmtWhole = n => Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtK     = n => {
  const abs = Math.abs(n);
  if (abs >= 10000) return (n < 0 ? "-$" : "$") + (abs / 1000).toFixed(1) + "k";
  return fmt(n);
};
const fmtShort = d => d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "\u2014";
const esc      = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");


/* ══════════════════════════════════════════════════════════════
   7. SVG CHART RENDERER
   Bezier-smoothed area + line, threshold dashes, today/min markers.
══════════════════════════════════════════════════════════════ */
function renderChart(container, chartPoints, settings) {
  if (!container || chartPoints.length < 2) return;

  const W = 600, H = 155;
  const PL = 8, PR = 8, PT = 20, PB = 26;
  const CW = W - PL - PR;
  const CH = H - PT - PB;

  const bals   = chartPoints.map(p => p.balance);
  const rawMin = Math.min(...bals);
  const rawMax = Math.max(...bals);
  const span   = rawMax - rawMin || 1;
  const yPad   = span * 0.14;
  const yMin   = rawMin - yPad;
  const yMax   = rawMax + yPad;
  const ySpan  = yMax - yMin;

  const xOf = i => PL + (i / (chartPoints.length - 1)) * CW;
  const yOf = v => PT + CH - ((v - yMin) / ySpan) * CH;

  function bezierPath(pts) {
    if (!pts.length) return "";
    let d = `M ${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1], n = pts[i];
      const mx = (p.x + n.x) / 2;
      d += ` C ${mx.toFixed(1)},${p.y.toFixed(1)} ${mx.toFixed(1)},${n.y.toFixed(1)} ${n.x.toFixed(1)},${n.y.toFixed(1)}`;
    }
    return d;
  }

  const coords = chartPoints.map((p, i) => ({ x: xOf(i), y: yOf(p.balance) }));
  const line   = bezierPath(coords);
  const baseY  = (PT + CH).toFixed(1);
  const area   = line
    + ` L ${xOf(chartPoints.length - 1).toFixed(1)},${baseY}`
    + ` L ${xOf(0).toFixed(1)},${baseY} Z`;

  const grids = [0.25, 0.5, 0.75].map(f => {
    const v  = yMin + ySpan * f;
    const gy = yOf(v).toFixed(1);
    return `<line x1="${PL}" y1="${gy}" x2="${W - PR}" y2="${gy}"
                  stroke="rgba(0,0,0,0.03)" stroke-width="1"/>
            <text x="${PL + 4}" y="${(parseFloat(gy) - 4).toFixed(1)}"
                  font-family="DM Mono,monospace" font-size="8" fill="#B8B2AA">${fmtK(v)}</text>`;
  }).join("");

  const threshSvg = [
    { v: settings.safeMinBalance,   c: "#8C5040", lbl: "safe floor", op: .45 },
    { v: settings.targetMinBalance, c: "#A07830", lbl: "target",     op: .38 },
  ].filter(t => t.v > yMin && t.v < yMax).map(t => {
    const ty = yOf(t.v).toFixed(1);
    return `<line x1="${PL}" y1="${ty}" x2="${W - PR}" y2="${ty}"
                  stroke="${t.c}" stroke-width="0.8" stroke-dasharray="5 4" opacity="${t.op}"/>
            <text x="${W - PR - 5}" y="${(parseFloat(ty) - 4).toFixed(1)}"
                  font-family="DM Mono,monospace" font-size="7.5"
                  fill="${t.c}" text-anchor="end" opacity="${t.op + 0.2}">${t.lbl}</text>`;
  }).join("");

  const xLbls = [0, 7, 15, 23, chartPoints.length - 1].map(i => {
    const idx    = Math.min(i, chartPoints.length - 1);
    const p      = chartPoints[idx];
    const lx     = xOf(idx).toFixed(1);
    const anchor = idx === 0 ? "start" : idx === chartPoints.length - 1 ? "end" : "middle";
    return `<text x="${lx}" y="${H - 4}" font-family="DM Mono,monospace" font-size="8"
                  fill="#B8B2AA" text-anchor="${anchor}">${p.label}</text>`;
  }).join("");

  const minIdx = bals.indexOf(rawMin);
  const minSvg = minIdx > 0 ? `
    <circle cx="${xOf(minIdx).toFixed(1)}" cy="${yOf(rawMin).toFixed(1)}" r="3.5" fill="#A07830" opacity="0.9"/>
    <text x="${xOf(minIdx).toFixed(1)}" y="${(yOf(rawMin) - 8).toFixed(1)}"
          font-family="DM Mono,monospace" font-size="8" fill="#A07830"
          text-anchor="middle">${fmtK(rawMin)}</text>` : "";

  const todayX    = xOf(0).toFixed(1);
  const todayY    = yOf(chartPoints[0].balance).toFixed(1);
  const todayDrop = `<line x1="${todayX}" y1="${todayY}" x2="${todayX}" y2="${baseY}"
                           stroke="#4A7C5A" stroke-width="0.6" opacity="0.18" stroke-dasharray="2 3"/>`;

  container.innerHTML = `<svg class="runway-svg" viewBox="0 0 ${W} ${H}"
       xmlns="http://www.w3.org/2000/svg" role="img" aria-label="30-day balance forecast">
  <defs>
    <linearGradient id="cArea" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#4A7C5A" stop-opacity="0.16"/>
      <stop offset="80%"  stop-color="#4A7C5A" stop-opacity="0.02"/>
      <stop offset="100%" stop-color="#4A7C5A" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="cLine" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%"   stop-color="#4A7C5A"/>
      <stop offset="55%"  stop-color="#4A7C5A"/>
      <stop offset="100%" stop-color="#9A7C38"/>
    </linearGradient>
    <filter id="cGlow" x="-5%" y="-60%" width="110%" height="220%">
      <feGaussianBlur stdDeviation="2" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <clipPath id="cClip">
      <rect x="${PL}" y="${PT}" width="${CW}" height="${CH}"/>
    </clipPath>
  </defs>
  <rect width="${W}" height="${H}" fill="#FAF8F3"/>
  ${grids}
  ${threshSvg}
  ${todayDrop}
  <path d="${area}" fill="url(#cArea)" clip-path="url(#cClip)"/>
  <path d="${line}" fill="none" stroke="url(#cLine)" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round"
        filter="url(#cGlow)" clip-path="url(#cClip)"/>
  ${minSvg}
  <circle cx="${todayX}" cy="${todayY}" r="4.5" fill="#4A7C5A" opacity="0.95"/>
  <circle cx="${todayX}" cy="${todayY}" r="9" fill="none" stroke="#4A7C5A" stroke-width="1" opacity="0.18"/>
  ${xLbls}
</svg>`.trim();
}


/* ══════════════════════════════════════════════════════════════
   8. DOM HELPERS
══════════════════════════════════════════════════════════════ */
const $       = id  => document.getElementById(id);
const setText = (id, val) => { const el = $(id); if (el) el.textContent = val; };


/* ══════════════════════════════════════════════════════════════
   9. UI RENDERERS
══════════════════════════════════════════════════════════════ */

/* ── §1  Hero — balance + integrated weather status ── */
function renderHero(settings, riskData) {
  const { checkingBalance, balanceAsOf } = settings;
  const { level, riskRow, lowestWindowBal } = riskData;

  // Balance
  setText("hero-balance", fmtWhole(checkingBalance));
  setText("hero-asof", balanceAsOf
    ? balanceAsOf.toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : "\u2014"
  );

  // Weather display config keyed by risk level
  const WEATHER = {
    LOW:      { label: "Clear",   icon: "sun",   dir: "Balance is steady. No tight spots in view." },
    WATCH:    { label: "Watch",   icon: "cloud",  dir: "A few items to keep an eye on ahead." },
    MEDIUM:   { label: "Watch",   icon: "cloud",  dir: "A few items to keep an eye on ahead." },
    MODERATE: { label: "Watch",   icon: "cloud",  dir: "A few items to keep an eye on ahead." },
    HIGH:     { label: "Caution", icon: "rain",   dir: "Some tighter moments in the next two weeks." },
    CRITICAL: { label: "Caution", icon: "rain",   dir: "Balance may fall below safe levels." },
  };
  const wx = WEATHER[level] ?? WEATHER["LOW"];

  // Update badge
  const badge = $("risk-level");
  if (badge) {
    badge.dataset.level = level;
    setText("risk-level-text", wx.label);
    const iconEl = $("hero-wx-icon");
    if (iconEl) iconEl.innerHTML = weatherIconSVG(wx.icon);
  }

  // Direction phrase (in badge row)
  setText("hero-direction", wx.dir);

  // Hero footer — Direction cell
  const dirFoot = $("hero-direction-foot");
  if (dirFoot) {
    const isGood = ["LOW", "WATCH", "MEDIUM", "MODERATE"].includes(level);
    dirFoot.textContent = level === "LOW"     ? "Moving forward"
                        : isGood              ? "Heads up"
                        :                       "At risk";
    dirFoot.className = "hfc-value " + (level === "LOW" ? "good" : isGood ? "caution" : "alert");
  }

  // Hero footer — Projected Low cell
  const projLow = riskRow ? riskRow.balance : lowestWindowBal;
  const projEl  = $("risk-balance");
  if (projEl) {
    projEl.textContent = projLow != null ? fmt(projLow) : "\u2014";
    if      (projLow < settings.safeMinBalance)    projEl.className = "hfc-value alert";
    else if (projLow < settings.targetMinBalance)  projEl.className = "hfc-value caution";
    else                                           projEl.className = "hfc-value";
  }
}

/* Inline SVG icons for weather badge (10×10 viewBox) */
function weatherIconSVG(type) {
  const icons = {
    sun: `<circle cx="5" cy="5" r="2.2" fill="currentColor"/>
          <g stroke="currentColor" stroke-width="1" stroke-linecap="round">
            <line x1="5" y1="0.5" x2="5" y2="1.8"/>
            <line x1="5" y1="8.2" x2="5" y2="9.5"/>
            <line x1="0.5" y1="5" x2="1.8" y2="5"/>
            <line x1="8.2" y1="5" x2="9.5" y2="5"/>
            <line x1="1.6" y1="1.6" x2="2.5" y2="2.5"/>
            <line x1="7.5" y1="7.5" x2="8.4" y2="8.4"/>
            <line x1="8.4" y1="1.6" x2="7.5" y2="2.5"/>
            <line x1="2.5" y1="7.5" x2="1.6" y2="8.4"/>
          </g>`,
    cloud: `<path d="M2.5,7 Q1,7 1,5.5 Q1,4 2.5,4 Q2.8,2.5 4.5,2.5 Q6,2.5 6.5,3.8
                     Q8,3.8 8,5.5 Q8,7 6.5,7 Z" fill="currentColor" opacity=".85"/>`,
    rain:  `<path d="M2,6.5 Q0.5,6.5 0.5,5 Q0.5,3.5 2,3.5 Q2.3,2 4,2 Q5.5,2 6,3.3
                     Q7.5,3.3 7.5,5 Q7.5,6.5 6,6.5 Z" fill="currentColor" opacity=".8"/>
            <g stroke="currentColor" stroke-width=".9" stroke-linecap="round" opacity=".7">
              <line x1="2.5" y1="8" x2="2" y2="9.5"/>
              <line x1="4.5" y1="8" x2="4" y2="9.5"/>
              <line x1="6.5" y1="8" x2="6" y2="9.5"/>
            </g>`,
  };
  return icons[type] ?? icons.sun;
}


/* ── §2  DoorDash contribution ── */
function renderDoorDash(settings) {
  const { doorDashEarned: earned, doorDashWeeklyGoal: goal, dasherAppAmount, balanceAsOf } = settings;
  const pct       = goal > 0 ? Math.min(100, Math.round((earned / goal) * 100)) : 0;
  const remaining = Math.max(0, goal - earned);
  const weekLabel = balanceAsOf
    ? "Wk of " + balanceAsOf.toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : "This week";

  setText("dd-week-tag", weekLabel);
  setText("dd-earned",   fmt(earned));
  setText("dd-goal",     fmt(goal));
  setText("dd-pct",      pct + "% of goal");

  const remEl = $("dd-remaining");
  if (remEl) {
    remEl.textContent = pct >= 100 ? "Goal reached \uD83C\uDF89" : fmt(remaining) + " to go";
    if (pct >= 100) remEl.style.color = "var(--forest)";
  }

  const appRow = $("dd-app-row");
  if (appRow) {
    if (dasherAppAmount > 0) {
      setText("dd-app-amount", fmt(dasherAppAmount));
      appRow.style.display = "";
    } else {
      appRow.style.display = "none";
    }
  }

  requestAnimationFrame(() => {
    const fill = $("dd-fill");
    if (fill) fill.style.width = pct + "%";
    const bar  = $("dd-progressbar");
    if (bar)   bar.setAttribute("aria-valuenow", pct);
  });
}


/* ── §3  Monthly Flow grid ── */
function renderFlowGrid(windowTxs, settings) {
  const nonZero  = windowTxs.filter(tx => tx.amountSigned !== 0);
  const totalIn  = nonZero.filter(tx => tx.amountSigned > 0)
                          .reduce((s, tx) => s + tx.amountSigned, 0);
  const totalOut = nonZero.filter(tx => tx.amountSigned < 0)
                          .reduce((s, tx) => s + Math.abs(tx.amountSigned), 0);
  const net      = totalIn - totalOut;

  setText("tx-count-tag",  nonZero.length + " items");
  setText("tx-total-in",   fmt(totalIn));
  setText("tx-total-out",  fmt(totalOut));

  const netEl = $("tx-net");
  if (netEl) {
    netEl.textContent = (net >= 0 ? "+" : "") + fmt(net);
    netEl.className   = "flow-net-amount" + (net < 0 ? " negative" : "");
  }
}


/* ── §4  Financial Outlook chart ── */
function renderRunwayChart(chartPoints, settings) {
  const container = $("runway-chart");
  if (!container) return;

  const first = chartPoints[0];
  const last  = chartPoints[chartPoints.length - 1];
  setText("chart-range-tag",
    first && last ? fmtShort(first.date) + " \u2013 " + fmtShort(last.date) : "\u2014"
  );

  renderChart(container, chartPoints, settings);
}


/* ── §5  7-Day Forecast ── */
function render7Day(windowTxs, settings) {
  const list = $("events-list");
  if (!list) return;

  const cutoff = new Date(settings.windowStart);
  cutoff.setDate(cutoff.getDate() + 7);

  const items = [...windowTxs]
    .filter(tx => tx.date <= cutoff)
    .sort((a, b) => a.date - b.date);

  setText("events-window-tag",
    fmtShort(settings.windowStart) + " \u2013 " + fmtShort(cutoff)
  );

  list.innerHTML = "";
  if (!items.length) {
    list.innerHTML = `<li class="fx-empty">No events in the next 7 days.</li>`;
    return;
  }
  items.forEach((tx, idx) => list.appendChild(buildFxRow(tx, idx, settings)));
}


/* ── §6  14-Day Forecast ── */
function render14Day(windowTxs, settings) {
  const list = $("tx-list");
  if (!list) return;

  const cutoff = new Date(settings.windowStart);
  cutoff.setDate(cutoff.getDate() + 14);

  const items = [...windowTxs]
    .filter(tx => tx.date <= cutoff)
    .sort((a, b) => a.date - b.date);

  setText("tx-list-count", items.length + " items");

  list.innerHTML = "";
  if (!items.length) {
    list.innerHTML = `<li class="fx-empty">No transactions in the next 14 days.</li>`;
    return;
  }
  items.forEach((tx, idx) => list.appendChild(buildFxRow(tx, idx, settings)));
}


/* Shared row builder — used by both forecast tables */
function buildFxRow(tx, idx, settings) {
  const isIncome = tx.amountSigned > 0;
  const isZero   = tx.amountSigned === 0;
  const amtStr   = isZero
    ? "\u2014"
    : (isIncome ? "+" : "\u2212") + fmt(Math.abs(tx.amountSigned));
  const amtCls   = isZero ? "zero" : isIncome ? "in" : "out";

  let balCls = "";
  if      (tx.balance < settings.safeMinBalance)   balCls = "alert";
  else if (tx.balance < settings.targetMinBalance) balCls = "low";

  const li = document.createElement("li");
  li.className = "fx-item";
  li.style.animationDelay = `${(idx * 0.03).toFixed(2)}s`;
  li.innerHTML = `
    <div class="fxi-ev">
      <div class="fxi-name">${esc(tx.event)}</div>
      <div class="fxi-meta">
        <span class="fxi-date">${fmtShort(tx.date)}</span>
        ${tx.category ? `<span class="fxi-tag">${esc(tx.category)}</span>` : ""}
      </div>
    </div>
    <div class="fxi-amt ${amtCls}">${amtStr}</div>
    <div class="fxi-bal ${balCls}">${fmt(tx.balance)}</div>
  `;
  return li;
}


/* ── Error banner ── */
function renderError(err) {
  console.error("[MoneyMap]", err);

  const feed = document.querySelector(".feed");
  if (feed && !$("mm-error-banner")) {
    const banner = document.createElement("div");
    banner.id = "mm-error-banner";
    banner.innerHTML = `
      <div class="err-icon" aria-hidden="true">\u26A0</div>
      <div class="err-body">
        <div class="err-title">Could not load data</div>
        <div class="err-msg">${esc(err.message ?? "Unknown error")}</div>
      </div>`;
    feed.insertBefore(banner, feed.firstChild);
  }

  setText("hero-balance", "\u2014");
  setText("hero-asof",    "Load failed");
}


/* ══════════════════════════════════════════════════════════════
   10. DATA SOURCES
   ──────────────────────────────────────────────────────────────
   Two sources, tried in order:
     1. Google Apps Script Web App (live Google Sheets data)
     2. Local CSV files (fallback / offline / dev)

   ┌─ SETUP INSTRUCTIONS ──────────────────────────────────────┐
   │  1. Open your Google Sheet                                 │
   │  2. Extensions > Apps Script                               │
   │  3. Paste the full contents of CODE.gs into the editor     │
   │  4. Click "Deploy" > "New deployment"                      │
   │     · Type: Web app                                        │
   │     · Execute as: Me                                       │
   │     · Who has access: Anyone (read-only, no auth needed)   │
   │  5. Copy the Web app URL that appears after deploying      │
   │  6. Paste it into APPS_SCRIPT_URL below                    │
   │  7. Done -- refresh Money Map                              │
   └────────────────────────────────────────────────────────────┘
══════════════════════════════════════════════════════════════ */

// ─── STEP 6: Paste your deployed Web App URL here ────────────
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxsHG1DHdA_0Re5jRr4M5Z494nuJD_Rz4J3Gh4kBLgMmzk1zmX343bef7dypKr0Pjc5/exec";   // <- PASTE YOUR /exec URL HERE
// ─────────────────────────────────────────────────────────────

const SETTINGS_CSV_URL     = "CashFlow_Template_-_Settings.csv";
const TRANSACTIONS_CSV_URL = "CashFlow_Template_-_Transactions.csv";
const APPS_SCRIPT_TIMEOUT_MS = 8000;


async function loadFromAppsScript() {
  const fetchPromise = fetch(APPS_SCRIPT_URL, {
    method: "GET", mode: "cors", credentials: "omit", redirect: "follow",
  });
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(
      `Request timed out after ${APPS_SCRIPT_TIMEOUT_MS / 1000}s. ` +
      `Open the Apps Script URL directly in a browser tab to test it.`
    )), APPS_SCRIPT_TIMEOUT_MS)
  );

  let res;
  try { res = await Promise.race([fetchPromise, timeoutPromise]); }
  catch (err) {
    throw new Error(err.message.startsWith("Request timed out")
      ? err.message
      : `Network error reaching Apps Script: ${err.message}. Check your connection.`);
  }

  if (!res.ok) throw new Error(`Apps Script returned HTTP ${res.status}. ` +
    (res.status === 401 || res.status === 403
      ? `Set "Who has access" to "Anyone" and re-deploy.`
      : `Re-deploy from Extensions > Apps Script > Deploy.`));

  let json;
  try { json = await res.json(); }
  catch { throw new Error(`Apps Script returned non-JSON. Make sure the URL ends in /exec.`); }

  if (json.error) throw new Error(`Apps Script error: "${json.message || "unknown"}". Run testGetData() in the editor.`);
  if (!Array.isArray(json.settings) || !Array.isArray(json.transactions))
    throw new Error(`Apps Script response malformed -- missing "settings" or "transactions" arrays.`);
  if (json.settings.length === 0)
    throw new Error(`Apps Script returned an empty Settings sheet. Check TAB_SETTINGS in CODE.gs.`);

  console.log(`[MoneyMap] Loaded from Google Sheets -- ${json.transactions.length} rows (${json.fetchedAt})`);
  return { settingsRows: json.settings, txRows: json.transactions, source: "google-sheets" };
}


async function loadFromCSV() {
  if (window.location.protocol === "file:") {
    throw new Error(
      `Opened via file:// -- browsers block fetch() in this mode. ` +
      `Run a local server: open a terminal in this folder and run  npx serve .  ` +
      `then open http://localhost:3000`
    );
  }

  const fetchCSV = async (url, label) => {
    let res;
    try { res = await fetch(url); }
    catch { throw new Error(`Could not reach ${label}. Check your connection.`); }
    if (res.status === 404) throw new Error(
      `${label} not found (404). Make sure "${url}" is deployed alongside index.html.`);
    if (!res.ok) throw new Error(`${label} returned HTTP ${res.status}.`);
    return res.text();
  };

  const [sRaw, tRaw] = await Promise.all([
    fetchCSV(SETTINGS_CSV_URL,     "Settings CSV"),
    fetchCSV(TRANSACTIONS_CSV_URL, "Transactions CSV"),
  ]);

  console.log("[MoneyMap] Loaded from local CSV files");
  return { settingsRows: CSV.parse(sRaw), txRows: CSV.parse(tRaw), source: "local-csv" };
}


async function loadData() {
  const hasScriptUrl = APPS_SCRIPT_URL && APPS_SCRIPT_URL.startsWith("https://");
  const raw = hasScriptUrl ? await loadFromAppsScript() : await loadFromCSV();

  const settings  = loadSettings(raw.settingsRows);
  const allTxs    = loadTransactions(raw.txRows);
  const windowTxs = getWindowTxs(allTxs, settings);
  const riskData  = deriveRisk(allTxs, windowTxs, settings);
  const chartPts  = buildChartPoints(allTxs, settings);

  return { settings, allTxs, windowTxs, riskData, chartPts, source: raw.source };
}


/* ══════════════════════════════════════════════════════════════
   11. BOOTSTRAP
══════════════════════════════════════════════════════════════ */
async function init() {
  try {
    const { settings, windowTxs, riskData, chartPts, source } = await loadData();

    const now         = new Date();
    const sourceLabel = source === "google-sheets" ? "Google Sheets" : "Local CSV";
    setText("last-updated",
      now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + " \u00B7 " + sourceLabel
    );
    setText("footer-date",
      "Money Map \u00B7 " +
      now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    );

    renderHero(settings, riskData);        // §1
    renderDoorDash(settings);              // §2
    renderFlowGrid(windowTxs, settings);   // §3
    renderRunwayChart(chartPts, settings); // §4
    render7Day(windowTxs, settings);       // §5
    render14Day(windowTxs, settings);      // §6

    window.__moneyMap = { settings, windowTxs, riskData, chartPts };
    console.log("[MoneyMap] Ready");

  } catch (err) {
    renderError(err);
  }
}

document.addEventListener("DOMContentLoaded", init);
