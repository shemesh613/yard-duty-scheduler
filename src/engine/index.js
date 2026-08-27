// אורקסטרטור — מחבר את כל מודולי המנוע לפי SPEC.md.
// אל תשנו את החתימות; הסוכנים מספקים את המודולים.
const fs = require('fs');
const path = require('path');

const parse = require('./parse');     // סוכן 1
const infer = require('./infer');     // סוכן 1
const yard = require('./yard');       // סוכן 2
const duty = require('./duty');       // סוכן 3
const report = require('./report');   // סוכן 4

const rulesPath = path.join(__dirname, '..', '..', 'config', 'rules.json');
function loadRules() {
  try { return JSON.parse(fs.readFileSync(rulesPath, 'utf8')); }
  catch { return {}; }
}

const locationsPath = path.join(__dirname, '..', '..', 'config', 'locations.json');
function loadLocations() {
  try { return JSON.parse(fs.readFileSync(locationsPath, 'utf8')); }
  catch { return null; }
}

// עקיפות קבועות שנשמרות בקובץ (config/overrides.json) — למשל צוות ההנהלה.
const overridesPath = path.join(__dirname, '..', '..', 'config', 'overrides.json');
function loadFileOverrides() {
  try {
    const o = JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
    return { teachers: o.teachers || {}, classes: o.classes || {}, meta: o.meta };
  } catch { return { teachers: {}, classes: {} }; }
}

// זיהוי מגדר כיתה מתוך מערכת השעות עצמה: בכיתות הבנים מלמדים רבנים.
// כיתה שיש בה ולו שיעור אחד של "הרב ..." — כיתת בנים; אחרת — כיתת בנות.
// שימש כגיבוי לכיתות שאינן מופיעות בקובץ המיקומים; ניתן לעקוף במסך ההגדרות.
function inferGenderFromLessons(lessons) {
  const byClass = {};
  for (const l of lessons) {
    if (!l.cls) continue;
    const acc = byClass[l.cls] || (byClass[l.cls] = { total: 0, rabbi: 0 });
    acc.total++;
    if (/הרב/.test(String(l.teacher || ''))) acc.rabbi++;
  }
  const out = {};
  for (const [cls, acc] of Object.entries(byClass)) {
    if (acc.total < 10) continue; // מעט מדי שיעורים מכדי להסיק
    out[cls] = acc.rabbi > 0 ? 'בנים' : 'בנות';
  }
  return out;
}

// גזירת עקיפות מגדר אוטומטיות: קודם קובץ המיקומים, ולכיתות שאינן בו — הסקה מהמערכת.
// בנוסף, מתחם מגדרי למורה לפי הכיתות שהוא מלמד (>=80% מגדר אחד).
function deriveGenderOverrides(rawLessons, locations) {
  const lessonsAll = Array.isArray(rawLessons) ? rawLessons : [];
  const inferred = inferGenderFromLessons(lessonsAll);
  const known = (locations && locations._genderByClass) || {};
  const g = { ...inferred, ...known }; // קובץ המיקומים גובר על ההסקה
  if (!Object.keys(g).length) return { teachers: {}, classes: {} };
  const classes = {};
  const teachers = {};
  const lessons = lessonsAll;
  for (const c of new Set(lessons.map((l) => l.cls))) {
    if (g[c]) classes[c] = { gender: g[c] };
  }
  const byTeacher = {};
  for (const l of lessons) {
    const gg = g[l.cls];
    if (!gg) continue;
    const acc = byTeacher[l.teacher] || (byTeacher[l.teacher] = { 'בנים': 0, 'בנות': 0 });
    acc[gg]++;
  }
  for (const [name, c] of Object.entries(byTeacher)) {
    const total = c['בנים'] + c['בנות'];
    if (total < 3) continue;
    const ratioBoys = c['בנים'] / total;
    if (ratioBoys >= 0.8) teachers[name] = { genderArea: 'בנים' };
    else if (ratioBoys <= 0.2) teachers[name] = { genderArea: 'בנות' };
  }
  return { teachers, classes };
}

// מיזוג עקיפות: base (מהמיקומים) למטה, עקיפות המשתמש גוברות.
function mergeOverrides(base, user) {
  base = base || {}; user = user || {};
  const out = { teachers: {}, classes: {} };
  for (const [k, v] of Object.entries(base.teachers || {})) out.teachers[k] = { ...v };
  for (const [k, v] of Object.entries(user.teachers || {})) out.teachers[k] = { ...(out.teachers[k] || {}), ...v };
  for (const [k, v] of Object.entries(base.classes || {})) out.classes[k] = { ...v };
  for (const [k, v] of Object.entries(user.classes || {})) out.classes[k] = { ...(out.classes[k] || {}), ...v };
  if (user.meta) out.meta = user.meta;
  // רשימות התורנויות שהוסרו/נשמרות ידנית עוברות כמות שהן.
  if (user.blocked || base.blocked) out.blocked = user.blocked || base.blocked;
  if (user.pinned || base.pinned) out.pinned = user.pinned || base.pinned;
  return out;
}

/**
 * מריץ את כל הצינור על קובץ אקסל (buffer או נתיב).
 * @param {Buffer|string} input
 * @param {object} overrides  — עקיפות מטא-דאטה ידניות (config/overrides.json)
 * @returns {{model, yardPlan, dutyPlan, workbookBuffer, html}}
 */
function runPipeline(input, overrides = {}) {
  const rawLessons = parse.parseWorkbook(input);
  // שכבות עקיפה (מהחלש לחזק): מיקומים(מגדר) < config/overrides.json < הגדרות המשתמש בבקשה.
  const locationOverrides = deriveGenderOverrides(rawLessons, loadLocations());
  let mergedOverrides = mergeOverrides(locationOverrides, loadFileOverrides());
  mergedOverrides = mergeOverrides(mergedOverrides, overrides);
  const model = infer.buildModel(rawLessons, mergedOverrides);
  const rules = loadRules();
  const yardPlan = yard.assignYard(model, {});
  // blocked/pinned מגיעים מהממשק: תורנויות שהוסרו ידנית, ותורנויות לשימור.
  const dutyPlan = duty.assignDuties(model, rules, {
    yardPlan,
    blocked: (overrides && overrides.blocked) || [],
    pinned: (overrides && overrides.pinned) || [],
  });
  const workbookBuffer = report.buildWorkbook(model, yardPlan, dutyPlan);
  const html = report.buildHtml(model, yardPlan, dutyPlan);
  // מסמך נקי להפצה למורים — בלי נתוני בקרה.
  const teacherHtml = report.buildTeacherHtml(model, dutyPlan);
  return { model, yardPlan, dutyPlan, workbookBuffer, html, teacherHtml };
}

module.exports = { runPipeline, loadRules, loadLocations, loadFileOverrides, deriveGenderOverrides, mergeOverrides };

// הרצה ישירה לבדיקה: node src/engine/index.js [model.sample.json|file.xlsx]
if (require.main === module) {
  const arg = process.argv[2] || path.join(__dirname, '..', '..', 'samples', 'model.sample.json');
  let model, yardPlan, dutyPlan;
  if (arg.endsWith('.json')) {
    model = JSON.parse(fs.readFileSync(arg, 'utf8'));
    yardPlan = yard.assignYard(model, {});
    dutyPlan = duty.assignDuties(model, loadRules(), { yardPlan });
  } else {
    ({ model, yardPlan, dutyPlan } = runPipeline(fs.readFileSync(arg)));
  }
  console.log('מורים:', model.teachers.length, '| כיתות:', model.classes.length);
  console.log('חלונות מגרש:', yardPlan.slots.length, '| אזהרות:', yardPlan.warnings.length);
  console.log('שיבוצי תורנות:', dutyPlan.assignments.length, '| הפרות:', dutyPlan.violations.length);
}
