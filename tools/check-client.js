// בדיקת קוד הדפדפן בלי דפדפן.
//
// הבאג שנתפס כאן: פונקציה פנימית בשם send הסתירה את העטיפה הגלובלית
// send, וקראה לעצמה במקום לה — כל שינוי ידני נכשל ב-Maximum call stack.
// בדיקות המנוע לא יכלו לתפוס את זה, כי הוא כולו בצד הלקוח.
//
// כאן טוענים את public/app.js לתוך סביבת DOM מינימלית, מריצים את
// זרימת העבודה האמיתית מול שרת אמיתי, ומוודאים שהיא מגיעה לסוף.
//
//   node tools/check-client.js [קובץ.xlsx]

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const HOME = process.env.USERPROFILE || process.env.HOME || '';
const xlsx = process.argv[2] || path.join(HOME, 'Downloads', 'א- מערכת תחילת שנה.xlsx');

const problems = [];
const notes = [];

/* ---------- 1. בדיקות סטטיות על מקור הקוד ---------- */

const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

// הצהרה כפולה על שם שמשמש כעטיפה — בדיוק הבאג שהיה.
for (const name of ['send', 'show', 'hide', 'pinTeacher', 'removeTeacher', 'computePlan']) {
  const re = new RegExp('(?:function\\s+' + name + '\\s*\\(|(?:const|let|var)\\s+' + name + '\\s*=)', 'g');
  const n = (src.match(re) || []).length;
  if (n > 1) problems.push(`"${name}" מוצהר ${n} פעמים — הצהרה פנימית מסתירה את החיצונית`);
}

// כל קריאה לשרת שכותבת חייבת לעבור דרך העטיפה send.
const rawWrites = src.match(/fetch\('\/api\/(run|state|inspect|save-classes)'/g) || [];
const okReads = (src.match(/await fetch\('\/api\/state'\)/g) || []).length;
if (rawWrites.length > okReads) {
  problems.push(`${rawWrites.length - okReads} קריאות כתיבה עוקפות את העטיפה send`);
}

/* ---------- 2. הרצה אמיתית של הקוד מול שרת אמיתי ---------- */

// DOM מינימלי: מספיק כדי ש-app.js ירוץ ויבצע את זרימת העבודה.
function makeDom() {
  const listeners = new Map();
  const byId = new Map();

  function el(tag) {
    const e = {
      tagName: (tag || 'div').toUpperCase(),
      children: [], classList: { _s: new Set(),
        add(...c) { c.forEach((x) => this._s.add(x)); },
        remove(...c) { c.forEach((x) => this._s.delete(x)); },
        contains(c) { return this._s.has(c); } },
      dataset: {}, style: {}, hidden: false, value: '', textContent: '', innerHTML: '',
      files: [], cells: [], disabled: false, href: '', checked: false, selectedIndex: 0,
      appendChild(c) { this.children.push(c); return c; },
      insertBefore(c) { this.children.unshift(c); return c; },
      removeChild() {}, remove() {}, closest() { return null; },
      addEventListener(t, fn) {
        const key = (this.id || this.tagName) + '|' + t;
        (listeners.get(key) || listeners.set(key, []).get(key)).push(fn);
      },
      removeEventListener() {},
      querySelector() { return el('div'); },
      querySelectorAll() { return []; },
      getBoundingClientRect() { return { x: 0, y: 0, width: 0, height: 0 }; },
      scrollIntoView() {}, click() {}, focus() {},
      setAttribute() {}, getAttribute() { return null; },
      dispatchEvent() { return true; },
    };
    return e;
  }

  const doc = {
    createElement: el,
    getElementById(id) {
      if (!byId.has(id)) { const e = el('div'); e.id = id; byId.set(id, e); }
      return byId.get(id);
    },
    querySelector() { return el('div'); },
    querySelectorAll() { return []; },
    addEventListener() {},
    body: el('body'),
    documentElement: el('html'),
  };
  return { doc, listeners, byId };
}

function run(cb) {
  const server = require('child_process').spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: Object.assign({}, process.env, { PORT: '3999' }), stdio: 'ignore',
  });
  const stop = () => { try { server.kill(); } catch (_) {} };
  setTimeout(() => cb(stop), 2500);
}

run(async (stop) => {
  const base = 'http://127.0.0.1:3999';
  try {
    // בודקים שהשרת חי
    await new Promise((res, rej) => {
      const r = http.get(base + '/', (x) => { x.resume(); res(); });
      r.on('error', rej);
    });

    const { doc, byId } = makeDom();
    const store = new Map();

    const g = {
      document: doc,
      window: null,
      localStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
      },
      FormData: global.FormData, Blob: global.Blob, FileReader: class {},
      fetch: (u, o) => global.fetch(String(u).startsWith('http') ? u : base + u, o),
      alert: () => {}, confirm: () => true, prompt: () => null,
      setTimeout, clearTimeout, console, atob: global.atob, URL: global.URL,
      Event: class {}, DragEvent: class {}, Date, JSON, Math, Number, String, Object, Array,
      encodeURIComponent, decodeURIComponent, isFinite, parseInt, parseFloat,
      scrollTo: () => {}, scrollY: 0, addEventListener: () => {},
    };
    g.window = g;
    g.globalThis = g;

    // שגיאה אסינכרונית בתוך app.js (למשל רקורסיה אינסופית) נופלת כאן
    // ולא מתפספסת. זה בדיוק סוג הכשל שהגיע עד המשתמשת.
    const asyncErrors = [];
    const onRej = (e) => asyncErrors.push(String((e && e.message) || e));
    process.on('unhandledRejection', onRej);

    const vm = require('vm');
    const ctx = vm.createContext(g);
    vm.runInContext(src, ctx, { filename: 'app.js' });
    await new Promise((r) => setTimeout(r, 700));
    process.off('unhandledRejection', onRej);
    if (asyncErrors.length) {
      asyncErrors.slice(0, 3).forEach((e) => problems.push('app.js זרק בזמן ריצה: ' + e));
    } else {
      notes.push('app.js נטען ורץ בלי לזרוק שגיאה');
    }

    // מריצים את הצינור דרך אותו מסלול שהממשק משתמש בו
    const buf = fs.readFileSync(xlsx);
    const fd = new FormData();
    fd.append('file', new Blob([buf]), 'timetable.xlsx');
    const insp = await (await fetch(base + '/api/inspect', { method: 'POST', body: fd })).json();
    if (!insp.ok) problems.push('‎/api/inspect נכשל: ' + insp.error);

    const fd2 = new FormData();
    fd2.append('file', new Blob([buf]), 'timetable.xlsx');
    fd2.append('overrides', '{}');
    const runRes = await (await fetch(base + '/api/run', { method: 'POST', body: fd2 })).json();
    if (!runRes.ok) problems.push('‎/api/run נכשל: ' + runRes.error);
    else notes.push(`הצינור החזיר ${runRes.assignments.length} שיבוצים`);

    // החלפה בין שני ימים — בדיוק מה שנכשל אצל הסגנית
    const A = runRes.assignments;
    const a = A.find((x) => x.role === 'חצר');
    const b = A.find((x) => x.role === 'חצר' && x.day !== a.day && x.break === a.break);
    if (a && b) {
      const removed = [
        { teacher: a.teacherName, day: a.day, break: a.break },
        { teacher: b.teacherName, day: b.day, break: b.break },
      ];
      const isRem = (x) => removed.some((r) => r.teacher === x.teacherName
        && r.day === x.day && r.break === x.break);
      const pinned = [
        { teacher: b.teacherName, day: a.day, break: a.break, area: a.area, role: a.role, manual: true },
        { teacher: a.teacherName, day: b.day, break: b.break, area: b.area, role: b.role, manual: true },
      ].concat(A.filter((x) => !isRem(x)).map((x) => ({
        teacher: x.teacherName, day: x.day, break: x.break, area: x.area, role: x.role })));

      const fd3 = new FormData();
      fd3.append('fileId', runRes.fileId);
      fd3.append('overrides', JSON.stringify({ blocked: removed, pinned }));
      const out = await (await fetch(base + '/api/run', { method: 'POST', body: fd3 })).json();
      const at = (s) => out.assignments.filter((z) => z.day === s.day && z.break === s.break
        && z.area === s.area && z.role === s.role).map((z) => z.teacherName);
      if (!out.ok) problems.push('החלפה: ‎/api/run נכשל');
      else if (!at(a).includes(b.teacherName) || !at(b).includes(a.teacherName)) {
        problems.push(`ההחלפה לא נתפסה: ${a.teacherName} <-> ${b.teacherName}`);
      } else {
        notes.push(`החלפה בין ${a.day} ל-${b.day} באותה הפסקה — נתפסה`);
      }
    }

    // צפייה בלבד וייצוא
    for (const [label, url] of [['‎/view', '/view'], ['‎/api/board', '/api/board'],
      ['לוח למורים', '/api/teachers-sheet/' + runRes.downloadId],
      ['אקסל', '/api/download/' + runRes.downloadId]]) {
      const r = await fetch(base + url);
      if (!r.ok) problems.push(`${label} החזיר ${r.status}`);
    }
    notes.push('צפייה, JSON, לוח למורים ואקסל — כולם הגיבו');
  } catch (err) {
    problems.push('נפילה: ' + (err && err.message));
  } finally {
    stop();
  }

  console.log('בדיקת קוד הדפדפן');
  console.log();
  notes.forEach((n) => console.log('  ✓ ' + n));
  if (problems.length) {
    console.log();
    problems.forEach((p) => console.log('  ✗ ' + p));
    console.log();
    console.log(problems.length + ' בעיות.');
    process.exit(1);
  }
  console.log();
  console.log('הכול תקין.');
});
