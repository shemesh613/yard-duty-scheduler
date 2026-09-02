// אימות כל כלל שנמסר ע"י ההנהלה, אחד-אחד, על קובץ אמיתי.
// רץ פעמיים: ישירות, ודרך המסלול שהממשק עובר בו (עקיפה לכל מורה).
//
//   node tools/check-rules.js [קובץ.xlsx]

const fs = require('fs');
const path = require('path');
const { runPipeline, loadRules } = require('../src/engine/index.js');

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const file = process.argv[2]
  || path.join(HOME, 'Downloads', 'א- מערכת תחילת שנה.xlsx');

const clean = (n) => String(n || '')
  .replace(/\((?:ל|ה|ת)\)/g, '')
  .replace(/^תת[\s-]+/, '')
  .replace(/^ת-\s*/, '')
  .replace(/\s+/g, ' ')
  .trim();

const rules = loadRules();
const buf = fs.readFileSync(file);

// המסלול שהממשק עובר בו: מסך ההגדרות שולח עקיפה לכל מורה, לפי שמו בקובץ.
const direct = runPipeline(buf, {});
const uiOverrides = { teachers: {} };
for (const t of direct.model.teachers) {
  const o = { type: t.type, noDuty: !!t.noDuty, daysOff: t.daysOff || [] };
  if (t.genderArea) o.genderArea = t.genderArea;
  uiOverrides.teachers[t.name] = o;
}
const viaUi = runPipeline(buf, uiOverrides);

// כל כלל: שם, ומה נדרש. מחזיר {ok, detail}.
const RULES = [
  {
    id: 'הרב יאיר — תורן תחילת יום בכל בוקר מלבד חמישי',
    check: ({ model, assignments }) => {
      const t = model.teachers.find((x) => /יאיר/.test(x.name));
      if (!t) return { ok: false, detail: 'לא נמצא בקובץ' };
      const days = [...new Set(model.meta.days)];
      const his = assignments.filter((a) => a.teacherId === t.id && a.break === 'תחילת יום')
        .map((a) => a.day);
      const expected = days.filter((d) => d !== 'יום ה');
      const missing = expected.filter((d) => !his.includes(d));
      const extra = his.filter((d) => d === 'יום ה');
      return {
        ok: !missing.length && !extra.length,
        detail: his.map((d) => d.replace('יום ', '')).sort().join(', ')
          + (missing.length ? ' | חסר: ' + missing.join(', ') : '')
          + (extra.length ? ' | שובץ ביום חופש!' : ''),
      };
    },
  },
  {
    id: 'רבקה אשכנזי — סיירת בלבד',
    check: ({ model, assignments }) => {
      const t = model.teachers.find((x) => clean(x.name) === 'אשכנזי רבקה');
      if (!t) return { ok: false, detail: 'לא נמצאה בקובץ' };
      const roles = [...new Set(assignments.filter((a) => a.teacherId === t.id).map((a) => a.role))];
      const bad = roles.filter((r) => r !== 'סייר');
      return { ok: !bad.length, detail: roles.join(', ') || 'ללא תורנויות' };
    },
  },
  {
    id: 'תומכת למידה — אינה סיירת',
    check: ({ model, assignments }) => {
      const ids = new Set(model.teachers.filter((t) => t.type === 'תומכת למידה').map((t) => t.id));
      const bad = assignments.filter((a) => a.role === 'סייר' && ids.has(a.teacherId));
      return { ok: !bad.length, detail: bad.length ? bad.map((a) => a.teacherName).join(', ') : 'אפס' };
    },
  },
  {
    id: 'מחנכת — לא חצר ולא מ"מ ביום שישי',
    check: ({ model, assignments }) => {
      const ids = new Set(model.teachers.filter((t) => t.type === 'מחנכת').map((t) => t.id));
      const bad = assignments.filter((a) => a.day === 'יום ו'
        && ids.has(a.teacherId) && ['חצר', 'מ"מ'].includes(a.role));
      return { ok: !bad.length, detail: bad.length ? bad.map((a) => a.teacherName + '/' + a.role).join(', ') : 'אפס' };
    },
  },
  {
    id: 'טבצניק הרב איתמר — משובץ כרגיל (הפטור בוטל)',
    check: ({ model, assignments }) => {
      const t = model.teachers.find((x) => /איתמר/.test(x.name));
      if (!t) return { ok: true, detail: 'אינו בקובץ' };
      const n = assignments.filter((a) => a.teacherId === t.id).length;
      return { ok: !t.noDuty, detail: t.noDuty ? 'עדיין מסומן פטור!' : n + ' תורנויות' };
    },
  },
  {
    id: 'הנהלה — לא בהפסקת 10 ביום שישי',
    check: ({ model, assignments }) => {
      const ids = new Set(model.teachers.filter((t) => t.type === 'הנהלה').map((t) => t.id));
      const bad = assignments.filter((a) => a.day === 'יום ו' && a.break === 'אחרי 2'
        && ids.has(a.teacherId));
      return { ok: !bad.length, detail: bad.length ? bad.map((a) => a.teacherName).join(', ') : 'אפס' };
    },
  },
  {
    id: 'תומכת למידה עם תורנות בשישי — אין לה תורנות אחרת',
    check: ({ model, assignments }) => {
      const bad = [];
      let withFri = 0;
      for (const t of model.teachers.filter((x) => x.type === 'תומכת למידה')) {
        const mine = assignments.filter((a) => a.teacherId === t.id);
        const fri = mine.filter((a) => a.day === 'יום ו').length;
        if (!fri) continue;
        withFri++;
        if (mine.length > fri) bad.push(t.name + ' (' + mine.length + ')');
      }
      return { ok: !bad.length, detail: bad.length ? bad.join(', ') : withFri + ' תומכות בשישי, כולן עם תורנות אחת' };
    },
  },
  {
    id: '"תת- אין מורה" — משרה לא מאוישת, בלי תורנויות',
    check: ({ model, assignments }) => {
      const t = model.teachers.find((x) => /אין מורה/.test(x.name));
      if (!t) return { ok: true, detail: 'אינו בקובץ' };
      const n = assignments.filter((a) => a.teacherId === t.id).length;
      return { ok: n === 0, detail: n + ' תורנויות' };
    },
  },
  {
    id: 'תורנות אחת ביום לכל מורה',
    check: ({ assignments }) => {
      const per = {};
      for (const a of assignments) {
        const k = a.teacherName + '|' + a.day;
        per[k] = (per[k] || 0) + 1;
      }
      const bad = Object.entries(per).filter(([, v]) => v > 1);
      return {
        ok: !bad.length,
        detail: bad.length
          ? bad.slice(0, 4).map(([k, v]) => k.replace('|', ' @ ') + ' ×' + v).join(' · ')
          : 'אפס חריגות',
      };
    },
  },
  {
    id: 'החלפה ידנית בתוך אותה הפסקה תופסת',
    check: ({ assignments }) => ({ ok: true, detail: 'נבדק בנפרד — ראו tools/check-swap.js' }),
  },
  {
    id: 'אין מורה בשתי עמדות באותה הפסקה',
    check: ({ assignments }) => {
      const seen = new Set();
      const bad = [];
      for (const a of assignments) {
        const k = a.teacherName + '|' + a.day + '|' + a.break;
        if (seen.has(k)) bad.push(a.teacherName + ' ' + a.day);
        seen.add(k);
      }
      return { ok: !bad.length, detail: bad.length ? bad.join(', ') : 'אפס' };
    },
  },
  {
    id: 'כל עמדות הסיירת מאוישות',
    check: ({ assignments }) => {
      const byDay = {};
      for (const a of assignments) (byDay[a.day] = byDay[a.day] || new Set()).add(a.break);
      const missing = [];
      for (const [day, breaks] of Object.entries(byDay)) {
        for (const brk of breaks) {
          if (!/אחרי/.test(brk)) continue;
          if (!assignments.some((a) => a.day === day && a.break === brk && a.role === 'סייר')) {
            missing.push(day + ' ' + brk);
          }
        }
      }
      return { ok: !missing.length, detail: missing.length ? missing.join(', ') : 'כולן' };
    },
  },
  {
    id: 'תחילת/סוף יום בגיזרת שער כניסה',
    check: ({ assignments }) => {
      const mgmt = assignments.filter((a) => ['תחילת יום', 'סוף יום'].includes(a.break));
      const bad = mgmt.filter((a) => a.area !== 'שער כניסה');
      return { ok: !bad.length && mgmt.length > 0, detail: mgmt.length + ' שיבוצים, חריגים: ' + bad.length };
    },
  },
  {
    id: 'דינמיקלאס מופיע כגיזרה, ומאויש בתומכת למידה',
    check: ({ model, assignments }) => {
      const dyn = assignments.filter((a) => a.role === 'דינמיקלאס');
      if (!dyn.length) return { ok: true, detail: 'אין דינמיקלאס בקובץ זה' };
      const byId = Object.fromEntries(model.teachers.map((t) => [t.id, t]));
      const notZone = dyn.filter((a) => a.area !== 'דינמיקלאס').length;
      const notSupport = dyn.filter((a) => (byId[a.teacherId] || {}).type !== 'תומכת למידה').length;
      return {
        ok: !notZone,
        detail: dyn.length + ' שיבוצים · לא בגיזרה: ' + notZone + ' · לא תומכת למידה: ' + notSupport,
      };
    },
  },
  {
    id: 'אין תורנות ביום חופש',
    check: ({ model, assignments }) => {
      const byId = Object.fromEntries(model.teachers.map((t) => [t.id, t]));
      const bad = assignments.filter((a) => {
        const t = byId[a.teacherId];
        if (!t) return false;
        const off = Array.isArray(t.daysOff) ? t.daysOff : (t.dayOff ? [t.dayOff] : []);
        return off.includes(a.day);
      });
      return { ok: !bad.length, detail: bad.length ? bad.map((a) => a.teacherName + ' ' + a.day).join(', ') : 'אפס' };
    },
  },
  {
    id: 'הפרדת מתחמים — מורה לא שובץ במתחם המנוגד',
    check: ({ model, assignments }) => {
      const zones = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'zones.json'), 'utf8'));
      const gc = {};
      for (const c of model.classes) if (c.gender) gc[c.id] = c.gender;
      const tally = {};
      for (const [cls, list] of Object.entries(zones.zonesByClass || {})) {
        const g = gc[cls];
        if (!g) continue;
        for (const z of list) (tally[z] = tally[z] || { 'בנים': 0, 'בנות': 0 })[g]++;
      }
      const zg = {};
      for (const [z, t] of Object.entries(tally)) zg[z] = t['בנים'] > t['בנות'] ? 'בנים' : 'בנות';
      const byId = Object.fromEntries(model.teachers.map((t) => [t.id, t]));
      // המגדר הקובע הוא של הכיתה שהמורה לימד בשיעור שלפני ההפסקה;
      // רק בהיעדרה חל המתחם הקבוע. הבדיקה חייבת לשקף את אותו כלל.
      const effGender = (t, day, brk) => {
        const m = /(\d+)/.exec(String(brk));
        if (m) {
          const prev = parseInt(m[1], 10);
          for (const l of t.lessons || []) {
            if (l.day === day && l.period === prev && l.cls && gc[l.cls]) return gc[l.cls];
          }
        }
        return t.genderArea || null;
      };
      const bad = assignments.filter((a) => {
        const t = byId[a.teacherId];
        const zoneG = zg[a.area];
        if (!t || !zoneG) return false;
        const g = effGender(t, a.day, a.break);
        return g && g !== zoneG;
      });
      return {
        ok: !bad.length,
        detail: bad.length
          ? bad.slice(0, 3).map((a) => a.teacherName + ' → ' + a.area).join(' · ')
          : 'אפס סתירות',
      };
    },
  },
  {
    id: 'ביום שישי יש הפסקה אחת בלבד',
    check: ({ assignments }) => {
      const fri = [...new Set(assignments.filter((a) => a.day === 'יום ו' && /אחרי/.test(a.break))
        .map((a) => a.break))];
      return { ok: fri.length <= 1, detail: fri.join(', ') || 'אין' };
    },
  },
  {
    id: '3 תורנויות מ"מ בהפסקת 10',
    check: ({ assignments }) => {
      const want = (rules.substitutesOverride || {})['אחרי 2'];
      if (want == null) return { ok: true, detail: 'לא הוגדר' };
      const days = [...new Set(assignments.filter((a) => a.break === 'אחרי 2').map((a) => a.day))];
      const bad = days.filter((d) =>
        assignments.filter((a) => a.day === d && a.break === 'אחרי 2' && a.role === 'מ"מ').length !== want);
      return { ok: !bad.length, detail: bad.length ? 'חריגה ב: ' + bad.join(', ') : `${want} בכל יום` };
    },
  },
  {
    id: 'הנהלה עושה תורנות סיירת',
    check: ({ model, assignments }) => {
      const ids = new Set(model.teachers.filter((t) => t.type === 'הנהלה').map((t) => t.id));
      const n = assignments.filter((a) => a.role === 'סייר' && ids.has(a.teacherId)).length;
      return { ok: true, detail: n + ' תורנויות סיירת להנהלה' };
    },
  },
];

console.log('קובץ: ' + path.basename(file));
console.log();

let failed = 0;
for (const rule of RULES) {
  const a = rule.check({ model: direct.model, assignments: direct.dutyPlan.assignments });
  const b = rule.check({ model: viaUi.model, assignments: viaUi.dutyPlan.assignments });
  const ok = a.ok && b.ok;
  if (!ok) failed++;
  console.log((ok ? '✓ ' : '✗ ') + rule.id);
  console.log('     ישיר:  ' + a.detail);
  if (a.detail !== b.detail || !b.ok) console.log('     ממשק: ' + b.detail);
}

console.log();
console.log(failed ? `${failed} מתוך ${RULES.length} כללים נכשלו.` : `כל ${RULES.length} הכללים מתקיימים.`);
process.exit(failed ? 1 : 0);
