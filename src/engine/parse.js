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
  return String(v == null ? '' : v)
    // רווח קשיח (U+00A0) מגיע מקובצי אקסל ונראה כמו רווח רגיל, אבל אינו זהה לו.
    // בלי ההמרה הזו השוואות של שמות ימים מול קובץ הכללים נכשלות בשקט.
    .replace(/ /g, ' ')
    .replace(/["'׳״]/g, '')
    .trim();
}

// --- פורמט ב': מערכת אישית לכל מורה (טבלת שעה × יום) ---

const TEACHER_BLOCK_RE = /^מערכת\s+שעות\s+למורה\s+(.+)$/;
const DAY_HEADER_RE = /^יום\s+[א-ו]$/;

// תא בפורמט הזה מכיל שורת מקצוע ואחריה (לפעמים) שורת כיתה.
// תא יכול להכיל יותר משיעור אחד באותה שעה (שיעור מפוצל) — כל זוג נקרא בנפרד.
// סימוני (פ)/(ש) מציינים פרטני/שהייה — מומרים למילה המלאה כדי שיזוהו כשעת שהייה.
function parseCell(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((s) => norm(s))
    .filter(Boolean);

  const out = [];
  for (const line of lines) {
    // שורה שהיא מזהה כיתה משויכת לשיעור שקדם לה.
    if (classIdsOf(line).length && out.length) {
      if (!out[out.length - 1].cls) {
        out[out.length - 1].cls = line;
        continue;
      }
    }
    const subject = line
      .replace(/\(פ\)/g, 'פרטני')
      .replace(/\(ש\)/g, 'שהייה')
      .replace(/\s+/g, ' ')
      .trim();
    if (subject) out.push({ subject, cls: '' });
  }
  return out;
}

// מזהה כיתה תקין: אות שכבה + מספר (א1, ה3, ו5). תא יכול לשאת כמה כיתות מופרדות בפסיק.
const CLASS_ID_RE = /^[א-ת]{1,2}\d{1,2}$/;

function classIdsOf(text) {
  return String(text || '')
    .split(/[,;\/]/)
    .map((s) => norm(s))
    .filter((s) => CLASS_ID_RE.test(s) && !FAKE_CLASS_RE.test(s));
}

// האם הגיליון בנוי כבלוקים של מערכת אישית לכל מורה.
function isPerTeacherGrid(rows) {
  return rows.some((r) => r && TEACHER_BLOCK_RE.test(norm(r[0])));
}

function parsePerTeacherGrid(rows) {
  const lessons = [];
  const allTeachers = []; // כל מורה שיש לו בלוק, גם אם הבלוק ריק משיעורים
  let teacher = null;
  let dayCols = null; // אינדקס עמודה → שם יום

  for (const row of rows) {
    if (!row) continue;
    const first = norm(row[0]);

    const block = first.match(TEACHER_BLOCK_RE);
    if (block) {
      teacher = block[1].trim();
      if (teacher && allTeachers.indexOf(teacher) === -1) allTeachers.push(teacher);
      dayCols = null;
      continue;
    }
    if (!teacher) continue;

    // שורת כותרת הימים של הבלוק הנוכחי.
    const cells = row.map(norm);
    if (cells.some((c) => DAY_HEADER_RE.test(c))) {
      dayCols = {};
      cells.forEach((c, i) => { if (DAY_HEADER_RE.test(c)) dayCols[i] = c; });
      continue;
    }
    if (!dayCols) continue;

    const period = Number(first);
    if (!Number.isFinite(period) || period <= 0) continue;

    for (const [colIdx, day] of Object.entries(dayCols)) {
      for (const parsed of parseCell(row[colIdx])) {
        // תא יכול לשאת כמה כיתות ("ג2, ג3") — כל אחת נרשמת כשיעור נפרד.
        // טקסט שאינו מזהה כיתה (שהייה, ישיבות צוות, השתלמות) נשמר בלי כיתה,
        // כדי שייספר בשעות העבודה של המורה אך לא ייחשב כשיעור בכיתה.
        const ids = classIdsOf(parsed.cls);
        if (!ids.length) {
          lessons.push({ cls: '', day, period, subject: parsed.subject, teacher });
          continue;
        }
        for (const cls of ids) {
          lessons.push({ cls, day, period, subject: parsed.subject, teacher });
        }
      }
    }
  }

  // רשימת כל המורים שיש להם בלוק — כולל מי שהבלוק שלו ריק משיעורים.
  Object.defineProperty(lessons, '_teachers', { value: allTeachers, enumerable: false });
  return lessons;
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

  // מטא: שם בית הספר (תא ראשון בגיליון) ושם הקובץ (אם נתיב).
  const school = norm(rows[0] && rows[0][0]);
  const sourceFile = typeof input === 'string' ? input.split(/[\\/]/).pop() : '';

  const attachMeta = (arr) => {
    Object.defineProperty(arr, '_meta', {
      value: { school, sourceFile, allTeachers: arr._teachers || null },
      enumerable: false,
    });
    return arr;
  };

  // פורמט ב' — מערכת אישית לכל מורה. מזוהה לפי כותרות "מערכת שעות למורה ...".
  if (isPerTeacherGrid(rows)) {
    return attachMeta(parsePerTeacherGrid(rows));
  }

  const { headerIndex, map } = findHeader(rows);
  const lessons = [];

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
  return attachMeta(lessons);
}

module.exports = { parseWorkbook };
