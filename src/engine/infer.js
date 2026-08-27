// סוכן 1 — שכבת הסקה. בונה מודל מנורמל מהשיעורים הגולמיים + מסיק מטא-דאטה חסרה.
// כל שדה מוסק ניתן לעקיפה דרך overrides (גובר על כל הסקה).
// הסכמה: ראו SPEC.md ו-samples/model.sample.json.

const STANDBY_SUBJECTS = ['פרטני', 'שהייה', 'שהיה'];
const HOMEROOM_MIN_HOURS = 8; // סף שעות למחנך/ת בכיתה.

function isStandby(subject) {
  const s = String(subject || '');
  return STANDBY_SUBJECTS.some((k) => s.includes(k));
}

// סימוני המקרא ברשימת המורים:
//   תת  = תומכת למידה   |  (ה) = הנהלה
//   (ת) = כיתת תקשורת   |  (ל) = לא עושה תורנות כלל
// הסימונים נבדקים בסוגריים מדויקים, כדי ש"(סגל)" וכדומה לא ייקראו בטעות כסימון.
const MARK_NO_DUTY = /\(ל\)/;
const MARK_MANAGEMENT = /\(ה\)/;
const MARK_COMMUNICATION = /\(ת\)/;
const MARK_SUPPORT = /^תת[\s-]/;

// האם המורה פטור מתורנות לפי הסימון (ל).
function noDutyFromName(name) {
  return MARK_NO_DUTY.test(String(name || ''));
}

// סוג מורה מתוך שם (קידומת/סימון). מחזיר null אם לא ידוע (יעודן לפי הסקת מחנכות).
function typeFromName(name) {
  const n = String(name || '');
  if (n.startsWith('ת- חוגים') || n.startsWith('ת-חוגים') || n.includes('חוגים')) return 'חוגים';
  if (MARK_MANAGEMENT.test(n)) return 'הנהלה';
  if (MARK_COMMUNICATION.test(n)) return 'מורה משלימה תקשורת';
  if (MARK_SUPPORT.test(n)) return 'תומכת למידה';
  if (n.includes('מחנכ')) return 'מחנכת';
  if (n.startsWith('הרב') || n.includes(' הרב ')) return 'מורה מקצועי';
  return null;
}

// גזירת שכבת הגרייד מתוך מזהה כיתה (אותיות בעברית בתחילת המחרוזת).
function gradeOf(clsId) {
  const m = String(clsId).match(/^[א-ת]+/);
  return m ? m[0] : '';
}

/**
 * בונה את המודל המנורמל.
 * @param {Array<{cls,day,period,subject,teacher}>} rawLessons
 * @param {object} overrides  — { teachers:{[name]:{...}}, classes:{[id]:{...}}, meta:{...} }
 * @returns {object} model
 */
function buildModel(rawLessons, overrides = {}) {
  const lessons = Array.isArray(rawLessons) ? rawLessons : [];
  const ovT = (overrides && overrides.teachers) || {};
  const ovC = (overrides && overrides.classes) || {};
  const ovMeta = (overrides && overrides.meta) || {};
  const rawMeta = (rawLessons && rawLessons._meta) || {};

  // --- מטא ---
  const days = [...new Set(lessons.map((l) => l.day))];
  const periods = [...new Set(lessons.map((l) => l.period))].sort((a, b) => a - b);
  // שיעורים בלי מזהה כיתה (שהייה, ישיבות צוות) נספרים בשעות העבודה אך אינם כיתה.
  const classIds = [...new Set(lessons.map((l) => l.cls))].filter(Boolean);

  // --- צבירת נתוני מורים ---
  const tmap = {};
  for (const l of lessons) {
    let t = tmap[l.teacher];
    if (!t) {
      t = tmap[l.teacher] = {
        name: l.teacher,
        days: new Set(),
        classCount: {},
        lessons: [],
        byDay: {},
      };
    }
    t.days.add(l.day);
    t.classCount[l.cls] = (t.classCount[l.cls] || 0) + 1;
    t.lessons.push({
      day: l.day,
      period: l.period,
      cls: l.cls,
      subject: l.subject,
      standby: isStandby(l.subject),
    });
    (t.byDay[l.day] = t.byDay[l.day] || []).push(l.period);
  }

  // מורים שמופיעים בקובץ אך ללא שיעורים כלל (בלוק ריק) — נכללים במודל
  // עם מערכת ריקה, כדי שניתן יהיה לשבצם לתורנות לפי מה שמתאים.
  for (const name of rawMeta.allTeachers || []) {
    if (tmap[name]) continue;
    tmap[name] = { name, days: new Set(), classCount: {}, lessons: [], byDay: {} };
  }

  // --- הסקת מחנכ/ת לכל כיתה: המורה עם הכי הרבה שעות בכיתה (>= סף) ---
  const homeroomOfClass = {}; // clsId -> teacherName
  for (const cls of classIds) {
    let best = null;
    for (const t of Object.values(tmap)) {
      const h = t.classCount[cls] || 0;
      if (h >= HOMEROOM_MIN_HOURS && (!best || h > best.h)) best = { name: t.name, h };
    }
    if (best) homeroomOfClass[cls] = best.name;
  }

  // --- בניית רשומות מורים ---
  let tid = 0;
  const teachers = Object.values(tmap).map((t) => {
    const id = 't' + ++tid;
    const ov = ovT[t.name] || {};

    // homeroomOf מוסק: הכיתה הראשונה שמורה זה מחנך שלה.
    let homeroomOf = classIds.find((c) => homeroomOfClass[c] === t.name) || null;
    if (ov.homeroomOf !== undefined && ov.homeroomOf !== null) homeroomOf = ov.homeroomOf;

    // type מוסק לפי שם, ואם לא ידוע — לפי האם מחנך/ת.
    let type = typeFromName(t.name);
    if (!type) type = homeroomOf ? 'מחנכת' : 'מורה מקצועי';
    if (ov.type !== undefined && ov.type !== null) type = ov.type;

    // workSpan: שעה ראשונה/אחרונה בכל יום.
    const workSpan = {};
    for (const [d, ps] of Object.entries(t.byDay)) {
      workSpan[d] = { first: Math.min(...ps), last: Math.max(...ps) };
    }

    // freeSlots: בתוך טווח העבודה ביום עבודה, ללא שיעור.
    const busy = new Set(t.lessons.map((l) => l.day + '#' + l.period));
    const freeSlots = [];
    for (const [d, span] of Object.entries(workSpan)) {
      for (let p = span.first; p <= span.last; p++) {
        if (!busy.has(d + '#' + p)) freeSlots.push({ day: d, period: p });
      }
    }

    // standbySlots: שעות שהייה/פרטני.
    const standbySlots = t.lessons
      .filter((l) => l.standby)
      .map((l) => ({ day: l.day, period: l.period }));

    // noDuty מוסק: חוגים, או שם המסומן ב-(ל) → לא עושים תורנות כלל.
    let noDuty = type === 'חוגים' || noDutyFromName(t.name);
    if (ov.noDuty !== undefined && ov.noDuty !== null) noDuty = !!ov.noDuty;

    // genderArea: לא ניתן להסקה אוטומטית — null אלא אם נעקף.
    let genderArea = null;
    if (ov.genderArea !== undefined && ov.genderArea !== null) genderArea = ov.genderArea;

    // dayOff: עבור הרב יאיר — יום שבו אינו עובד מסומן כיום חופשי. ניתן לעקיפה.
    let dayOff = null;
    if (t.name.includes('יאיר')) {
      const worked = new Set([...t.days]);
      dayOff = days.find((d) => !worked.has(d)) || null;
    }
    if (ov.dayOff !== undefined && ov.dayOff !== null) dayOff = ov.dayOff;

    return {
      id,
      name: t.name,
      type, // מוסק — ניתן לעקיפה
      rabbi: t.name.includes('הרב'),
      daysWorked: [...t.days],
      numDaysWorked: t.days.size,
      noDuty, // מוסק — ניתן לעקיפה
      genderArea, // ניתן לעקיפה
      homeroomOf, // מוסק — ניתן לעקיפה
      dayOff, // מוסק (יאיר) — ניתן לעקיפה
      workSpan,
      lessons: t.lessons,
      freeSlots,
      standbySlots,
    };
  });

  const idByName = Object.fromEntries(teachers.map((t) => [t.name, t.id]));

  // --- כיתות ---
  const classes = classIds.map((cls) => {
    const ov = ovC[cls] || {};
    let homeroomTeacherId = homeroomOfClass[cls] ? idByName[homeroomOfClass[cls]] : null;
    if (ov.homeroomTeacherId !== undefined && ov.homeroomTeacherId !== null) {
      homeroomTeacherId = ov.homeroomTeacherId;
    }
    let gender = null;
    if (ov.gender !== undefined && ov.gender !== null) gender = ov.gender;
    return { id: cls, grade: gradeOf(cls), homeroomTeacherId, gender };
  });

  // אם נעקף homeroomOf במורה — נסנכרן את homeroomTeacherId של הכיתה בהתאם.
  for (const t of teachers) {
    if (t.homeroomOf) {
      const c = classes.find((c) => c.id === t.homeroomOf);
      if (c && !ovC[c.id]) c.homeroomTeacherId = t.id;
    }
  }

  const model = {
    meta: {
      school: ovMeta.school || rawMeta.school || '',
      sourceFile: ovMeta.sourceFile || rawMeta.sourceFile || '',
      generatedAt: new Date().toISOString(),
      days,
      periods,
    },
    classes,
    teachers,
    lessons: lessons.map((l) => ({
      day: l.day,
      period: l.period,
      cls: l.cls,
      subject: l.subject,
      teacher: l.teacher,
    })),
  };

  return model;
}

/**
 * תבנית overrides ריקה לעריכה ידנית — כל המורים והכיתות עם שדות null.
 * @param {object} model
 * @returns {object} overrides template
 */
function overrideTemplate(model) {
  const teachers = {};
  for (const t of (model.teachers || [])) {
    teachers[t.name] = {
      type: null,
      noDuty: null,
      genderArea: null,
      homeroomOf: null,
      dayOff: null,
    };
  }
  const classes = {};
  for (const c of (model.classes || [])) {
    classes[c.id] = { gender: null, homeroomTeacherId: null };
  }
  return {
    _note: 'ערכי null = השאר את ההסקה האוטומטית. מלא ערך כדי לעקוף.',
    teachers,
    classes,
  };
}

module.exports = { buildModel, overrideTemplate };
