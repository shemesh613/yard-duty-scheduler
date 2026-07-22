// סוכן 1 — שכבת קלט. קורא קובץ אקסל של מערכת שעות ומחזיר שיעורים גולמיים.
// פורמט: גיליון יחיד, שורת כותרת "כיתה | יום | שעה | מקצוע | מורה" (מאותרת דינמית).
// אסור לקודד שמות/כיתות — חייב לעבוד על כל קובץ באותו פורמט.
const XLSX = require('xlsx');

// כיתות שאינן כיתה אמיתית (תפקיד/ללא כיתה/עדיין לא שובץ).
const FAKE_CLASS_RE = /ללא כיתה|תפקיד|שובץ/;

// כותרות שאנו מחפשים בשורת הכותרת. נורמליזציה: הסרת רווחים/גרשיים.
const HEADERS = {
  cls: ['כיתה'],
  day: ['יום'],
  period: ['שעה'],
  subject: ['מקצוע'],
  teacher: ['מורה'],
};

function norm(v) {
  return String(v == null ? '' : v).replace(/["'׳״]/g, '').trim();
}

// מאתר את אינדקס שורת הכותרת ואת מיפוי העמודות לפי תוכן (לא לפי מיקום קשיח).
function findHeader(rows) {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || [];
    const cells = row.map(norm);
    const colOf = (aliases) => cells.findIndex((c) => aliases.includes(c));
    const map = {
      cls: colOf(HEADERS.cls),
      day: colOf(HEADERS.day),
      period: colOf(HEADERS.period),
      subject: colOf(HEADERS.subject),
      teacher: colOf(HEADERS.teacher),
    };
    // שורת כותרת תקפה: לפחות כיתה+יום+מורה אותרו.
    if (map.cls >= 0 && map.day >= 0 && map.teacher >= 0) {
      // השלמות סבירות אם עמודה חסרה (לפי מיקום יחסי לכיתה).
      if (map.period < 0) map.period = map.day + 1;
      if (map.subject < 0) map.subject = map.day + 2;
      return { headerIndex: i, map };
    }
  }
  // ברירת מחדל לפורמט הידוע (שורה 4, עמודות 0..4).
  return { headerIndex: 3, map: { cls: 0, day: 1, period: 2, subject: 3, teacher: 4 } };
}

/**
 * @param {Buffer|string} input  — Buffer של קובץ אקסל או נתיב לקובץ.
 * @returns {Array<{cls,day,period,subject,teacher}>}  שיעורים גולמיים מסוננים.
 */
function parseWorkbook(input) {
  let wb;
  if (Buffer.isBuffer(input)) {
    wb = XLSX.read(input, { type: 'buffer' });
  } else if (typeof input === 'string') {
    wb = XLSX.readFile(input);
  } else {
    throw new TypeError('parseWorkbook: input חייב להיות Buffer או נתיב לקובץ');
  }

  const sheetName = wb.SheetNames[0];
  if (!sheetName) return [];
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  const { headerIndex, map } = findHeader(rows);
  const lessons = [];

  // מטא: שם בית הספר (תא ראשון בגיליון) ושם הקובץ (אם נתיב).
  const school = norm(rows[0] && rows[0][0]);
  const sourceFile = typeof input === 'string' ? input.split(/[\\/]/).pop() : '';

  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const cls = norm(row[map.cls]);
    const day = norm(row[map.day]);
    const periodRaw = row[map.period];
    const subject = norm(row[map.subject]);
    const teacher = norm(row[map.teacher]);

    // סינון שורות ריקות / חסרות מידע חיוני.
    if (!cls || !day || !teacher) continue;
    // סינון כיתות לא אמיתיות.
    if (FAKE_CLASS_RE.test(cls)) continue;

    const period = Number(periodRaw);
    if (!Number.isFinite(period)) continue;

    lessons.push({ cls, day, period, subject, teacher });
  }

  // מטא נצמד כתכונה לא-מספירה כדי לא לשנות את חתימת המערך.
  Object.defineProperty(lessons, '_meta', {
    value: { school, sourceFile },
    enumerable: false,
  });

  return lessons;
}

module.exports = { parseWorkbook };
