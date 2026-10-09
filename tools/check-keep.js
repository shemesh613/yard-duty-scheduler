// בדיקת שמירת העבודה: שיבוץ ידני של מי שאינו נוכח, שיבוץ שנושר כשהמורה הפך לפטור,
// והעדפת הלוח הקודם בלוח חדש. מריצה את המנוע על קובץ המערכת שבפרויקט.
const path = require('path');
const { runPipeline } = require('../src/engine/index.js');

const file = path.join(__dirname, '..', 'מערכת א תמוז.xlsx');
let bad = 0;
const ok = (cond, msg) => { console.log((cond ? '✓ ' : '✗ ') + msg); if (!cond) bad++; };
const key = (a) => a.teacherName + '|' + a.day + '|' + a.break;

const base = runPipeline(file, {}).dutyPlan;
const A = base.assignments;

// 1. עמדה ריקה: כל אנשי הצוות ברשימה, ומי שלא נוכח מסומן עם הסבר ובסוף הרשימה
const u = base.unfilled[0];
if (u) {
  const absent = u.candidates.filter((c) => c.absent);
  ok(absent.length > 0 && absent.every((c) => c.reason), 'עמדה ריקה: מי שפטור או לא עובד ביום הזה מופיע עם הסבר');
  const rank = u.candidates.map((c) => (c.absent ? 3 : !c.reason ? 0 : c.soft ? 1 : 2));
  ok(rank.every((v, i) => i === 0 || rank[i - 1] <= v), 'עמדה ריקה: הפנויים קודם, מי שלא נוכח אחרון');
}

// 2. מורה שהוגדר פטור: שיבוץ אוטומטי נושר, שיבוץ ידני נשאר
const a1 = A[1], a2 = A[2];
const res = runPipeline(file, {
  teachers: { [a1.teacherName]: { noDuty: true }, [a2.teacherName]: { noDuty: true } },
  pinned: [
    { teacher: a1.teacherName, day: a1.day, break: a1.break, role: a1.role, area: a1.area },
    { teacher: a2.teacherName, day: a2.day, break: a2.break, role: a2.role, area: a2.area, manual: true },
  ],
}).dutyPlan.assignments;
const has = (a) => res.some((x) => x.teacherName === a.teacherName && x.day === a.day && x.break === a.break);
ok(!has(a1), 'מורה שהוגדר פטור: השיבוץ האוטומטי שלו הוסר');
ok(has(a2), 'מורה שהוגדר פטור: שיבוץ שנקבע ידנית נשאר');

// 3. לוח חדש דומה ללוח הקודם
const names = [...new Set(A.map((a) => a.teacherName))];
const victims = names.slice(0, 3);
const gone = new Set(victims);
const keepable = new Set(A.filter((a) => !gone.has(a.teacherName)).map(key));
const pert = { removedTeachers: victims, teachers: { [names[20]]: { daysOff: ['יום ב'] }, [names[21]]: { daysOff: ['יום ד'] } } };
const prev = A.map((a) => ({ teacher: a.teacherName, day: a.day, break: a.break, role: a.role, area: a.area }));
const same = (L) => L.filter((a) => keepable.has(key(a))).length;
const without = same(runPipeline(file, pert).dutyPlan.assignments);
const withPref = same(runPipeline(file, Object.assign({}, pert, { preferred: prev })).dutyPlan.assignments);
ok(withPref > without, 'לוח חדש דומה יותר לקודם עם העדפה (' + withPref + ' לעומת ' + without + ' שיבוצים זהים)');

console.log(bad ? '\n' + bad + ' בעיות.' : '\nהכול תקין.');
process.exit(bad ? 1 : 0);
