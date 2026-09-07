// גיבוי ושחזור של העבודה השמורה בשרת.
// הדיסק של Render בתוכנית החינמית נמחק בכל עלייה מחדש — כלומר בכל
// עדכון גרסה. לפני כל דחיפה יש להריץ save, ואחריה restore.
//
//   node tools/state-backup.js save     [url]   → מוריד ל-backups/
//   node tools/state-backup.js restore  [url] [קובץ]
//   node tools/state-backup.js show     [url]

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'backups');
const DEFAULT_URL = 'https://yard-duty-scheduler.onrender.com';
const [, , cmd, urlArg, fileArg] = process.argv;
const base = (urlArg && /^https?:/.test(urlArg)) ? urlArg.replace(/\/$/, '') : DEFAULT_URL;

const describe = (s) => !s ? 'אין מצב שמור'
  : `${s.fileName || '?'} · ${(s.assignments || []).length} שיבוצים · `
    + `${((s.removed || []).length + (s.manualPins || []).length)} שינויים ידניים · `
    + `נשמר ${s.savedAt || '?'}`;

async function getState() {
  const r = await fetch(base + '/api/state');
  const d = await r.json();
  return d && d.state;
}

(async () => {
  if (cmd === 'save') {
    const st = await getState();
    if (!st) { console.log('אין מה לגבות — השרת ריק.'); process.exit(1); }
    fs.mkdirSync(DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
    const out = path.join(DIR, `state-${stamp}.json`);
    fs.writeFileSync(out, JSON.stringify({ ok: true, state: st }), 'utf8');
    console.log('נשמר: ' + out);
    console.log('   ' + describe(st));
    return;
  }

  if (cmd === 'restore') {
    let file = fileArg && !/^https?:/.test(fileArg) ? fileArg : null;
    if (!file) {
      const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort() : [];
      if (!files.length) { console.log('אין גיבויים בתיקיית backups.'); process.exit(1); }
      file = path.join(DIR, files[files.length - 1]);
    }
    const st = JSON.parse(fs.readFileSync(file, 'utf8')).state;
    const now = await getState();
    if (now && (now.savedAt || '') > (st.savedAt || '')) {
      console.log('עצור: בשרת יש מצב חדש יותר מהגיבוי — שחזור ימחק אותו.');
      console.log('   בשרת: ' + describe(now));
      console.log('   בגיבוי: ' + describe(st));
      process.exit(1);
    }
    const r = await fetch(base + '/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: st }),
    });
    console.log('שוחזר מ-' + path.basename(file) + ': ' + JSON.stringify(await r.json()));
    console.log('   ' + describe(st));
    return;
  }

  const st = await getState();
  console.log(base);
  console.log('   ' + describe(st));
})().catch((e) => { console.error('שגיאה: ' + e.message); process.exit(1); });
