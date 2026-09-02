// בדיקת ההחלפה הידנית: גרירת תורן מתא לתא חייבת לתפוס בכל המקרים —
// בין ימים שונים, בין הפסקות באותו יום, ובתוך אותה הפסקה עצמה.
//
//   node tools/check-swap.js [קובץ.xlsx]

const fs = require('fs');
const path = require('path');
const { runPipeline } = require('../src/engine/index.js');

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const file = process.argv[2] || path.join(HOME, 'Downloads', 'א- מערכת תחילת שנה.xlsx');
const buf = fs.readFileSync(file);

const base = runPipeline(buf, {});
const A = base.dutyPlan.assignments;

// מדמה בדיוק את מה שהממשק שולח בגרירה.
function swap(x, y) {
  const blocked = [
    { teacher: x.teacherName, day: x.day, break: x.break },
    { teacher: y.teacherName, day: y.day, break: y.break },
  ];
  const manualPins = [
    { teacher: y.teacherName, day: x.day, break: x.break, area: x.area, role: x.role, manual: true },
    { teacher: x.teacherName, day: y.day, break: y.break, area: y.area, role: y.role, manual: true },
  ];
  const pinned = manualPins.concat(
    A.filter((z) => z !== x && z !== y)
      .map((z) => ({ teacher: z.teacherName, day: z.day, break: z.break, area: z.area, role: z.role })));

  const out = runPipeline(buf, { blocked, pinned }).dutyPlan.assignments;
  const at = (s) => out
    .filter((z) => z.day === s.day && z.break === s.break && z.area === s.area && z.role === s.role)
    .map((z) => z.teacherName);
  return {
    ok: at(x).includes(y.teacherName) && at(y).includes(x.teacherName),
    got: at(x).join(', ') + '  ↔  ' + at(y).join(', '),
    changed: out.filter((z) => !A.some((o) =>
      o.day === z.day && o.break === z.break && o.area === z.area
      && o.role === z.role && o.teacherName === z.teacherName)).length,
  };
}

const yardOf = (pred) => A.find((z) => z.role === 'חצר' && pred(z));

const CASES = [
  {
    name: 'בין ימים שונים',
    pick: () => {
      const x = yardOf(() => true);
      const y = yardOf((z) => z.day !== x.day);
      return [x, y];
    },
  },
  {
    name: 'בין הפסקות באותו יום',
    pick: () => {
      const x = yardOf(() => true);
      const y = yardOf((z) => z.day === x.day && z.break !== x.break);
      return [x, y];
    },
  },
  {
    name: 'בתוך אותה הפסקה (גיזרות שונות)',
    pick: () => {
      const x = yardOf(() => true);
      const y = yardOf((z) => z.day === x.day && z.break === x.break && z.area !== x.area);
      return [x, y];
    },
  },
  {
    name: 'בין חצר למ"מ באותה הפסקה',
    pick: () => {
      const x = yardOf(() => true);
      const y = A.find((z) => z.day === x.day && z.break === x.break && z.role === 'מ"מ');
      return [x, y];
    },
  },
];

console.log('קובץ: ' + path.basename(file));
console.log();

let failed = 0;
for (const c of CASES) {
  const [x, y] = c.pick();
  if (!x || !y) { console.log('– ' + c.name + ' — אין זוג מתאים בקובץ'); continue; }
  const r = swap(x, y);
  if (!r.ok) failed++;
  console.log((r.ok ? '✓ ' : '✗ ') + c.name);
  console.log(`     ${x.teacherName}  ↔  ${y.teacherName}`);
  console.log(`     אחרי: ${r.got}   (${r.changed} שיבוצים השתנו)`);
}

console.log();
console.log(failed ? `${failed} מתוך ${CASES.length} מקרים נכשלו.` : `כל ${CASES.length} מקרי ההחלפה עובדים.`);
process.exit(failed ? 1 : 0);
