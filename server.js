// שרת Express — אפליקציית הווב להעלאת קובץ מערכת שעות והרצת המנוע.
// בעלות סוכן 5 בלבד. אינו נוגע ב-src/engine או config.
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { renderDecisions } = require('./src/decisions-page.js');

// טעינת המנוע נעשית בעצלתיים (lazy): ייתכן שמודולי מנוע (למשל duty.js)
// עדיין נבנים ע"י סוכנים אחרים. אם הטעינה נכשלת — השרת עדיין עולה,
// ו-GET / עובד; רק /api/run יחזיר שגיאה מטופלת.
function loadRunPipeline() {
  // ניקוי מטמון require כדי לאפשר טעינה מחדש לאחר שהמודול החסר נוסף
  try {
    delete require.cache[require.resolve('./src/engine/index.js')];
  } catch (_) { /* טרם נטען */ }
  return require('./src/engine/index.js').runPipeline;
}

// טעינת שכבת הפירוק/הסקה בלבד — לצורך מסך ההגדרות (בלי לחשב לוחות).
function loadInspect() {
  const parse = require('./src/engine/parse.js');
  const infer = require('./src/engine/infer.js');
  return { parse, infer };
}

// פירוק שדה overrides מטופס multipart (מגיע כמחרוזת JSON). מחזיר {} אם ריק/לא תקין.
function parseOverrides(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

const app = express();
const PORT = process.env.PORT || 3000;

// תיקיות עבודה
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'output');
const PUBLIC_DIR = path.join(__dirname, 'public');
for (const dir of [UPLOAD_DIR, OUTPUT_DIR]) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* קיים */ }
}

// אחסון קבצים שהועלו ל-uploads/ עם שם ייחודי
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const id = crypto.randomBytes(8).toString('hex');
    cb(null, `${id}.xlsx`);
  }
});
const upload = multer({ storage });

// קבצים סטטיים מ-public/.
// ללא מטמון: אחרת הדפדפן ממשיך להריץ גרסה ישנה של app.js/style.css
// גם אחרי עדכון, והמסך מראה תוצאות שאינן תואמות את המערכת.
app.use(express.static(PUBLIC_DIR, {
  // index:false — כדי ש-"/" יעבור למסלול שלנו, שמוסיף חותמת גרסה לנכסים.
  index: false,
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
  },
}));

// חותמת גרסה — זמן השינוי האחרון של קבצי הממשק.
// מוצמדת לכתובות app.js ו-style.css כדי שהדפדפן לא יריץ גרסה ישנה.
function uiVersion() {
  let newest = 0;
  for (const f of ['app.js', 'style.css', 'index.html']) {
    try {
      const t = fs.statSync(path.join(PUBLIC_DIR, f)).mtimeMs;
      if (t > newest) newest = t;
    } catch (_) { /* קובץ חסר */ }
  }
  return String(Math.floor(newest));
}

/* ---------------- הגנת עריכה (אופציונלית) ----------------
   כברירת מחדל אין הגנה, והמערכת מתנהגת בדיוק כמו קודם. אם מוגדר
   משתנה סביבה EDIT_KEY, כל פעולה שכותבת משהו — העלאת קובץ, חישוב,
   שמירה או מחיקה — דורשת אותו. צפייה בלבד (‎/view, ‎/api/board)
   נשארת פתוחה תמיד. */

const EDIT_KEY = String(process.env.EDIT_KEY || '').trim();

function requireEditKey(req, res, next) {
  if (!EDIT_KEY) return next();
  // כותרות HTTP אינן נושאות תווים שאינם אנגליים, ולכן הסיסמה נשלחת
  // מקודדת. משווים גם לערך המפוענח, כדי שסיסמה בעברית תעבוד גם היא.
  const raw = String(req.get('x-edit-key') || req.query.key || '').trim();
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch (_) { /* לא מקודד */ }
  if (raw === EDIT_KEY || decoded === EDIT_KEY) return next();
  return res.status(401).json({
    ok: false,
    needKey: true,
    error: 'העריכה מוגנת בסיסמה. הזינו את סיסמת העריכה כדי להמשיך.',
  });
}

// GET / → מגיש את עמוד הממשק, עם חותמת גרסה על הנכסים
app.get('/', (req, res) => {
  try {
    const v = uiVersion();
    const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
      .replace('href="style.css"', 'href="style.css?v=' + v + '"')
      .replace('src="app.js"', 'src="app.js?v=' + v + '"')
      .replace('</footer>', '<p class="version">גרסה ' + v.slice(-6) + '</p></footer>');
    res.type('html').send(html);
  } catch (err) {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  }
});

// POST /api/run — קבלת קובץ אקסל, הרצת הצינור, החזרת סיכום + HTML + מזהה הורדה
app.post('/api/run', requireEditKey, upload.single('file'), (req, res) => {
  try {
    // הקובץ מגיע בהעלאה, או לפי מזהה של קובץ שכבר הועלה — כדי שאפשר יהיה
    // לחשב מחדש אחרי שחזור מצב שמור, בלי להעלות שוב.
    let buffer;
    let fileId;
    if (req.file) {
      buffer = fs.readFileSync(req.file.path);
      fileId = path.basename(req.file.path, '.xlsx');
    } else {
      const id = String((req.body && req.body.fileId) || '').replace(/[^a-zA-Z0-9]/g, '');
      const p = id && path.join(UPLOAD_DIR, `${id}.xlsx`);
      if (!p || !fs.existsSync(p)) {
        return res.status(400).json({
          ok: false,
          error: 'לא התקבל קובץ. ודאו שבחרתם קובץ אקסל (.xlsx) והעלו שוב.'
        });
      }
      buffer = fs.readFileSync(p);
      fileId = id;
    }

    // הרצת המנוע (אורקסטרטור) — נטען בעצלתיים כדי לעמוד גם כשמודול עדיין חסר
    const overrides = parseOverrides(req.body && req.body.overrides);
    const runPipeline = loadRunPipeline();
    const result = runPipeline(buffer, overrides);
    const { model, dutyPlan, workbookBuffer, html, teacherHtml } = result || {};

    // שמירת קובץ האקסל לפלט עם מזהה הורדה
    const downloadId = crypto.randomBytes(8).toString('hex');
    if (workbookBuffer) {
      fs.writeFileSync(path.join(OUTPUT_DIR, `${downloadId}.xlsx`), workbookBuffer);
    }
    // שמירת הלוח למורים לצד האקסל, תחת אותו מזהה.
    if (teacherHtml) {
      fs.writeFileSync(path.join(OUTPUT_DIR, `${downloadId}.html`), teacherHtml, 'utf8');
    }

    // בניית סיכום מספרים מתוך תוצרי המנוע (לפי החוזה ב-SPEC)
    const summary = {
      teachers: (model && Array.isArray(model.teachers)) ? model.teachers.length : 0,
      classes: (model && Array.isArray(model.classes)) ? model.classes.length : 0,
      dutySlots: (dutyPlan && Array.isArray(dutyPlan.assignments)) ? dutyPlan.assignments.length : 0,
      violations: (dutyPlan && Array.isArray(dutyPlan.violations)) ? dutyPlan.violations.length : 0
    };

    return res.json({
      ok: true,
      summary,
      html: html || '',
      // רשימת השיבוצים — כדי שהממשק יוכל להציג טבלה ולאפשר הסרה ידנית.
      assignments: (dutyPlan && Array.isArray(dutyPlan.assignments)) ? dutyPlan.assignments : [],
      violations: (dutyPlan && Array.isArray(dutyPlan.violations)) ? dutyPlan.violations : [],
      // עמדות שלא אוישו, עם רשימת מועמדים וסיבת הפסילה לכל אחד.
      unfilled: (dutyPlan && Array.isArray(dutyPlan.unfilled)) ? dutyPlan.unfilled : [],
      // מצבת אנשי הצוות — שם, סוג, מכסה וספירות. הבסיס לדוח הבדיקה השמי.
      staff: (dutyPlan && dutyPlan.perTeacher) ? Object.values(dutyPlan.perTeacher) : [],
      fileId,
      downloadId: workbookBuffer ? downloadId : null
    });
  } catch (err) {
    // שגיאה מטופלת — לא מתרסקים. הודעה ידידותית בעברית + פירוט טכני קצר.
    console.error('שגיאה בהרצת הצינור:', err && err.stack ? err.stack : err);
    const detail = (err && err.message) ? String(err.message) : 'שגיאה לא ידועה';
    return res.status(500).json({
      ok: false,
      error: 'אירעה שגיאה בעיבוד הקובץ. ייתכן שהפורמט אינו תקין או שרכיב במערכת עדיין אינו זמין.',
      detail
    });
  }
});

// POST /api/inspect — פירוק הקובץ והסקת מטא-דאטה בלבד (בלי חישוב לוחות),
// כדי לאכלס את מסך ההגדרות הויזואלי. מחזיר רשימת מורים וכיתות עם הערכים שהוסקו.
app.post('/api/inspect', requireEditKey, upload.single('file'), (req, res) => {
  try {
    let buffer, fileId;
    if (req.file) {
      buffer = fs.readFileSync(req.file.path);
      fileId = path.basename(req.file.path, '.xlsx');
    } else {
      const id = String((req.body && req.body.fileId) || '').replace(/[^a-zA-Z0-9]/g, '');
      const p = id && path.join(UPLOAD_DIR, `${id}.xlsx`);
      if (!p || !fs.existsSync(p)) {
        return res.status(400).json({ ok: false, error: 'לא התקבל קובץ.' });
      }
      buffer = fs.readFileSync(p);
      fileId = id;
    }
    const { parse, infer } = loadInspect();
    const raw = parse.parseWorkbook(buffer);
    // מסך ההגדרות מציג את הערכים לאחר החלת מיקומים(מגדר) + config/overrides.json (הנהלה וכו').
    const eng = require('./src/engine/index.js');
    const locOv = eng.deriveGenderOverrides(raw, eng.loadLocations());
    const baseOv = eng.mergeOverrides(locOv, eng.loadFileOverrides());
    // ימי החופש שברירת המחדל לפי סוג — אחרת המסך מציג תיבות ריקות,
    // ובחישוב הוא שולח בחזרה "אין ימי חופש" ומבטל את ההגדרה.
    baseOv.defaultDaysOffByType = eng.loadRules().defaultDaysOffByType || {};
    const model = infer.buildModel(raw, baseOv);

    // פילוח השיעורים של כל מורה לפי מגדר הכיתות — כדי להציג במסך את הנתון
    // שעליו מבוססת ההצעה, ולא רק את המסקנה.
    const genderOfClass = {};
    for (const c of model.classes || []) {
      if (c && c.id && c.gender) genderOfClass[c.id] = c.gender;
    }

    const teachers = (model.teachers || []).map((t) => {
      let boys = 0, girls = 0;
      for (const l of t.lessons || []) {
        const g = genderOfClass[l.cls];
        if (g === 'בנים') boys++;
        else if (g === 'בנות') girls++;
      }
      const total = boys + girls;
      return {
        name: t.name,
        type: t.type,
        noDuty: !!t.noDuty,
        genderArea: t.genderArea || null,
        boysLessons: boys,
        girlsLessons: girls,
        boysPercent: total ? Math.round((boys / total) * 100) : null,
        homeroomOf: t.homeroomOf || null,
        dayOff: t.dayOff || null,
        daysOff: Array.isArray(t.daysOff) ? t.daysOff : (t.dayOff ? [t.dayOff] : []),
        alwaysPresent: !!t.alwaysPresent,
        numDaysWorked: t.numDaysWorked,
        rabbi: !!t.rabbi,
      };
    });
    const classes = (model.classes || []).map((c) => ({
      id: c.id,
      gender: c.gender || null,
      homeroomTeacherId: c.homeroomTeacherId || null,
    }));

    return res.json({
      ok: true,
      meta: { days: model.meta.days || [], school: model.meta.school || '' },
      fileId,
      teachers,
      classes,
    });
  } catch (err) {
    console.error('שגיאה ב-inspect:', err && err.stack ? err.stack : err);
    return res.status(500).json({
      ok: false,
      error: 'אירעה שגיאה בקריאת הקובץ. ודאו שהפורמט תקין (כיתה/יום/שעה/מקצוע/מורה).',
      detail: (err && err.message) ? String(err.message) : '',
    });
  }
});

// ---------- שמירת מצב העבודה ----------
// הלוח וההגדרות נשמרים בשרת, כדי שיציאה מהאתר לא תמחק את העבודה.
// מצב אחד משותף — בית ספר אחד, מי שעורך רואה את מה שנשמר לאחרונה.
const STATE_FILE = path.join(OUTPUT_DIR, 'state.json');

// GET /api/state → המצב השמור, או null אם אין
app.get('/api/state', (req, res) => {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return res.json({ ok: true, state: JSON.parse(raw) });
  } catch (_) {
    return res.json({ ok: true, state: null });
  }
});

// POST /api/state → שמירת המצב הנוכחי
app.post('/api/state', requireEditKey, express.json({ limit: '8mb' }), (req, res) => {
  try {
    const state = (req.body && req.body.state) || null;
    if (!state) return res.status(400).json({ ok: false, error: 'לא התקבל מצב לשמירה.' });
    state.savedAt = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8');
    return res.json({ ok: true, savedAt: state.savedAt });
  } catch (err) {
    console.error('שגיאה בשמירת המצב:', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'לא הצלחנו לשמור.' });
  }
});

// DELETE /api/state → מחיקת המצב השמור
app.delete('/api/state', requireEditKey, (req, res) => {
  try { fs.unlinkSync(STATE_FILE); } catch (_) { /* לא קיים */ }
  return res.json({ ok: true });
});

// POST /api/save-classes — שמירת מגדר הכיתות לשנה הנוכחית.
// נכתב ל-config/classes.json ומשם גובר על כל זיהוי אוטומטי בהעלאות הבאות.
app.post('/api/save-classes', requireEditKey, express.json({ limit: '256kb' }), (req, res) => {
  try {
    const incoming = (req.body && req.body.genderByClass) || {};
    const clean = {};
    for (const [cls, g] of Object.entries(incoming)) {
      if (g !== 'בנים' && g !== 'בנות') continue;
      const id = String(cls).trim();
      if (id) clean[id] = g;
    }

    const p = path.join(__dirname, 'config', 'classes.json');
    let current = {};
    try { current = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { /* קובץ חדש */ }

    current.genderByClass = clean;
    current._updated = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(p, JSON.stringify(current, null, 2) + String.fromCharCode(10), 'utf8');

    return res.json({ ok: true, saved: Object.keys(clean).length });
  } catch (err) {
    console.error('שגיאה בשמירת הכיתות:', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'לא הצלחנו לשמור את ההגדרות.' });
  }
});

// GET /decisions → יומן ההחלטות, מוגש כדף קריא בדפדפן.
app.get('/decisions', (req, res) => {
  try {
    const md = fs.readFileSync(path.join(__dirname, 'DECISIONS.md'), 'utf8');
    res.type('html').send(renderDecisions(md));
  } catch (err) {
    res.status(404).send('קובץ התיעוד לא נמצא.');
  }
});

/* ---------------- צפייה בלבד ----------------
   שני מסלולים שאינם כותבים דבר: הם קוראים את הלוח האחרון שההנהלה
   שמרה ומחזירים אותו. אין בהם העלאה, חישוב, שמירה או מחיקה, ולכן
   אי אפשר לשנות או להרוס דרכם שום דבר — גם לא בטעות. */

function readSavedState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) { return null; }
}

// המודל המצומצם שדרוש לבניית הלוח, מתוך המצב השמור.
function modelFromState(st) {
  const insp = (st && st.inspectData) || {};
  // המצב השמור אינו נושא מזהי מורים — נותנים מזהה יציב לפי המיקום ברשימה,
  // כדי שגיליון הבקרה יידע לחבר בין מורה למכסה שלו.
  const teachers = (insp.teachers || []).map((t, i) =>
    (t && t.id != null) ? t : Object.assign({}, t, { id: 'n' + i }));
  return { meta: insp.meta || {}, classes: insp.classes || [], teachers };
}

// GET /view — דף צפייה בלבד בלוח האחרון. אותו עיצוב כמו "לוח למורים",
// כולל הכפתורים לשמירה כתמונה או כ-PDF.
app.get('/view', (req, res) => {
  const st = readSavedState();
  if (!st || !Array.isArray(st.assignments) || !st.assignments.length) {
    return res.status(404).type('html').send(
      '<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8">'
      + '<title>לוח תורנויות</title><style>body{font-family:Arial,sans-serif;'
      + 'padding:40px;text-align:center;color:#444}</style></head><body>'
      + '<h1>עדיין אין לוח מפורסם</h1>'
      + '<p>ההנהלה טרם שמרה לוח, או שהשרת עלה מחדש והלוח נטען מהדפדפן שלה בלבד.</p>'
      + '</body></html>');
  }
  try {
    const report = require('./src/engine/report.js');
    const html = report.buildBoardHtml(modelFromState(st), { assignments: st.assignments });
    const when = st.savedAt ? new Date(st.savedAt).toLocaleString('he-IL') : '';
    // באנר קבוע שמבהיר שזו צפייה בלבד, ומתי הלוח עודכן לאחרונה.
    const banner = '<div class="no-print" style="background:#eefbf0;border-color:#b6e3c1;'
      + 'color:#1d5b32"><strong>צפייה בלבד</strong>'
      + '<span class="hint">אי אפשר לשנות דבר מהעמוד הזה. '
      + (when ? 'הלוח עודכן לאחרונה ב-' + when + '. ' : '')
      + 'רענון העמוד מציג את הגרסה העדכנית.</span></div>';
    res.set('Cache-Control', 'no-store');
    return res.type('html').send(html.replace('<div class="no-print">', banner + '<div class="no-print">'));
  } catch (err) {
    console.error('שגיאה בבניית דף הצפייה:', err && err.stack ? err.stack : err);
    return res.status(500).type('html').send('<h1>שגיאה בהצגת הלוח</h1>');
  }
});

// GET /api/board — אותם נתונים כ-JSON, למי שרוצה להציג אותם באתר משלו.
// פתוח לקריאה מכל מקור (CORS), ואינו מקבל שום נתון.
app.get('/api/board', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'no-store');
  const st = readSavedState();
  if (!st || !Array.isArray(st.assignments)) {
    return res.json({ ok: true, published: false, board: null, assignments: [] });
  }
  try {
    const report = require('./src/engine/report.js');
    const model = modelFromState(st);
    const board = report.buildBoardData(model, { assignments: st.assignments });

    // תורנויות לפי איש צוות — הצורה הנוחה ביותר לאתר של איש צוות אחר.
    const byTeacher = {};
    for (const a of st.assignments) {
      (byTeacher[a.teacherName] = byTeacher[a.teacherName] || []).push({
        day: a.day, break: a.break, role: a.role, area: a.area || null,
      });
    }

    return res.json({
      ok: true,
      published: true,
      savedAt: st.savedAt || null,
      school: board.school,
      source: st.fileName || null,
      days: board.days,
      board: board.rows,
      assignments: st.assignments.map((a) => ({
        day: a.day, break: a.break, role: a.role, area: a.area || null, teacher: a.teacherName,
      })),
      byTeacher,
      unfilled: (st.unfilled || []).map((u) => ({
        day: u.day, break: u.break, role: u.role, area: u.area || null,
      })),
    });
  } catch (err) {
    console.error('שגיאה ב-/api/board:', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'שגיאה בבניית הלוח.' });
  }
});

/* הקבצים שנוצרו בהרצה נשמרים ב-output/, והדיסק של השרת החינמי נמחק
   בכל עלייה מחדש. במקום להחזיר "הקובץ לא נמצא", בונים אותם שוב מהלוח
   האחרון שנשמר. המשתמשת לא אמורה לדעת שהשרת עלה מחדש. */

function dutyPlanFromState(st) {
  const teachers = modelFromState(st).teachers;
  const idOf = {};
  for (const t of teachers) if (t && t.name != null) idOf[t.name] = t.id;
  const perTeacher = {};
  for (const x of (st.staff || [])) {
    const id = (x && x.id != null) ? x.id : idOf[x && x.name];
    if (id != null) perTeacher[id] = x;
  }
  return {
    assignments: st.assignments || [],
    perTeacher,
    violations: st.violations || [],
    unfilled: st.unfilled || [],
  };
}

const NO_BOARD = 'עדיין אין לוח שמור. היכנסו למערכת, ואם מוצע "שחזר" — לחצו עליו. '
  + 'לאחר מכן הקובץ ייווצר שוב.';

// GET /api/download/:id → הורדת קובץ האקסל מ-output/
app.get('/api/download/:id', (req, res) => {
  // אבטחה: רק תווים מותרים במזהה כדי למנוע מעבר נתיב
  const id = String(req.params.id || '').replace(/[^a-zA-Z0-9]/g, '');
  const filePath = path.join(OUTPUT_DIR, `${id}.xlsx`);
  if (!id || !fs.existsSync(filePath)) {
    // נמחק בעליית השרת — בונים מחדש מהלוח השמור.
    const st = readSavedState();
    if (st && Array.isArray(st.assignments) && st.assignments.length) {
      try {
        const report = require('./src/engine/report.js');
        const buf = report.buildWorkbook(modelFromState(st), null, dutyPlanFromState(st));
        res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.set('Content-Disposition',
          'attachment; filename="duties.xlsx"; filename*=UTF-8\'\'' + encodeURIComponent('לוח תורנויות.xlsx'));
        return res.send(buf);
      } catch (err) {
        console.error('בנייה מחדש של האקסל נכשלה:', err && err.stack ? err.stack : err);
      }
    }
    return res.status(404).type('text/plain; charset=utf-8').send(NO_BOARD);
  }
  res.download(filePath, 'לוחות-תורנויות-ומגרש.xlsx');
});

// GET /api/teachers-sheet/:id → הלוח למורים, נפתח בדפדפן ומשם מדפיסים או שומרים כ-PDF
app.get('/api/teachers-sheet/:id', (req, res) => {
  const id = String(req.params.id || '').replace(/[^a-zA-Z0-9]/g, '');
  const filePath = path.join(OUTPUT_DIR, `${id}.html`);
  if (!id || !fs.existsSync(filePath)) {
    // נמחק בעליית השרת — בונים את הלוח מחדש מהמצב השמור.
    const st = readSavedState();
    if (st && Array.isArray(st.assignments) && st.assignments.length) {
      try {
        const report = require('./src/engine/report.js');
        res.set('Cache-Control', 'no-store');
        return res.type('html').send(
          report.buildBoardHtml(modelFromState(st), { assignments: st.assignments }));
      } catch (err) {
        console.error('בנייה מחדש של הלוח למורים נכשלה:', err && err.stack ? err.stack : err);
      }
    }
    return res.status(404).type('text/plain; charset=utf-8').send(NO_BOARD);
  }
  res.type('html').send(fs.readFileSync(filePath, 'utf8'));
});

app.listen(PORT, () => {
  console.log(`השרת רץ על http://localhost:${PORT}`);
});

module.exports = app;
