// בדיקת השינויים הידניים לאורך זמן: הסרה, החלפה, החלפה חוזרת על אותה
// עמדה, וביטול. הבאג שנתפס כאן — נעיצות ישנות שנערמו והוחלו לפני
// החדשות, כך שהחלפה שנייה על אותה עמדה "לא נתפסה".
//
//   node tools/check-edits.js [קובץ.xlsx]

const fs = require('fs');
const path = require('path');
const { runPipeline } = require('../src/engine/index.js');

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const file = process.argv[2] || path.join(HOME, 'Downloads', 'א- מערכת תחילת שנה.xlsx');
const buf = fs.readFileSync(file);

// מצב הממשק, בדיוק כמו ב-public/app.js.
function makeUi(assignments) {
  return {
    assignments,
    removed: [],
    pins: [],
    sameSlot(p, x) {
      return p.day === x.day && p.break === x.break
        && (p.area || null) === (x.area || null) && p.role === x.role
        && (p.idx == null || x.idx == null || p.idx === x.idx);
    },
    pin(slot, teacher) {
      this.pins = this.pins.filter((p) => !this.sameSlot(p, slot)
        && !(p.teacher === teacher && p.day === slot.day && p.break === slot.break));
      this.removed = this.removed.filter((b) => !(b.teacher === teacher
        && b.day === slot.day && b.break === slot.break));
      this.pins.push({
        teacher, day: slot.day, break: slot.break,
        area: slot.area || null, role: slot.role,
        idx: (slot.idx != null ? slot.idx : undefined), manual: true,
      });
    },
    remove(a) {
      this.pins = this.pins.filter((p) => !(p.teacher === a.teacherName
        && p.day === a.day && p.break === a.break));
      if (!this.removed.some((b) => b.teacher === a.teacherName
        && b.day === a.day && b.break === a.break)) {
        this.removed.push({ teacher: a.teacherName, day: a.day, break: a.break });
      }
    },
    run() {
      const isRemoved = (x) => this.removed.some((b) =>
        b.teacher === x.teacherName && b.day === x.day && b.break === x.break);
      const pinned = this.pins.concat(this.assignments.filter((x) => !isRemoved(x))
        .map((x) => ({ teacher: x.teacherName, day: x.day, break: x.break, area: x.area, role: x.role })));
      this.assignments = runPipeline(buf, { blocked: this.removed, pinned }).dutyPlan.assignments;
      return this.assignments;
    },
  };
}

const base = runPipeline(buf, {}).dutyPlan.assignments;
const names = [...new Set(base.map((a) => a.teacherName))];
const at = (list, s) => list.filter((z) => z.day === s.day && z.break === s.break
  && z.area === s.area && z.role === s.role).map((z) => z.teacherName);

const CASES = [
  {
    // שתי עמדות מ"מ באותה הפסקה נראות זהות. בלי מספר סידורי, שיבוץ
    // לעמדה השנייה מחק את השיבוץ לראשונה מרשימת השינויים הידניים.
    name: 'שתי עמדות זהות באותה הפסקה — שני השיבוצים נשמרים',
    run: () => {
      const first = runPipeline(buf, {});
      const gaps = (first.dutyPlan.unfilled || [])
        .filter((u) => !u.area)
        .filter((u, i, arr) => arr.filter((v) => v.day === u.day
          && v.break === u.break && v.role === u.role).length > 1);
      if (gaps.length < 2) return { ok: true, detail: 'אין בקובץ שתי עמדות זהות ריקות' };
      const ui = makeUi(first.dutyPlan.assignments.slice());
      // כל מועמד שההנהלה יכולה לבחור מהחלון, גם אם יש לצדו סיבת פסילה.
      const pick = (u) => (u.candidates || []).map((c) => c.rawName);
      const a = pick(gaps[0])[0];
      const b = pick(gaps[1]).find((n) => n !== a);
      if (!a || !b) return { ok: true, detail: 'אין שני מועמדים בקובץ' };
      ui.pin(gaps[0], a);
      ui.pin(gaps[1], b);
      const out = ui.run();
      const there = out.filter((z) => z.day === gaps[0].day && z.break === gaps[0].break
        && z.role === gaps[0].role).map((z) => z.teacherName);
      return {
        ok: ui.pins.length === 2 && there.includes(a) && there.includes(b),
        detail: ui.pins.length + ' נעיצות נשמרו · בעמדות: ' + there.join(', '),
      };
    },
  },
  {
    name: 'החלפה אחת תופסת',
    run: () => {
      const ui = makeUi(base.slice());
      const slot = base.find((a) => a.role === 'חצר');
      const busy = new Set(base.filter((x) => x.day === slot.day && x.break === slot.break)
        .map((x) => x.teacherName));
      const to = names.find((n) => !busy.has(n));
      ui.remove(slot); ui.pin(slot, to);
      const out = ui.run();
      return { ok: at(out, slot).includes(to), detail: to + ' → ' + at(out, slot).join(', ') };
    },
  },
  {
    name: 'החלפה שנייה על אותה עמדה גוברת על הראשונה',
    run: () => {
      const ui = makeUi(base.slice());
      const slot = base.find((a) => a.role === 'חצר');
      const busy = new Set(base.filter((x) => x.day === slot.day && x.break === slot.break)
        .map((x) => x.teacherName));
      const free = names.filter((n) => !busy.has(n));
      const [first, second] = free;
      ui.remove(slot); ui.pin(slot, first); ui.run();
      const cur = ui.assignments.find((z) => z.day === slot.day && z.break === slot.break
        && z.area === slot.area && z.role === slot.role);
      ui.remove(cur); ui.pin(slot, second);
      const out = ui.run();
      const got = at(out, slot);
      return {
        ok: got.includes(second) && !got.includes(first),
        detail: first + ' ואז ' + second + ' → ' + got.join(', '),
      };
    },
  },
  {
    name: 'ביטול הסרה מחזיר את התורן',
    run: () => {
      const ui = makeUi(base.slice());
      const slot = base.find((a) => a.role === 'חצר');
      const who = slot.teacherName;
      ui.remove(slot); ui.run();
      const taken = at(ui.assignments, slot).join(', ');
      // "בטל" בממשק — מסיר את החסימה ומחזיר את התורן המקורי לעמדתו.
      ui.removed = ui.removed.filter((b) => b.teacher !== who);
      ui.pin(slot, who);
      const out = ui.run();
      return {
        ok: at(out, slot).includes(who),
        detail: 'במקומו נכנס ' + (taken || 'איש') + ', ואחרי ביטול: ' + at(out, slot).join(', '),
      };
    },
  },
  {
    name: 'שיבוץ חוזר של מי שהוסר — בלי לבטל ידנית',
    run: () => {
      const ui = makeUi(base.slice());
      const slot = base.find((a) => a.role === 'חצר');
      const who = slot.teacherName;
      ui.remove(slot); ui.run();
      ui.pin(slot, who);        // מתחרטת ומחזירה אותו
      const out = ui.run();
      return {
        ok: at(out, slot).includes(who) && !ui.removed.some((b) => b.teacher === who),
        detail: who + ' → ' + at(out, slot).join(', '),
      };
    },
  },
  {
    name: 'חמש החלפות רצופות — כל אחת נתפסת',
    run: () => {
      const ui = makeUi(base.slice());
      const slot = base.find((a) => a.role === 'חצר');
      const bad = [];
      for (let k = 0; k < 5; k++) {
        const cur = ui.assignments.find((z) => z.day === slot.day && z.break === slot.break
          && z.area === slot.area && z.role === slot.role);
        const busy = new Set(ui.assignments.filter((x) => x.day === slot.day && x.break === slot.break)
          .map((x) => x.teacherName));
        const to = names.filter((n) => !busy.has(n))[k];
        if (!to) break;
        if (cur) ui.remove(cur);
        ui.pin(slot, to);
        const out = ui.run();
        if (!at(out, slot).includes(to)) bad.push('סבב ' + (k + 1) + ': ' + to + ' לא נתפס');
      }
      return { ok: !bad.length, detail: bad.length ? bad.join(' · ') : 'כל חמשת הסבבים נתפסו' };
    },
  },
];

console.log('קובץ: ' + path.basename(file));
console.log();
let failed = 0;
for (const c of CASES) {
  const r = c.run();
  if (!r.ok) failed++;
  console.log((r.ok ? '✓ ' : '✗ ') + c.name);
  console.log('     ' + r.detail);
}
console.log();
console.log(failed ? `${failed} מתוך ${CASES.length} נכשלו.` : `כל ${CASES.length} מקרי העריכה עובדים.`);
process.exit(failed ? 1 : 0);
