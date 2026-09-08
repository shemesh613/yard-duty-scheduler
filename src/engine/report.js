// סוכן 4 — שכבת הייצוא. מייצר קובץ אקסל (xlsx) ותצוגת HTML עברית RTL.
// בעלות בלעדית על קובץ זה. עומד בחתימות שב-SPEC.md:
//   module.exports.buildWorkbook(model, _unused, dutyPlan) -> Buffer
//   module.exports.buildHtml(model, _unused, dutyPlan)     -> string
//
// עמיד: אם dutyPlan ריק או חסר שדות — לא קורס, מציג "אין נתונים".
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

const DAY_FULL = {
  'יום א': 'יום ראשון', 'יום ב': 'יום שני', 'יום ג': 'יום שלישי',
  'יום ד': 'יום רביעי', 'יום ה': 'יום חמישי', 'יום ו': 'יום שישי',
};
// שמות ההפסקות כפי שנהוג בבית הספר.
const BREAK_FULL = { 'אחרי 2': 'הפסקת 10', 'אחרי 4': 'הפסקת 12', 'אחרי 6': 'הפסקת צהריים' };

function breakDisplay(b) { return BREAK_FULL[b] || b; }

// שם לתצוגה בלוח שמופץ לצוות: בלי סימוני המקרא ובלי קידומות פנימיות.
// "תת אברג'ל רות" -> "אברג'ל רות" · "ת- טמוזרטי ורד (ה)" -> "טמוזרטי ורד"
function displayName(name) {
  return str(name)
    .replace(/\((?:ל|ה|ת)\)/g, '')
    .replace(/^תת[\s-]+/, '')
    .replace(/^ת-\s*/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
function dayDisplay(d) { return DAY_FULL[d] || d; }

// המתחם (בנים/בנות) של כל גיזרה, לפי מגדר רוב הכיתות הסמוכות לה.
function zoneGenders(model) {
  let zones;
  try {
    zones = JSON.parse(require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', 'config', 'zones.json'), 'utf8'));
  } catch (e) { return null; }
  if (!zones || !zones.zonesByClass) return null;

  const genderOfClass = {};
  for (const c of asArr(asObj(model).classes)) {
    if (c && c.id && c.gender) genderOfClass[c.id] = c.gender;
  }
  const tally = {};
  for (const [cls, list] of Object.entries(zones.zonesByClass)) {
    const g = genderOfClass[cls];
    if (!g) continue;
    for (const z of list || []) {
      const acc = tally[z] || (tally[z] = { 'בנים': 0, 'בנות': 0 });
      acc[g]++;
    }
  }
  const out = {};
  for (const z of zones.zones || []) {
    const acc = tally[z];
    out[z] = acc ? (acc['בנים'] > acc['בנות'] ? 'בנים' : 'בנות') : null;
  }
  return out;
}

// סדר ימי השבוע, ללא תלות בסדר שבו הופיעו בקובץ.
const DAY_ORDER = ['יום א', 'יום ב', 'יום ג', 'יום ד', 'יום ה', 'יום ו', 'שבת'];
function sortDays(days) {
  return days.slice().sort((a, b) => {
    const i = DAY_ORDER.indexOf(a), j = DAY_ORDER.indexOf(b);
    return (i === -1 ? 99 : i) - (j === -1 ? 99 : j);
  });
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

// סדר תצוגה של תפקידי התורנות.
const ROLE_ORDER = ['תחילת יום', 'חצר', 'מבנה', 'דינמיקלאס', 'סייר', 'מ"מ', 'סוף יום'];

// כל השיבוצים כרשומות שטוחות, ממוינות לפי יום ואז הפסקה ואז תפקיד.
function flatAssignments(model, dutyPlan) {
  const days = sortDays(collectDays(model, null, dutyPlan));
  const dayRank = (d) => { const i = days.indexOf(d); return i === -1 ? 99 : i; };
  const brkRank = (b) => {
    if (b === 'תחילת יום') return -1;
    if (b === 'סוף יום') return 999;
    const m = /(\d+)/.exec(b);
    return m ? parseInt(m[1], 10) : 500;
  };
  const roleRank = (r) => {
    const i = ROLE_ORDER.indexOf(r);
    return i === -1 ? 50 : i;
  };

  return asArr(asObj(dutyPlan).assignments)
    .filter(Boolean)
    .map((a) => ({
      day: str(a.day),
      brk: breakLabel(a),
      role: str(a.role),
      area: str(a.area),
      name: displayName(a.teacherName || a.teacherId),
    }))
    .sort((x, y) =>
      dayRank(x.day) - dayRank(y.day)
      || brkRank(x.brk) - brkRank(y.brk)
      || roleRank(x.role) - roleRank(y.role)
      || str(x.name).localeCompare(str(y.name), 'he'));
}

function sheetWithWidths(aoa, widths) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = widths.map((w) => ({ wch: w }));
  if (aoa.length > 1) ws['!autofilter'] = { ref: XLSX.utils.encode_range({
    s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: aoa[0].length - 1 } }) };
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  return ws;
}

function buildWorkbook(model, yardPlan, dutyPlan) {
  const wb = XLSX.utils.book_new();
  const days = sortDays(collectDays(model, null, dutyPlan));
  const flat = flatAssignments(model, dutyPlan);
  const zg = zoneGenders(model) || {};

  /* גיליון 1 — לפי ימים: שורה לכל תורנות, ניתן למיון וסינון */
  {
    const aoa = [['יום', 'הפסקה', 'תפקיד', 'גיזרה', 'מתחם', 'תורן']];
    for (const a of flat) {
      aoa.push([
        dayDisplay(a.day),
        breakDisplay(a.brk),
        a.role,
        a.area || '—',
        a.area ? (zg[a.area] || '—') : '—',
        a.name,
      ]);
    }
    if (flat.length === 0) aoa.push([NO_DATA, '', '', '', '', '']);
    XLSX.utils.book_append_sheet(wb, sheetWithWidths(aoa, [12, 14, 12, 30, 16, 26]), 'לפי ימים');
  }

  /* גיליון 2 — לפי מורים: אותן רשומות, ממוינות לפי שם */
  {
    const byName = flat.slice().sort((x, y) =>
      str(x.name).localeCompare(str(y.name), 'he')
      || days.indexOf(x.day) - days.indexOf(y.day));
    const aoa = [['תורן', 'יום', 'הפסקה', 'תפקיד', 'גיזרה']];
    for (const a of byName) {
      aoa.push([a.name, dayDisplay(a.day), breakDisplay(a.brk), a.role, a.area || '—']);
    }
    if (!byName.length) aoa.push([NO_DATA, '', '', '', '']);
    XLSX.utils.book_append_sheet(wb, sheetWithWidths(aoa, [26, 12, 14, 12, 30]), 'לפי מורים');
  }

  /* גיליון 3 — לוח שבועי: אותו מבנה כמו הלוח שמופץ לצוות */
  {
    const regular = [...new Set(flat.map((a) => a.brk))]
      .filter((b) => b !== 'תחילת יום' && b !== 'סוף יום')
      .sort((a, b) => {
        const n = (x) => { const m = /(\d+)/.exec(x); return m ? +m[1] : 99; };
        return n(a) - n(b);
      });
    const pick = (day, brk, fn) => flat
      .filter((a) => a.day === day && a.brk === brk && fn(a))
      .map((a) => a.name).join(String.fromCharCode(10));

    const aoa = [['', 'גיזרות', ...days.map(dayDisplay)]];
    aoa.push(['תחילת יום', '', ...days.map((d) => pick(d, 'תחילת יום', () => true))]);

    for (const brk of regular) {
      const label = breakDisplay(brk);
      for (const gender of ['בנות', 'בנים']) {
        const zones = Object.keys(zg).filter((z) => zg[z] === gender);
        aoa.push([
          label + ' ' + gender,
          zones.join(String.fromCharCode(10)),
          ...days.map((d) => pick(d, brk, (a) => a.area && zg[a.area] === gender)),
        ]);
      }
      const dyn = days.map((d) => pick(d, brk, (a) => a.role === 'דינמיקלאס'));
      if (dyn.some(Boolean)) aoa.push(['דינמיקלאס', '', ...dyn]);
      aoa.push(['מ"מ תורנות', '', ...days.map((d) => pick(d, brk, (a) => a.role === 'מ"מ'))]);
      aoa.push(['סיירת (' + label.replace('הפסקת ', '') + ')', '',
        ...days.map((d) => pick(d, brk, (a) => a.role === 'סייר'))]);
    }
    aoa.push(['סיום יום', '', ...days.map((d) => pick(d, 'סוף יום', () => true))]);

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 18 }, { wch: 26 }, ...days.map(() => ({ wch: 24 }))];
    XLSX.utils.book_append_sheet(wb, ws, 'לוח שבועי');
  }

  /* גיליון 4 — בקרה */
  {
    const rows = buildControlRows(model, dutyPlan);
    const aoa = [['שם', 'סוג', 'מס׳ ימים', 'תורנויות חצר', 'מבנה', 'סה״כ', 'מכסה תקינה?']];
    if (!rows.length) {
      aoa.push([NO_DATA, '', '', '', '', '', '']);
    } else {
      for (const r of rows) {
        aoa.push([
          displayName(r.name), r.type, r.numDays, r.yard, r.building, r.total,
          r.quotaOk === null ? '—' : (r.quotaOk ? 'כן' : 'לא'),
        ]);
      }
    }

    aoa.push([]);
    aoa.push(['הפרות:']);
    const violations = asArr(asObj(dutyPlan).violations);
    if (!violations.length) aoa.push(['אין הפרות']);
    else violations.forEach((v) => aoa.push([str(v)]));

    XLSX.utils.book_append_sheet(wb, sheetWithWidths(aoa, [26, 20, 10, 14, 10, 10, 14]), 'בקרה');
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
  const school = esc(str(meta.school) || 'מערכת שיבוץ תורנויות');

  const dutyGrid = buildDutyGrid(days, dutyPlan);
  const controlRows = buildControlRows(model, dutyPlan);
  const violations = asArr(asObj(dutyPlan).violations).map(str);
  const warnings = [];

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
    + `<div class="sub">לוחות שיבוץ — תורנויות ובקרה`
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

    + '</section>';

  // בקרה
  body += '<section class="card"><h2>בקרה</h2>'
    + renderControlTable(controlRows)
    + renderList('הפרות (violations)', violations, 'violations', 'אין הפרות')
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

/* =====================================================================
   לוח למורים — מסמך נקי להדפסה ולהפצה.
   מכיל רק את מה שמורה צריך: הלוח השבועי, ותורנות אישית לכל אחד.
   בלי הפרות, בלי נתוני מקור, בלי בקרה.
   ===================================================================== */

// סדר הצגה קבוע להפסקות, כך שתחילת יום תמיד ראשונה וסוף יום אחרונה.
function orderBreaks(breaks) {
  const rank = (b) => {
    if (b === 'תחילת יום') return -1;
    if (b === 'סוף יום') return 999;
    const m = /(\d+)/.exec(b);
    return m ? parseInt(m[1], 10) : 500;
  };
  return breaks.slice().sort((a, b) => rank(a) - rank(b));
}

// תורנויות פר מורה, ממוינות לפי יום ואז לפי הפסקה.
function dutiesByTeacher(days, dutyPlan) {
  const out = {};
  for (const a of asArr(asObj(dutyPlan).assignments)) {
    if (!a) continue;
    const name = str(a.teacherName) || str(a.teacherId);
    if (!name) continue;
    (out[name] = out[name] || []).push({
      day: str(a.day),
      brk: breakLabel(a),
      where: str(a.area) || str(a.role),
      role: str(a.role),
    });
  }
  const dayRank = (d) => { const i = days.indexOf(d); return i === -1 ? 99 : i; };
  const brkRank = (b) => {
    if (b === 'תחילת יום') return -1;
    if (b === 'סוף יום') return 999;
    const m = /(\d+)/.exec(b);
    return m ? parseInt(m[1], 10) : 500;
  };
  for (const list of Object.values(out)) {
    list.sort((x, y) => dayRank(x.day) - dayRank(y.day) || brkRank(x.brk) - brkRank(y.brk));
  }
  return out;
}

/* ---- לוח בפורמט הנהוג בבית הספר ----
   שורות: תחילת יום, ואז לכל הפסקה — בנות / בנים / דינמיקלאס / מ"מ / סיירת,
   ולבסוף סיום יום. עמודות: ימי השבוע. */

// מבנה הלוח כנתונים. משמש את דף ההדפסה, את ציור התמונה, ואת צפייה
// בלבד (‎/view ו-‎/api/board) — כך יש מקור אמת אחד לכל התצוגות.
function buildBoardData(model, dutyPlan) {
  const days = sortDays(collectDays(model, null, dutyPlan));
  const assignments = asArr(asObj(dutyPlan).assignments);
  const zg = zoneGenders(model) || {};
  const school = str(asObj(asObj(model).meta).school) || '';

  // רשימת המתחמים לכל מגדר, לפי הסדר שבקובץ המתחמים.
  const zonesOf = (gender) => Object.keys(zg).filter((z) => zg[z] === gender);

  // ההפסקות הרגילות, בסדר כרונולוגי.
  const regular = [...new Set(assignments
    .map((a) => str(a.break))
    .filter((b) => b && b !== 'תחילת יום' && b !== 'סוף יום'))]
    .sort((a, b) => {
      const n = (x) => { const m = /(\d+)/.exec(x); return m ? +m[1] : 99; };
      return n(a) - n(b);
    });

  const pick = (day, brk, fn) => assignments
    .filter((a) => a.day === day && a.break === brk && fn(a))
    .map((a) => str(a.teacherName));

  // מבנה הלוח נבנה פעם אחת כנתונים, ומשמש גם ל-HTML להדפסה וגם לציור
  // התמונה בדפדפן. כך אין שני מקורות אמת שיכולים להיפרד זה מזה.
  const data = [];

  data.push({ kind: 'mgmt', label: 'תחילת יום', zones: [],
    cells: days.map((d) => pick(d, 'תחילת יום', () => true).map(displayName)) });

  for (const brk of regular) {
    const label = breakDisplay(brk);

    for (const gender of ['בנות', 'בנים']) {
      data.push({
        kind: gender === 'בנים' ? 'boys' : 'girls',
        label: label + ' ' + gender,
        zones: zonesOf(gender),
        cells: days.map((d) => pick(d, brk, (a) => a.area && zg[a.area] === gender).map(displayName)),
      });
    }

    // דינמיקלאס — רק בימים ובהפסקות שבהם הוא מתקיים.
    const dyn = days.map((d) => pick(d, brk, (a) => a.role === 'דינמיקלאס').map(displayName));
    if (dyn.some((x) => x.length)) {
      data.push({ kind: 'sub', label: 'דינמיקלאס', zones: [], cells: dyn });
    }

    data.push({ kind: 'sub', label: 'מ"מ תורנות', zones: [],
      cells: days.map((d) => pick(d, brk, (a) => a.role === 'מ"מ').map(displayName)) });

    data.push({ kind: 'sub patrol', label: 'סיירת (' + label.replace('הפסקת ', '') + ')', zones: [],
      cells: days.map((d) => pick(d, brk, (a) => a.role === 'סייר').map(displayName)) });
  }

  data.push({ kind: 'mgmt', label: 'סיום יום', zones: [],
    cells: days.map((d) => pick(d, 'סוף יום', () => true).map(displayName)) });

  return {
    title: 'לוח תורנויות שבועי',
    school: school,
    date: new Date().toLocaleDateString('he-IL'),
    days: days.map(dayDisplay),
    rows: data,
  };
}

function buildBoardHtml(model, dutyPlan) {
  const boardData = buildBoardData(model, dutyPlan);
  const school = boardData.school;
  const today = boardData.date;

  const cell = (names) => names.length
    ? `<td>${names.map((n) => `<span class="nm">${esc(n)}</span>`).join('')}</td>`
    : '<td class="empty"></td>';

  const CLS = { mgmt: 'mgmt', girls: 'duty girls', boys: 'duty boys',
    sub: 'sub-row', 'sub patrol': 'sub-row patrol' };

  const rows = boardData.rows.map((r) =>
    `<tr class="${CLS[r.kind] || ''}"><th class="rh">${esc(r.label)}</th>`
    + `<td class="zones">${r.zones.map((z) => `<span class="zn">${esc(z)}</span>`).join('')}</td>`
    + r.cells.map(cell).join('') + '</tr>');

  const days = boardData.days;

  return `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>לוח תורנויות</title>
<style>
  @page { size: A4 landscape; margin: 8mm; }
  *{ box-sizing:border-box; }
  body{
    margin:0; padding:20px; background:#fff; color:#111;
    font-family:"Segoe UI","Arial Hebrew",Arial,sans-serif; font-size:13px;
  }
  .no-print{
    margin-bottom:16px; padding:11px 13px; background:#eef3fb;
    border:1px solid #c3d4ee; border-radius:8px; font-size:13px; color:#24406e;
    display:flex; align-items:center; gap:10px; flex-wrap:wrap;
  }
  .no-print button{
    font:inherit; font-size:13px; padding:7px 14px; cursor:pointer;
    background:#fff; color:#24406e; border:1px solid #9db6dd; border-radius:7px;
  }
  .no-print button:hover{ background:#dce8f8; }
  .no-print .hint{ color:#5a7099; font-size:12px; }
  header{ margin-bottom:14px; }
  h1{ margin:0 0 3px; font-size:22px; }
  header .sub{ color:#666; font-size:12px; }
  .table-wrap{ overflow-x:auto; }
  table{ border-collapse:collapse; width:100%; }
  th,td{ border:1px solid #999; padding:5px 7px; vertical-align:top; text-align:right; }
  thead th{ background:#3c3c3c; color:#fff; font-size:13px; text-align:center; padding:7px; }
  thead th.corner{ background:#3c3c3c; }
  .rh{ background:#f0f0f0; font-size:12.5px; white-space:nowrap; width:118px; font-weight:600; }
  .zones{ background:#fafafa; width:170px; font-size:10px; color:#555; line-height:1.35; }
  .zn{ display:block; }
  td .nm{ display:block; font-size:11.5px; line-height:1.45; }
  td.empty{ background:#fcfcfc; }
  tr.girls .rh{ background:#fce4ee; color:#8c1149; }
  tr.boys  .rh{ background:#e3f0fc; color:#0d4f8c; }
  tr.mgmt  .rh{ background:#e8eee8; color:#2c4a2c; }
  tr.sub-row .rh{ background:#f7f7f7; color:#555; font-weight:500; font-size:11.5px; }
  tr.sub-row td .nm{ font-size:11px; color:#444; }
  tr.patrol{ border-bottom:2px solid #999; }
  footer{ margin-top:16px; color:#777; font-size:11px; }
  @media print{ body{ padding:0; } .no-print{ display:none; } tr{ page-break-inside:avoid; } }
</style>
</head>
<body>
  <div class="no-print">
    <strong>לשליחה בווטסאפ:</strong>
    <button type="button" id="btnPng">🖼 שמור כתמונה</button>
    <button type="button" id="btnPdf">📄 שמור כ-PDF</button>
    <span class="hint">התמונה נפתחת בווטסאפ בתוך השיחה. ה-PDF נשלח כקובץ מצורף.</span>
  </div>
  <header>
    <h1>לוח תורנויות שבועי</h1>
    <div class="sub">${esc(school)}${school ? ' · ' : ''}הופק ב-${esc(today)}</div>
  </header>
  <div class="table-wrap">
    <table>
      <thead><tr><th class="corner"></th><th class="corner">גיזרות</th>${
        days.map((d) => `<th>${esc(d)}</th>`).join('')}</tr></thead>
      <tbody>${rows.join('\n')}</tbody>
    </table>
  </div>
  <footer>לשאלות ולשינויים — פנו להנהלה.</footer>
<script>
/* ציור הלוח לתמונה. מצויר ידנית על קנבס ולא באמצעות המרת HTML —
   כך התוצאה זהה בכל דפדפן, בלי ספריות חיצוניות ובלי הפתעות בעברית. */
(function () {
  var BOARD = ${JSON.stringify(boardData).replace(/</g, '\u003c')};

  var COL = { mgmt:'#e8eee8', girls:'#fce4ee', boys:'#e3f0fc', sub:'#f7f7f7' };
  var TXT = { mgmt:'#2c4a2c', girls:'#8c1149', boys:'#0d4f8c', sub:'#555555' };
  var kindOf = function (k) { return k.indexOf('patrol') !== -1 ? 'sub' : k; };

  function draw(scale) {
    var W_LABEL = 130, W_ZONES = 180, W_DAY = 150, PAD = 8;
    var HEAD = 34, TITLE = 62, FOOT = 30;
    var LINE = 17, ZLINE = 14;

    var width = W_LABEL + W_ZONES + BOARD.days.length * W_DAY;
    var heights = BOARD.rows.map(function (r) {
      var most = r.cells.reduce(function (m, c) { return Math.max(m, c.length); }, 0);
      var need = Math.max(most * LINE, r.zones.length * ZLINE, LINE);
      return need + PAD * 2;
    });
    var height = TITLE + HEAD + heights.reduce(function (a, b) { return a + b; }, 0) + FOOT;

    var cv = document.createElement('canvas');
    cv.width = width * scale;
    cv.height = height * scale;
    var g = cv.getContext('2d');
    g.scale(scale, scale);
    g.textBaseline = 'top';
    g.direction = 'rtl';
    g.textAlign = 'right';

    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, width, height);

    // טקסט ארוך מוקטן עד שהוא נכנס לעמודה, כדי ששם גיזרה ארוך לא יגלוש
    // אל התא השכן. יורדים עד 7px ולא מעבר, שהכתב יישאר קריא.
    function fitText(txt, x, y, maxW, baseFont) {
      var size = parseFloat(baseFont);
      var rest = baseFont.slice(String(baseFont).indexOf('px'));
      g.font = baseFont;
      while (g.measureText(txt).width > maxW && size > 7) {
        size -= 0.5;
        g.font = baseFont.replace(/[\d.]+px/, size + 'px');
      }
      g.fillText(txt, x, y);
      g.font = baseFont;
      return rest;
    }

    // כותרת
    g.fillStyle = '#111111';
    g.font = 'bold 22px "Segoe UI", Arial, sans-serif';
    g.fillText(BOARD.title, width - 4, 8);
    g.fillStyle = '#666666';
    g.font = '13px "Segoe UI", Arial, sans-serif';
    g.fillText((BOARD.school ? BOARD.school + ' · ' : '') + 'הופק ב-' + BOARD.date, width - 4, 36);

    var xOf = function (col) {       // col 0 = תווית, 1 = גיזרות, 2.. = ימים
      if (col === 0) return width - W_LABEL;
      if (col === 1) return width - W_LABEL - W_ZONES;
      return width - W_LABEL - W_ZONES - (col - 1) * W_DAY;
    };
    var wOf = function (col) { return col === 0 ? W_LABEL : col === 1 ? W_ZONES : W_DAY; };

    function box(x, y, w, h, fill) {
      if (fill) { g.fillStyle = fill; g.fillRect(x, y, w, h); }
      g.strokeStyle = '#999999';
      g.lineWidth = 1;
      g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    }

    // כותרות הימים
    var y = TITLE;
    box(xOf(0), y, W_LABEL, HEAD, '#3c3c3c');
    box(xOf(1), y, W_ZONES, HEAD, '#3c3c3c');
    g.fillStyle = '#ffffff';
    g.font = '600 13px "Segoe UI", Arial, sans-serif';
    g.fillText('גיזרות', xOf(1) + W_ZONES - PAD, y + 10);
    for (var i = 0; i < BOARD.days.length; i++) {
      var x = xOf(2 + i);
      box(x, y, W_DAY, HEAD, '#3c3c3c');
      g.fillStyle = '#ffffff';
      g.textAlign = 'center';
      g.fillText(BOARD.days[i], x + W_DAY / 2, y + 10);
      g.textAlign = 'right';
    }
    y += HEAD;

    // שורות
    BOARD.rows.forEach(function (r, ri) {
      var h = heights[ri];
      var k = kindOf(r.kind);

      box(xOf(0), y, W_LABEL, h, COL[k] || '#f0f0f0');
      g.fillStyle = TXT[k] || '#333333';
      fitText(r.label, xOf(0) + W_LABEL - PAD, y + PAD, W_LABEL - PAD * 2,
        '600 12px "Segoe UI", Arial, sans-serif');

      box(xOf(1), y, W_ZONES, h, '#fafafa');
      g.fillStyle = '#555555';
      r.zones.forEach(function (z, zi) {
        fitText(z, xOf(1) + W_ZONES - PAD, y + PAD + zi * ZLINE, W_ZONES - PAD * 2,
          '10px "Segoe UI", Arial, sans-serif');
      });

      r.cells.forEach(function (names, ci) {
        var x = xOf(2 + ci);
        box(x, y, W_DAY, h, names.length ? '#ffffff' : '#fcfcfc');
        g.fillStyle = k === 'sub' ? '#444444' : '#111111';
        var f = (k === 'sub' ? '11px' : '11.5px') + ' "Segoe UI", Arial, sans-serif';
        names.forEach(function (n, ni) {
          fitText(n, x + W_DAY - PAD, y + PAD + ni * LINE, W_DAY - PAD * 2, f);
        });
      });

      y += h;
    });

    g.fillStyle = '#777777';
    g.font = '11px "Segoe UI", Arial, sans-serif';
    g.fillText('לשאלות ולשינויים — פנו להנהלה.', width - 4, y + 8);

    return cv;
  }

  document.getElementById('btnPng').addEventListener('click', function () {
    try {
      var cv = draw(2);   // רזולוציה כפולה, שהתמונה תהיה חדה גם בטלפון
      cv.toBlob(function (blob) {
        if (!blob) { alert('לא הצלחנו ליצור את התמונה. נסו את הכפתור "שמור כ-PDF".'); return; }
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'לוח תורנויות ' + BOARD.date.replace(/[\\/]/g, '.') + '.png';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      }, 'image/png');
    } catch (e) {
      alert('לא הצלחנו ליצור את התמונה: ' + e.message);
    }
  });

  document.getElementById('btnPdf').addEventListener('click', function () { window.print(); });
})();
</script>
</body>
</html>`;
}

function buildTeacherHtml(model, dutyPlan) {
  const days = collectDays(model, null, dutyPlan);
  const grid = buildDutyGrid(days, dutyPlan);
  const breaks = orderBreaks(grid.breaks);
  const byTeacher = dutiesByTeacher(days, dutyPlan);
  const school = str(asObj(asObj(model).meta).school) || 'לוח תורנויות';
  const names = Object.keys(byTeacher).sort((a, b) => a.localeCompare(b, 'he'));

  const css = `
    @page { size: A4; margin: 12mm; }
    *{ box-sizing:border-box; }
    body{
      margin:0; padding:24px; background:#fff; color:#1a1a1a;
      font-family:"Segoe UI","Arial Hebrew",Arial,sans-serif;
      font-size:14px; line-height:1.5;
    }
    .sheet{ max-width:1100px; margin:0 auto; }
    header{ border-bottom:3px solid #1a1a1a; padding-bottom:12px; margin-bottom:24px; }
    h1{ margin:0 0 4px; font-size:26px; }
    header .sub{ color:#666; font-size:13px; }
    h2{ font-size:19px; margin:0 0 14px; padding-bottom:6px; border-bottom:2px solid #ddd; }
    section{ margin-bottom:32px; }
    .table-wrap{ overflow-x:auto; }
    table{ border-collapse:collapse; width:100%; }
    th,td{ border:1px solid #c8c8c8; padding:7px 9px; text-align:right; vertical-align:top; }
    thead th{ background:#f0f0f0; font-size:13px; }
    tbody th{ background:#f7f7f7; white-space:nowrap; font-size:13px; width:90px; }
    td{ font-size:12.5px; }
    td .duty{ display:block; padding:1px 0; }
    td .where{ color:#666; font-size:11px; }
    .teachers{ column-count:2; column-gap:28px; }
    .card{
      break-inside:avoid; page-break-inside:avoid;
      border:1px solid #d5d5d5; border-radius:6px;
      padding:10px 12px; margin:0 0 12px;
    }
    .card h3{ margin:0 0 6px; font-size:14.5px; border-bottom:1px solid #e5e5e5; padding-bottom:4px; }
    .card ul{ margin:0; padding:0; list-style:none; }
    .card li{ font-size:12.5px; padding:2px 0; display:flex; gap:6px; }
    .card li .d{ font-weight:600; min-width:44px; }
    .card li .b{ min-width:58px; color:#444; }
    .card li .w{ color:#666; }
    .none{ color:#888; font-style:italic; font-size:12.5px; }
    footer{ margin-top:28px; padding-top:12px; border-top:1px solid #ddd; color:#777; font-size:12px; }
    @media print{
      body{ padding:0; }
      section{ page-break-inside:auto; }
      h2{ page-break-after:avoid; }
      .no-print{ display:none; }
    }
    .no-print{
      margin-bottom:20px; padding:10px 14px; background:#eef3fb;
      border:1px solid #c3d4ee; border-radius:8px; font-size:13px; color:#24406e;
    }`;

  const gridRows = breaks.map((brk) => {
    const cells = days.map((day) => {
      const list = asObj(grid.cells[brk])[day];
      if (!list || !list.length) return '<td></td>';
      const items = list.map((x) => {
        const where = x.area && x.area !== x.role ? `<span class="where"> · ${esc(x.area)}</span>` : '';
        return `<span class="duty">${esc(displayName(x.name))}${where}</span>`;
      }).join('');
      return `<td>${items}</td>`;
    }).join('');
    return `<tr><th>${esc(brk)}</th>${cells}</tr>`;
  }).join('\n');

  const cards = names.map((name) => {
    const list = byTeacher[name];
    const items = list.length
      ? list.map((d) => `<li><span class="d">${esc(d.day.replace('יום ', ''))}</span>`
          + `<span class="b">${esc(d.brk)}</span>`
          + `<span class="w">${esc(d.where)}</span></li>`).join('')
      : '<li class="none">אין תורנויות</li>';
    return `<div class="card"><h3>${esc(displayName(name))}</h3><ul>${items}</ul></div>`;
  }).join('\n');

  const today = new Date().toLocaleDateString('he-IL');

  return `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>לוח תורנויות למורים</title>
<style>${css}</style>
</head>
<body>
<div class="sheet">
  <div class="no-print">להדפסה או לשמירה כ-PDF: Ctrl+P</div>

  <header>
    <h1>לוח תורנויות שבועי</h1>
    <div class="sub">${esc(school)} · הופק ב-${esc(today)}</div>
  </header>

  <section>
    <h2>הלוח השבועי</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>הפסקה</th>${days.map((d) => `<th>${esc(d)}</th>`).join('')}</tr></thead>
        <tbody>${gridRows}</tbody>
      </table>
    </div>
  </section>

  <section>
    <h2>תורנות אישית</h2>
    <div class="teachers">${cards}</div>
  </section>

  <footer>לשאלות ולשינויים — פנו להנהלה.</footer>
</div>
</body>
</html>`;
}

module.exports = { buildWorkbook, buildHtml, buildTeacherHtml, buildBoardHtml, buildBoardData };
