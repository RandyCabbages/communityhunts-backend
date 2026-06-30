// Got-In workbook builder. Turns a flat got-in log ([{ts, slot, bet}], newest first) into a
// multi-tab .xlsx: an Overview tab (one row per day) followed by one tab per day (Time/Slot/Bet).
// Day boundaries are computed in a caller-supplied IANA timezone (default America/Chicago) so a
// late-night stream lands on the right day. Used by the admin xlsx route + the daily local script.

const ExcelJS = require('exceljs');

// Break a millisecond timestamp into local-date + local-time strings for the given timezone.
// en-CA gives an ISO-ish YYYY-MM-DD date; hour '24' (some platforms emit it at midnight) → '00'.
function partsInTz(ts, tz) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const p = dtf.formatToParts(new Date(ts)).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  const hour = p.hour === '24' ? '00' : p.hour;
  return { ymd: `${p.year}-${p.month}-${p.day}`, hms: `${hour}:${p.minute}:${p.second}` };
}
function ymdInTz(ts, tz) { return partsInTz(ts, tz).ymd; }

const MONEY = '$#,##0.00';
function styleHeader(row) {
  row.font = { bold: true };
  row.eachCell(c => { c.border = { bottom: { style: 'thin', color: { argb: 'FFBBBBBB' } } }; });
}

// Build the workbook and return a Node Buffer. rows: [{ts, slot, bet}] newest-first.
async function buildGotInWorkbook(rows, { tz = 'America/Chicago', tenantName = 'Bean' } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CommunityHunts';
  wb.created = new Date();

  // Group rows by local day, preserving newest-first order of both days and rows-within-day.
  const days = new Map(); // ymd -> [{ts, slot, bet, hms}]
  for (const r of rows) {
    const { ymd, hms } = partsInTz(r.ts, tz);
    if (!days.has(ymd)) days.set(ymd, []);
    days.get(ymd).push({ ...r, hms });
  }

  // ── Overview tab ──
  const ov = wb.addWorksheet('Overview', { views: [{ state: 'frozen', ySplit: 4 }] });
  ov.getColumn(1).width = 16; ov.getColumn(2).width = 12;
  ov.getColumn(3).width = 14; ov.getColumn(4).width = 14;
  ov.addRow([`${tenantName} — Got-In Log`]).font = { bold: true, size: 14 };
  ov.addRow([`Generated ${partsInTz(Date.now(), tz).ymd} ${partsInTz(Date.now(), tz).hms} (${tz})`])
    .font = { italic: true, color: { argb: 'FF888888' } };
  ov.addRow([]);
  styleHeader(ov.addRow(['Date', 'Got-Ins', 'Total Bet', 'Unique Slots']));

  let grandCount = 0, grandBet = 0;
  for (const [ymd, list] of days) {
    const totalBet = list.reduce((s, r) => s + (Number(r.bet) || 0), 0);
    const unique = new Set(list.map(r => r.slot.toLowerCase())).size;
    grandCount += list.length; grandBet += totalBet;
    const row = ov.addRow([ymd, list.length, totalBet, unique]);
    row.getCell(3).numFmt = MONEY;
  }
  if (days.size === 0) ov.addRow(['No got-ins recorded yet.']);
  else {
    const total = ov.addRow(['TOTAL', grandCount, grandBet, '']);
    total.font = { bold: true };
    total.getCell(3).numFmt = MONEY;
    total.eachCell(c => { c.border = { top: { style: 'thin', color: { argb: 'FFBBBBBB' } } }; });
  }

  // ── One tab per day (newest first) ──
  for (const [ymd, list] of days) {
    const ws = wb.addWorksheet(ymd, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.getColumn(1).width = 12; ws.getColumn(2).width = 34; ws.getColumn(3).width = 12;
    styleHeader(ws.addRow(['Time', 'Slot', 'Bet']));
    for (const r of list) {
      const row = ws.addRow([r.hms, r.slot, Number(r.bet) || 0]);
      row.getCell(3).numFmt = MONEY;
    }
  }

  return wb.xlsx.writeBuffer();
}

module.exports = { buildGotInWorkbook, ymdInTz };
