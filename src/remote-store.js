// גיבוי הלוח השמור לענף נפרד ב-GitHub, כדי שיישרוד עלייה מחדש של השרת החינמי.
// ענף נפרד (ולא הראשי) כדי ששמירת לוח לא תפעיל עדכון גרסה ב-Render.
// בלי GITHUB_TOKEN הכול כבוי, והאפליקציה עובדת בדיוק כמו קודם.
const TOKEN = process.env.GITHUB_TOKEN || '';
const REPO = process.env.GITHUB_REPO || 'shemesh613/yard-duty-scheduler';
const BRANCH = process.env.BOARD_BRANCH || 'board-data';
const API = 'https://api.github.com/repos/' + REPO;

const enabled = () => !!TOKEN;

function headers(extra) {
  return Object.assign({
    Authorization: 'Bearer ' + TOKEN,
    'User-Agent': 'yard-duty-scheduler',
    'X-GitHub-Api-Version': '2022-11-28'
  }, extra || {});
}

async function gh(method, url, body, accept) {
  const res = await fetch(API + url, {
    method,
    headers: headers(Object.assign({ Accept: accept || 'application/vnd.github+json' },
      body ? { 'Content-Type': 'application/json' } : {})),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000)
  });
  return res;
}

// יוצר את הענף מהענף הראשי אם הוא עדיין לא קיים.
async function ensureBranch() {
  const r = await gh('GET', '/git/ref/heads/' + BRANCH);
  if (r.ok) return;
  if (r.status !== 404) throw new Error('בדיקת הענף נכשלה: ' + r.status);
  const repo = await (await gh('GET', '')).json();
  const base = await (await gh('GET', '/git/ref/heads/' + repo.default_branch)).json();
  const c = await gh('POST', '/git/refs', { ref: 'refs/heads/' + BRANCH, sha: base.object.sha });
  if (!c.ok) throw new Error('יצירת הענף נכשלה: ' + c.status);
}

async function currentSha(file) {
  const r = await gh('GET', '/contents/' + file + '?ref=' + BRANCH);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('קריאת הקובץ נכשלה: ' + r.status);
  return (await r.json()).sha;
}

// מחזיר את הטקסט השמור, או null אם אין.
async function pull(file) {
  if (!enabled()) return null;
  const r = await gh('GET', '/contents/' + file + '?ref=' + BRANCH, null, 'application/vnd.github.raw+json');
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('טעינה מ-GitHub נכשלה: ' + r.status);
  return await r.text();
}

async function put(file, text) {
  await ensureBranch();
  const body = {
    message: 'שמירת ' + file,
    content: Buffer.from(text, 'utf8').toString('base64'),
    branch: BRANCH
  };
  const sha = await currentSha(file);
  if (sha) body.sha = sha;
  const r = await gh('PUT', '/contents/' + file, body);
  if (!r.ok) throw new Error('שמירה ל-GitHub נכשלה: ' + r.status);
}

async function del(file) {
  const sha = await currentSha(file);
  if (!sha) return;
  const r = await gh('DELETE', '/contents/' + file, { message: 'מחיקת ' + file, sha, branch: BRANCH });
  if (!r.ok) throw new Error('מחיקה מ-GitHub נכשלה: ' + r.status);
}

// תור: פעולה אחת בכל רגע, ושמירות שהצטברו בינתיים לאותו קובץ מתאחדות לאחרונה.
const pending = new Map();   // שם קובץ -> { text } או { remove: true }
let running = false;
let lastError = null;

async function drain() {
  if (running) return;
  running = true;
  try {
    while (pending.size) {
      const [file, job] = pending.entries().next().value;
      pending.delete(file);
      try {
        if (job.remove) await del(file); else await put(file, job.text);
        lastError = null;
      } catch (err) {
        lastError = String(err && err.message || err);
        console.error('גיבוי ל-GitHub:', lastError);
      }
    }
  } finally { running = false; }
}

function push(file, text) { if (enabled()) { pending.set(file, { text }); drain(); } }
function remove(file) { if (enabled()) { pending.set(file, { remove: true }); drain(); } }
function status() { return { enabled: enabled(), repo: REPO, branch: BRANCH, lastError }; }

module.exports = { enabled, pull, push, remove, status };
