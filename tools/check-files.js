// בדיקת עמידות: מריץ את הצינור על כל קובץ מערכת שעות שנמצא, ומוודא
// שהכללים נשמרים בכל אחד מהם. נועד לתפוס באגים שמתגלים רק בקובץ מסוים.
//
//   node tools/check-files.js [תיקייה או קובץ ...]
//
// בלי ארגומנטים — סורק את תיקיית הפרויקט ואת תיקיית ההורדות.

const fs = require('fs');
const path = require('path');
const { runPipeline, loadRules } = require('../src/engine/index.js');

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const DEFAULT_DIRS = [path.join(__dirname, '..'), path.join(HOME, 'Downloads')];

// קבצים שהמערכת עצמה ייצרה — אינם קלט.
const OUTPUT_RE = /^(לוח|לוחות)[-\s]/;

function findFiles(targets) {
  const out = [];
  for (const t of targets) {
    let st;
    try { st = fs.statSync(t); } catch (_) { continue; }
    if (st.isFile()) { out.push(t); continue; }
    for (const f of fs.readdirSync(t)) {
      if (!f.endsWith('.xlsx') || f.startsWith('~$')) continue;
      if (OUTPUT_RE.test(f)) continue;
      out.push(path.join(t, f));
    }
  }
  return out;
}

// כל בדיקה מחזירה רשימת בעיות. רשימה ריקה = עבר.
const CHECKS = [
  {
    name: 'כל העמדות הנדרשות אוישו',
    run: ({ assignments }) => {
      const bad = [];
      const byDay = {};
      for (const a of assignments) (byDay[a.day] = byDay[a.day] || new Set()).add(a.break);
      for (const [day, breaks] of Object.entries(byDay)) {
        for (const brk of breaks) {
          if (!/אחרי/.test(brk)) continue;
          const has = (role) => assignments.some((a) => a.day === day && a.break === brk && a.role === role);
          if (!has('סייר')) bad.push(`אין סייר ב-${day} ${brk}`);
        }
      }
      return bad;
    },
  },
  {
    name: 'הגדרות אישיות הוחלו (יום חופש, נוכחות קבועה)',
    run: ({ model }) => {
      const bad = [];
      const ov = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', 'config', 'overrides.json'), 'utf8')).teachers || {};
      const clean = (n) => String(n || '').replace(/\((?:ל|ה|ת)\)/g, '')
        .replace(/^תת[\s-]+/, '').replace(/^ת-\s*/, '').replace(/\s+/g, ' ').trim();
      for (const [key, val] of Object.entries(ov)) {
        if (!val || !val.alwaysPresent) continue;
        const t = model.teachers.find((x) => clean(x.name) === clean(key));
        if (!t) continue;
        if (!t.alwaysPresent) bad.push(`"${t.name}" מוגדר alwaysPresent אך לא הוחל`);
        const off = Array.isArray(val.daysOff) ? val.daysOff : (val.dayOff ? [val.dayOff] : []);
        const got = Array.isArray(t.daysOff) ? t.daysOff : [];
        for (const d of off) if (!got.includes(d)) bad.push(`"${t.name}" יום חופש ${d} לא הוחל`);
      }
      return bad;
    },
  },
  {
    name: 'כללי האיסור נשמרו',
    run: ({ model, assignments }, rules) => {
      const bad = [];
      const clean = (n) => String(n || '').replace(/\((?:ל|ה|ת)\)/g, '')
        .replace(/^תת[\s-]+/, '').replace(/^ת-\s*/, '').replace(/\s+/g, ' ').trim();
      const byId = Object.fromEntries(model.teachers.map((t) => [t.id, t]));
      for (const a of assignments) {
        const t = byId[a.teacherId];
        if (!t) continue;
        for (const rule of rules.exclusions || []) {
          if (Array.isArray(rule.types) && !rule.types.includes(t.type)) continue;
          if (Array.isArray(rule.days) && !rule.days.includes(a.day)) continue;
          if (Array.isArray(rule.names) && !rule.names.some((n) => clean(n) === clean(t.name))) continue;
          if (Array.isArray(rule.onlyRoles)) {
            if (!rule.onlyRoles.includes(a.role)) {
              bad.push(`"${t.name}" שובץ ל-${a.role} למרות היתר בלעדי ל-${rule.onlyRoles.join('/')}`);
            }
            continue;
          }
          if (Array.isArray(rule.roles) && !rule.roles.includes(a.role)) continue;
          bad.push(`"${t.name}" (${t.type}) שובץ ל-${a.role} ב-${a.day} בניגוד לאיסור`);
        }
      }
      return bad;
    },
  },
  {
    name: 'אין תורנות ביום חופש',
    run: ({ model, assignments }) => {
      const bad = [];
      const byId = Object.fromEntries(model.teachers.map((t) => [t.id, t]));
      for (const a of assignments) {
        const t = byId[a.teacherId];
        if (!t) continue;
        const off = Array.isArray(t.daysOff) ? t.daysOff : (t.dayOff ? [t.dayOff] : []);
        if (off.includes(a.day)) bad.push(`"${t.name}" שובץ ב-${a.day} שהוא יום חופש שלו`);
      }
      return bad;
    },
  },
  {
    name: 'אין מורה בשתי עמדות באותה הפסקה',
    run: ({ assignments }) => {
      const seen = {};
      const bad = [];
      for (const a of assignments) {
        const k = a.teacherName + '|' + a.day + '|' + a.break;
        if (seen[k]) bad.push(`"${a.teacherName}" משובץ פעמיים ב-${a.day} ${a.break}`);
        seen[k] = true;
      }
      return bad;
    },
  },
  {
    name: 'מורה פטור (ל) לא שובץ',
    run: ({ model, assignments }) => {
      const off = new Set(model.teachers.filter((t) => t.noDuty).map((t) => t.id));
      return assignments.filter((a) => off.has(a.teacherId))
        .map((a) => `"${a.teacherName}" פטור מתורנות אך שובץ ל-${a.role}`);
    },
  },
];

const files = findFiles(process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_DIRS);
if (!files.length) {
  console.log('לא נמצאו קובצי מערכת שעות לבדיקה.');
  process.exit(0);
}

const rules = loadRules();
let failed = 0;

for (const file of files) {
  let res;
  try {
    res = runPipeline(fs.readFileSync(file), {});
  } catch (err0) {
    const err = err0;
    console.log('✗ ' + path.basename(file) + ' — הצינור נכשל: ' + err.message);
    failed++;
    continue;
  }

  const problems = [];
  // שתי הרצות: ישירה, ודרך מסך ההגדרות — שם הממשק שולח עקיפה לכל מורה
  // לפי שמו בקובץ. זהו המסלול שהמשתמש עובר בו בפועל.
  const uiOverrides = { teachers: {} };
  for (const t of res.model.teachers) {
    const o = { type: t.type, noDuty: !!t.noDuty, daysOff: t.daysOff || [] };
    if (t.genderArea) o.genderArea = t.genderArea;
    uiOverrides.teachers[t.name] = o;
  }
  let viaUi;
  try {
    viaUi = runPipeline(fs.readFileSync(file), uiOverrides);
  } catch (err) {
    problems.push('הרצה דרך מסך ההגדרות נכשלה: ' + err.message);
  }

  for (const [label, r2] of [['', res], ['דרך מסך ההגדרות — ', viaUi]]) {
    if (!r2) continue;
    const ctx = { model: r2.model, assignments: r2.dutyPlan.assignments };
    for (const check of CHECKS) {
      for (const p of check.run(ctx, rules)) problems.push(label + check.name + ': ' + p);
    }
  }

  const head = `${path.basename(file)} — ${res.model.teachers.length} מורים, `
    + `${res.dutyPlan.assignments.length} שיבוצים, ${res.dutyPlan.violations.length} הפרות`;

  if (problems.length) {
    failed++;
    console.log('✗ ' + head);
    for (const p of problems.slice(0, 12)) console.log('    ' + p);
    if (problems.length > 12) console.log(`    ... ועוד ${problems.length - 12}`);
  } else {
    console.log('✓ ' + head);
  }
}

console.log();
console.log(failed ? `${failed} מתוך ${files.length} קבצים נכשלו.` : `כל ${files.length} הקבצים עברו.`);
process.exit(failed ? 1 : 0);
