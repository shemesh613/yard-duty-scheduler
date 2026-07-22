// סוכן 4 — שכבת הייצוא. מייצר קובץ אקסל (xlsx) ותצוגת HTML עברית RTL.
// בעלות בלעדית על קובץ זה. עומד בחתימות שב-SPEC.md:
//   module.exports.buildWorkbook(model, yardPlan, dutyPlan) -> Buffer
//   module.exports.buildHtml(model, yardPlan, dutyPlan)     -> string
//
// עמיד: אם yardPlan/dutyPlan ריקים או חסרי שדות — לא קורס, מציג "אין נתונים".
// אינו מקודד שמות/ימים קשיח — נגזר מ-model.meta ומהתוכניות עצמן.

const XLSX = require('xlsx');

const HOMEROOM_MARK = '★';
const NO_DATA = 'אין נתונים';

/* ----------------------------- עזרי בטיחות ----------------------------- */

function asObj(x) { return x && typeof x === 'object' ? x : {}; }
function asArr(x) { return Array.isArray(x) ? x : []; }
function str(x) { return x == null ? '' : String(x); }

// אוסף את רשימת הימים: עדיפות ל-model.meta.days, אחרת נגזר מהתוכניות.
function collectDays(model, yardPlan, dutyPlan) {
  const meta = asObj(asObj(model).meta);
  if (Array.isArray(meta.days) && meta.days.length) return meta.days.slice();
  const set = new Set();
  asArr(asObj(yardPlan).slots).forEach(s => s && s.day && set.add(s.day));
  asArr(asObj(dutyPlan).assignments).forEach(a => a && a.day && set.add(a.day));
  return [...set];
}

// חלון התורנות מתוך slot/assignment: שדה break, או "אחרי <period>", או '—'.
function breakLabel(x) {
  if (!x) return '—';
  if (x.break != null && x.break !== '') return str(x.break);
  if (x.period != null && x.period !== '') return 'אחרי ' + str(x.period);
  return '—';
}

// חלון מגרש: עדיפות ל-break, אחרת לפי period.
function windowLabel(slot) {
  if (!slot) return '—';
  if (slot.break != null && slot.break !== '') return str(slot.break);
  if (slot.period != null && slot.period !== '') return 'חלון ' + str(slot.period);
  return '—';
}

// מפת teacherId -> name מתוך המודל (גיבוי לשם שמגיע בתוך השיבוץ).
function teacherIndex(model) {
  const idx = {};
  asArr(asObj(model).teachers).forEach(t => {
    if (t && t.id != null) idx[t.id] = t;
  });
  return idx;
}

/* ------------------------- בניית מבני הלוחות ------------------------- */

// לוח תורנויות: שורות=חלון/הפסקה, עמודות=ימים, בכל תא רשימת שיבוצים (שם + אזור).
function buildDutyGrid(days, dutyPlan) {
  const assignments = asArr(asObj(dutyPlan).assignments);
  const breaksOrder = [];        // שמירת סדר הופעה
  const seenBreak = new Set();
  const cells = {};              // cells[brk][day] = [{name, area, role}]

  for (const a of assignments) {
    if (!a) continue;
    const brk = breakLabel(a);
    const day = str(a.day) || '—';
    if (!seenBreak.has(brk)) { seenBreak.add(brk); breaksOrder.push(brk); }
    cells[brk] = cells[brk] || {};
    cells[brk][day] = cells[brk][day] || [];
    cells[brk][day].push({
      name: str(a.teacherName) || str(a.teacherId) || '?',
      area: str(a.area),
      role: str(a.role),
    });
  }
  return { breaks: breaksOrder, cells };
}

// לוח מגרש: שורות=חלון, עמודות=ימים, בכל תא רשימת כיתות + נוכחות מחנך.
function buildYardGrid(days, yardPlan) {
  const slots = asArr(asObj(yardPlan).slots);
  const windowsOrder = [];
  const seenWin = new Set();
  const cells = {};             // cells[win][day] = [{classId, area, homeroomPresent}]

  for (const s of slots) {
    if (!s) continue;
    const win = windowLabel(s);
    const day = str(s.day) || '—';
    if (!seenWin.has(win)) { seenWin.add(win); windowsOrder.push(win); }
    cells[win] = cells[win] || {};
    cells[win][day] = cells[win][day] || [];
    cells[win][day].push({
      classId: str(s.classId),
      area: str(s.area),
      homeroomPresent: !!s.homeroomPresent,
    });
  }
  return { windows: windowsOrder, cells };
}

// שורות בקרה פר-מורה.
function buildControlRows(model, dutyPlan) {
  const tIdx = teacherIndex(model);
  const perTeacher = asObj(asObj(dutyPlan).perTeacher);
  const rows = [];
  const teachers = asArr(asObj(model).teachers);

  // נעדיף ללכת לפי רשימת המורים במודל כדי לכלול גם מי שלא שובץ.
  const ids = new Set();
  teachers.forEach(t => t && t.id != null && ids.add(str(t.id)));
  Object.keys(perTeacher).forEach(id => ids.add(str(id)));

  for (const id of ids) {
    const t = tIdx[id] || {};
    const pt = asObj(perTeacher[id]);
    const yard = Number(pt.yard) || 0;
    const building = Number(pt.building) || 0;
    const total = pt.total != null ? (Number(pt.total) || 0) : (yard + building);
    rows.push({
      id,
      name: str(t.name) || id,
      type: str(t.type) || '—',
      numDays: t.numDaysWorked != null ? t.numDaysWorked : (Array.isArray(t.daysWorked) ? t.daysWorked.length : '—'),
      yard,
      building,
      total,
      quotaOk: pt.quotaOk === true ? true : (pt.quotaOk === false ? false : null),
    });
  }
  // מיון לפי שם לנוחות.
  rows.sort((a, b) => str(a.name).localeCompare(str(b.name), 'he'));
  return rows;
}

/* ------------------------------- אקסל ------------------------------- */

function dutyCellText(list) {
  if (!list || !list.length) return '';
  return list.map(x => x.area ? `${x.name} (${x.area})` : x.name).join('\n');
}

function yardCellText(list) {
  if (!list || !list.length) return '';
  return list.map(x => {
    const mark = x.homeroomPresent ? ' ' + HOMEROOM_MARK : '';
    const cls = x.classId || '?';
    return x.area ? `${cls}${mark} [${x.area}]` : `${cls}${mark}`;
  }).join('\n');
}

function sheetFromAoa(aoa) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  // רוחב עמודות בסיסי
  const ncols = aoa.reduce((m, r) => Math.max(m, r.length), 0);
  ws['!cols'] = Array.from({ length: ncols }, (_, i) => ({ wch: i === 0 ? 16 : 22 }));
  return ws;
}

function buildWorkbook(model, yardPlan, dutyPlan) {
  const wb = XLSX.utils.book_new();
  const days = collectDays(model, yardPlan, dutyPlan);

  /* גיליון 1 — לוח תורנויות */
  {
    const grid = buildDutyGrid(days, dutyPlan);
    const aoa = [];
    aoa.push(['הפסקה \\ יום', ...days]);
    if (!grid.breaks.length) {
      aoa.push([NO_DATA, ...days.map(() => '')]);
    } else {
      for (const brk of grid.breaks) {
        const row = [brk];
        for (const day of days) {
          row.push(dutyCellText(asObj(grid.cells[brk])[day]));
        }
        aoa.push(row);
      }
    }
    XLSX.utils.book_append_sheet(wb, sheetFromAoa(aoa), 'לוח תורנויות');
  }

  /* גיליון 2 — לוח מגרש */
  {
    const grid = buildYardGrid(days, yardPlan);
    const aoa = [];
    aoa.push(['חלון \\ יום', ...days]);
    if (!grid.windows.length) {
      aoa.push([NO_DATA, ...days.map(() => '')]);
    } else {
      for (const win of grid.windows) {
        const row = [win];
        for (const day of days) {
          row.push(yardCellText(asObj(grid.cells[win])[day]));
        }
        aoa.push(row);
      }
    }
    XLSX.utils.book_append_sheet(wb, sheetFromAoa(aoa), 'לוח מגרש');
  }

  /* גיליון 3 — בקרה */
  {
    const rows = buildControlRows(model, dutyPlan);
    const aoa = [];
    aoa.push(['שם', 'סוג', 'מס׳ ימים', 'תורנויות חצר', 'מבנה', 'סה״כ', 'מכסה תקינה?']);
    if (!rows.length) {
      aoa.push([NO_DATA, '', '', '', '', '', '']);
    } else {
      for (const r of rows) {
        aoa.push([
          r.name, r.type, r.numDays, r.yard, r.building, r.total,
          r.quotaOk === null ? '—' : (r.quotaOk ? 'כן' : 'לא'),
        ]);
      }
    }

    // הפרות
    aoa.push([]);
    aoa.push(['הפרות (violations):']);
    const violations = asArr(asObj(dutyPlan).violations);
    if (!violations.length) aoa.push(['אין הפרות']);
    else violations.forEach(v => aoa.push([str(v)]));

    // אזהרות מגרש
    aoa.push([]);
    aoa.push(['אזהרות לוח מגרש (warnings):']);
    const warnings = asArr(asObj(yardPlan).warnings);
    if (!warnings.length) aoa.push(['אין אזהרות']);
    else warnings.forEach(w => aoa.push([str(w)]));

    XLSX.utils.book_append_sheet(wb, sheetFromAoa(aoa), 'בקרה');
  }

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/* ------------------------------- HTML ------------------------------- */

function esc(s) {
  return str(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// סיווג אזור לצבע: בנים / בנות / אחר.
function areaClass(area) {
  const a = str(area);
  if (a.indexOf('בנות') !== -1) return 'girls';
  if (a.indexOf('בנים') !== -1) return 'boys';
  return 'neutral';
}

function dutyCellHtml(list) {
  if (!list || !list.length) return '<span class="empty">—</span>';
  return list.map(x => {
    const cls = areaClass(x.area);
    const areaTag = x.area ? `<span class="area ${cls}">${esc(x.area)}</span>` : '';
    return `<div class="chip ${cls}">${esc(x.name)}${areaTag}</div>`;
  }).join('');
}

function yardCellHtml(list) {
  if (!list || !list.length) return '<span class="empty">—</span>';
  return list.map(x => {
    const cls = areaClass(x.area);
    const mark = x.homeroomPresent ? `<span class="star" title="מחנך נוכח">${HOMEROOM_MARK}</span>` : '';
    const areaTag = x.area ? `<span class="area ${cls}">${esc(x.area)}</span>` : '';
    return `<div class="chip ${cls}${x.homeroomPresent ? ' present' : ''}">${esc(x.classId || '?')}${mark}${areaTag}</div>`;
  }).join('');
}

function renderGridTable(days, rowKeys, cornerLabel, cellsByRow, cellRenderer, emptyMsg) {
  if (!rowKeys.length) {
    return `<p class="no-data">${esc(emptyMsg || NO_DATA)}</p>`;
  }
  let html = '<div class="table-wrap"><table class="grid">';
  html += '<thead><tr><th class="corner">' + esc(cornerLabel) + '</th>';
  for (const d of days) html += '<th>' + esc(d) + '</th>';
  html += '</tr></thead><tbody>';
  for (const rk of rowKeys) {
    html += '<tr><th class="rowhead">' + esc(rk) + '</th>';
    const rowCells = asObj(cellsByRow[rk]);
    for (const d of days) {
      html += '<td>' + cellRenderer(rowCells[d]) + '</td>';
    }
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  return html;
}

function renderControlTable(rows) {
  if (!rows.length) return `<p class="no-data">${NO_DATA}</p>`;
  let html = '<div class="table-wrap"><table class="control">';
  html += '<thead><tr>'
    + '<th>שם</th><th>סוג</th><th>מס׳ ימים</th><th>חצר</th><th>מבנה</th><th>סה״כ</th><th>מכסה תקינה</th>'
    + '</tr></thead><tbody>';
  for (const r of rows) {
    const okCell = r.quotaOk === null
      ? '<span class="badge neutral-badge">—</span>'
      : (r.quotaOk
        ? '<span class="badge ok">תקין</span>'
        : '<span class="badge bad">חריגה</span>');
    const trCls = r.quotaOk === false ? ' class="row-bad"' : '';
    html += `<tr${trCls}>`
      + `<td class="name">${esc(r.name)}</td>`
      + `<td>${esc(r.type)}</td>`
      + `<td class="num">${esc(r.numDays)}</td>`
      + `<td class="num">${esc(r.yard)}</td>`
      + `<td class="num">${esc(r.building)}</td>`
      + `<td class="num total">${esc(r.total)}</td>`
      + `<td>${okCell}</td>`
      + '</tr>';
  }
  html += '</tbody></table></div>';
  return html;
}

function renderList(title, items, cls, emptyMsg) {
  let html = `<div class="issues ${cls || ''}"><h3>${esc(title)}</h3>`;
  if (!items.length) {
    html += `<p class="none">${esc(emptyMsg || 'אין')}</p>`;
  } else {
    html += '<ul>' + items.map(i => '<li>' + esc(i) + '</li>').join('') + '</ul>';
  }
  html += '</div>';
  return html;
}

function buildHtml(model, yardPlan, dutyPlan) {
  const days = collectDays(model, yardPlan, dutyPlan);
  const meta = asObj(asObj(model).meta);
  const school = esc(str(meta.school) || 'מערכת שיבוץ תורנויות חצר ולוח מגרש');

  const dutyGrid = buildDutyGrid(days, dutyPlan);
  const yardGrid = buildYardGrid(days, yardPlan);
  const controlRows = buildControlRows(model, dutyPlan);
  const violations = asArr(asObj(dutyPlan).violations).map(str);
  const warnings = asArr(asObj(yardPlan).warnings).map(str);

  const hasViolations = violations.length > 0;

  const css = `
    :root{
      --bg:#f4f6fb; --card:#ffffff; --ink:#1f2733; --muted:#6b7686;
      --line:#e1e6ef; --accent:#2f5dd6;
      --boys:#1565c0; --boys-bg:#e3f0fc;
      --girls:#ad1457; --girls-bg:#fce4ee;
      --neutral:#455a64; --neutral-bg:#eceff1;
      --bad:#c62828; --bad-bg:#fdecea; --ok:#2e7d32; --ok-bg:#e8f5e9;
      --star:#e6a100;
    }
    *{box-sizing:border-box;}
    html{ -webkit-print-color-adjust:exact; print-color-adjust:exact; }
    body{
      margin:0; padding:24px; background:var(--bg); color:var(--ink);
      font-family:"Segoe UI","Arial Hebrew",Arial,system-ui,-apple-system,sans-serif;
      line-height:1.4;
    }
    header.page-head{ margin-bottom:20px; }
    header.page-head h1{ margin:0 0 4px; font-size:24px; }
    header.page-head .sub{ color:var(--muted); font-size:13px; }
    section.card{
      background:var(--card); border:1px solid var(--line); border-radius:12px;
      padding:16px 18px; margin-bottom:22px; box-shadow:0 1px 3px rgba(20,30,60,.05);
    }
    section.card > h2{ margin:0 0 12px; font-size:18px; color:var(--accent);
      border-inline-start:4px solid var(--accent); padding-inline-start:10px; }
    .table-wrap{ overflow-x:auto; }
    table{ border-collapse:collapse; width:100%; font-size:13px; }
    table.grid th, table.grid td{
      border:1px solid var(--line); padding:6px 8px; vertical-align:top;
      text-align:center; min-width:90px;
    }
    table.grid thead th{ background:#eef2fb; font-weight:600; }
    table.grid th.corner{ background:#dde6fa; }
    table.grid th.rowhead{ background:#f3f6fc; white-space:nowrap; font-weight:600; }
    .chip{
      display:inline-block; margin:2px; padding:2px 7px; border-radius:7px;
      font-size:12px; line-height:1.5; border:1px solid transparent;
    }
    .chip.boys{ background:var(--boys-bg); color:var(--boys); border-color:#bcdcfa; }
    .chip.girls{ background:var(--girls-bg); color:var(--girls); border-color:#f6c5da; }
    .chip.neutral{ background:var(--neutral-bg); color:var(--neutral); border-color:#d7dde0; }
    .chip.present{ outline:2px solid var(--star); }
    .chip .area{ display:block; font-size:10px; opacity:.8; margin-top:1px; }
    .star{ color:var(--star); font-weight:700; margin-inline-start:3px; }
    .empty{ color:#b9c2cf; }
    .no-data{ color:var(--muted); font-style:italic; padding:8px; }
    /* בקרה */
    table.control th, table.control td{
      border:1px solid var(--line); padding:6px 10px; text-align:center;
    }
    table.control thead th{ background:#eef2fb; }
    table.control td.name{ text-align:start; font-weight:600; }
    table.control td.num{ font-variant-numeric:tabular-nums; }
    table.control td.total{ font-weight:700; }
    table.control tr.row-bad{ background:var(--bad-bg); }
    .badge{ display:inline-block; padding:2px 9px; border-radius:20px; font-size:12px; font-weight:600; }
    .badge.ok{ background:var(--ok-bg); color:var(--ok); }
    .badge.bad{ background:var(--bad-bg); color:var(--bad); }
    .badge.neutral-badge{ background:var(--neutral-bg); color:var(--neutral); }
    /* בלוקי הפרות / אזהרות */
    .issues{ border-radius:10px; padding:12px 16px; margin-top:8px; }
    .issues h3{ margin:0 0 8px; font-size:15px; }
    .issues ul{ margin:0; padding-inline-start:20px; }
    .issues li{ margin:3px 0; }
    .issues .none{ margin:0; color:var(--muted); }
    .issues.violations{ background:var(--bad-bg); border:1px solid #f3b9b2; }
    .issues.violations h3{ color:var(--bad); }
    .issues.warnings{ background:#fff8e1; border:1px solid #f3e1a0; }
    .issues.warnings h3{ color:#a06b00; }
    .legend{ font-size:12px; color:var(--muted); margin-top:10px; }
    .legend .chip{ cursor:default; }
    @media print{
      body{ background:#fff; padding:0; }
      section.card{ box-shadow:none; break-inside:avoid; }
    }
  `;

  let body = '';
  body += `<header class="page-head"><h1>${school}</h1>`
    + `<div class="sub">לוחות שיבוץ — תורנויות חצר, לוח מגרש ובקרה`
    + (meta.sourceFile ? ` · מקור: ${esc(meta.sourceFile)}` : '')
    + `</div></header>`;

  // בלוק הפרות בולט בראש אם יש
  if (hasViolations) {
    body += '<section class="card">'
      + renderList('הפרות שיבוץ (' + violations.length + ')', violations, 'violations', 'אין הפרות')
      + '</section>';
  }

  // לוח תורנויות
  body += '<section class="card"><h2>לוח תורנויות</h2>'
    + renderGridTable(days, dutyGrid.breaks, 'הפסקה / יום', dutyGrid.cells, dutyCellHtml, NO_DATA)
    + '<div class="legend">'
    + '<span class="chip boys">חצר/מבנה בנים</span> '
    + '<span class="chip girls">חצר/מבנה בנות</span></div>'
    + '</section>';

  // לוח מגרש
  body += '<section class="card"><h2>לוח מגרש</h2>'
    + renderGridTable(days, yardGrid.windows, 'חלון / יום', yardGrid.cells, yardCellHtml, NO_DATA)
    + `<div class="legend"><span class="star">${HOMEROOM_MARK}</span> = המחנך נוכח בחלון (תא מודגש)</div>`
    + '</section>';

  // בקרה
  body += '<section class="card"><h2>בקרה</h2>'
    + renderControlTable(controlRows)
    + renderList('הפרות (violations)', violations, 'violations', 'אין הפרות')
    + renderList('אזהרות לוח מגרש (warnings)', warnings, 'warnings', 'אין אזהרות')
    + '</section>';

  return `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${school}</title>
<style>${css}</style>
</head>
<body>
${body}
</body>
</html>`;
}

module.exports = { buildWorkbook, buildHtml };
