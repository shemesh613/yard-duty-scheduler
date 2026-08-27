// שרת Express — אפליקציית הווב להעלאת קובץ מערכת שעות והרצת המנוע.
// בעלות סוכן 5 בלבד. אינו נוגע ב-src/engine או config.
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

// קבצים סטטיים מ-public/
app.use(express.static(PUBLIC_DIR));

// GET / → מגיש את עמוד הממשק
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// POST /api/run — קבלת קובץ אקסל, הרצת הצינור, החזרת סיכום + HTML + מזהה הורדה
app.post('/api/run', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: 'לא התקבל קובץ. ודאו שבחרתם קובץ אקסל (.xlsx) והעלו שוב.'
      });
    }

    const uploadedPath = req.file.path;
    const buffer = fs.readFileSync(uploadedPath);

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
app.post('/api/inspect', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'לא התקבל קובץ.' });
    }
    const buffer = fs.readFileSync(req.file.path);
    const { parse, infer } = loadInspect();
    const raw = parse.parseWorkbook(buffer);
    // מסך ההגדרות מציג את הערכים לאחר החלת מיקומים(מגדר) + config/overrides.json (הנהלה וכו').
    const eng = require('./src/engine/index.js');
    const locOv = eng.deriveGenderOverrides(raw, eng.loadLocations());
    const baseOv = eng.mergeOverrides(locOv, eng.loadFileOverrides());
    const model = infer.buildModel(raw, baseOv);

    const teachers = (model.teachers || []).map((t) => ({
      name: t.name,
      type: t.type,
      noDuty: !!t.noDuty,
      genderArea: t.genderArea || null,
      homeroomOf: t.homeroomOf || null,
      dayOff: t.dayOff || null,
      numDaysWorked: t.numDaysWorked,
      rabbi: !!t.rabbi,
    }));
    const classes = (model.classes || []).map((c) => ({
      id: c.id,
      gender: c.gender || null,
      homeroomTeacherId: c.homeroomTeacherId || null,
    }));

    return res.json({
      ok: true,
      meta: { days: model.meta.days || [], school: model.meta.school || '' },
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

// GET /api/download/:id → הורדת קובץ האקסל מ-output/
app.get('/api/download/:id', (req, res) => {
  // אבטחה: רק תווים מותרים במזהה כדי למנוע מעבר נתיב
  const id = String(req.params.id || '').replace(/[^a-zA-Z0-9]/g, '');
  const filePath = path.join(OUTPUT_DIR, `${id}.xlsx`);
  if (!id || !fs.existsSync(filePath)) {
    return res.status(404).send('הקובץ לא נמצא או שפג תוקפו.');
  }
  res.download(filePath, 'לוחות-תורנויות-ומגרש.xlsx');
});

// GET /api/teachers-sheet/:id → הלוח למורים, נפתח בדפדפן ומשם מדפיסים או שומרים כ-PDF
app.get('/api/teachers-sheet/:id', (req, res) => {
  const id = String(req.params.id || '').replace(/[^a-zA-Z0-9]/g, '');
  const filePath = path.join(OUTPUT_DIR, `${id}.html`);
  if (!id || !fs.existsSync(filePath)) {
    return res.status(404).send('הקובץ לא נמצא או שפג תוקפו.');
  }
  res.type('html').send(fs.readFileSync(filePath, 'utf8'));
});

app.listen(PORT, () => {
  console.log(`השרת רץ על http://localhost:${PORT}`);
});

module.exports = app;
