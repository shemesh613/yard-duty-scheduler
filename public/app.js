// לוגיקת צד-לקוח: בחירת/גרירת קובץ ← מסך הגדרות ← חישוב והצגת תוצאות.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // סיסמת עריכה — קיימת רק אם ההנהלה הפעילה אותה בשרת. ברירת המחדל:
  // אין סיסמה, ואז שום דבר בהתנהגות לא משתנה.
  const KEY_STORE = 'yardDutyEditKey';
  const editKey = () => { try { return localStorage.getItem(KEY_STORE) || ''; } catch (_) { return ''; } };
  function askEditKey(msg) {
    const k = prompt(msg || 'הזינו את סיסמת העריכה:');
    if (k == null) return false;
    try { localStorage.setItem(KEY_STORE, k.trim()); } catch (_) { /* אין גישה */ }
    return true;
  }

  // עוטף fetch: מוסיף את הסיסמה, ואם השרת דורש אותה — מבקש ומנסה שוב.
  async function send(url, opts) {
    const withKey = () => {
      const o = Object.assign({}, opts);
      o.headers = Object.assign({}, (opts && opts.headers) || {});
      const k = editKey();
      // מקודדים: כותרת HTTP אינה יכולה לשאת תווים בעברית.
      if (k) o.headers['x-edit-key'] = encodeURIComponent(k);
      return o;
    };
    let resp = await fetch(url, withKey());
    if (resp.status === 401) {
      let data = null;
      try { data = await resp.clone().json(); } catch (_) { /* לא JSON */ }
      const msg = (data && data.error) || 'העריכה מוגנת בסיסמה.';
      if (!askEditKey(msg + String.fromCharCode(10) + 'סיסמת עריכה:')) return resp;
      resp = await fetch(url, withKey());
    }
    return resp;
  }

  const dropZone = $('dropZone');
  const fileInput = $('fileInput');
  const browseBtn = $('browseBtn');
  const inspectBtn = $('inspectBtn');
  const fileChosen = $('fileChosen');
  const fileNameEl = $('fileName');
  const clearFile = $('clearFile');

  const uploadSection = $('uploadSection');
  const settingsSection = $('settingsSection');
  const backBtn = $('backBtn');
  const runBtn = $('runBtn');
  const teacherFilter = $('teacherFilter');

  const loading = $('loading');
  const errorBox = $('errorBox');
  const errorDetail = $('errorDetail');
  const results = $('results');
  const statsEl = $('stats');
  const downloadBtn = $('downloadBtn');
  const teachersBtn = $('teachersBtn');

  const saveClassesBtn = $('saveClassesBtn');
  const saveClassesMsg = $('saveClassesMsg');

  const stepNav = $('stepNav');
  const restartBtn = $('restartBtn');
  const backToSettingsBtn = $('backToSettingsBtn');

  const unfilledCard = $('unfilledCard');
  const unfilledList = $('unfilledList');
  const unfilledCount = $('unfilledCount');

  const issuesCard = $('issuesCard');
  const issuesList = $('issuesList');
  const issuesCount = $('issuesCount');
  const issuesToggle = $('issuesToggle');

  const runCheckBtn = $('runCheckBtn');
  const printCheckBtn = $('printCheckBtn');
  const checkOut = $('checkOut');

  const dutiesTable = $('dutiesTable');
  const redistributeBtn = $('redistributeBtn');
  const removedNote = $('removedNote');

  let selectedFile = null;
  let inspectData = null;
  let assignments = [];        // השיבוצים מההרצה האחרונה
  let staff = [];              // מצבת אנשי הצוות מההרצה האחרונה (לדוח הבדיקה)
  let removed = [];            // תורנויות שהוסרו ידנית: {teacher, day, break}
  let extraTeachers = [];      // מורים שנוספו ידנית ואינם בקובץ
  let removedTeachers = [];    // מורים שהוסרו ידנית
  let allTeacherNames = [];    // לרשימת הבחירה בהחלפת תורן
  let manualPins = [];         // שיבוצים שנקבעו ידנית ויש לשמרם
  let fileId = null;           // מזהה הקובץ שהועלה, לחישוב מחדש בלי העלאה
  // עותק של הקובץ עצמו, נשמר יחד עם העבודה. הדיסק של השרת החינמי נמחק
  // בכל עלייה מחדש, ואז המזהה כבר לא קיים — בלי העותק הזה כל שינוי ידני
  // היה נכשל ב"לא התקבל קובץ", והעבודה של הסגנית הייתה אבודה.
  let fileData = null;         // base64 של הקובץ
  let lastSummary = null;
  let lastDownloadId = null;
  let restoring = false;
  let violations = [];
  let unfilled = [];
  // true בהרצה חדשה, false בעדכון אחרי שינוי ידני — כדי לא לגלול
  // את המשתמש בחזרה לראש הדף בכל החלפה או הסרה.
  let freshRun = true;

  const TEACHER_TYPES = ['מחנכת', 'תומכת למידה', 'מורה מקצועי', 'מורה משלימה תקשורת', 'הנהלה', 'חוגים'];

  const STAT_LABELS = {
    teachers: 'מורים', classes: 'כיתות',
    dutySlots: 'שיבוצי תורנות', violations: 'הפרות'
  };
  const STAT_ORDER = ['teachers', 'classes', 'dutySlots', 'violations'];

  const show = (el) => { el.hidden = false; };
  const hide = (el) => { el.hidden = true; };

  function b64ToBlob(b64) {
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return new Blob([buf], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  }

  function rememberFileBytes(file) {
    return new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => {
        const res = String(fr.result || '');
        const comma = res.indexOf(',');
        fileData = comma === -1 ? null : res.slice(comma + 1);
        resolve(fileData);
      };
      fr.onerror = () => { fileData = null; resolve(null); };
      try { fr.readAsDataURL(file); } catch (_) { fileData = null; resolve(null); }
    });
  }

  // עבודה שנשמרה לפני שהתחלנו לשמור גם את הקובץ עצמו: המזהה בשרת כבר
  // לא קיים, ואין לנו עותק. מבקשים לבחור שוב את אותו קובץ — השינויים
  // הידניים נשמרים, ומכאן והלאה הקובץ נשמר יחד עם העבודה.
  function askForFileAgain() {
    return new Promise((resolve) => {
      let inp = document.getElementById('recoverFile');
      if (!inp) {
        inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = '.xlsx,.xls';
        inp.id = 'recoverFile';
        inp.hidden = true;
        document.body.appendChild(inp);
      }
      inp.value = '';
      inp.onchange = async () => {
        const f = inp.files && inp.files[0];
        if (!f) { resolve(false); return; }
        selectedFile = f;
        await rememberFileBytes(f);
        if (fileNameEl) fileNameEl.textContent = f.name;
        resolve(true);
      };
      alert('קובץ המערכת אינו זמין יותר בשרת (הוא נמחק בעדכון גרסה).'
        + String.fromCharCode(10) + String.fromCharCode(10)
        + 'בחרו שוב את אותו קובץ אקסל — כל השינויים הידניים שלכם יישמרו,'
        + String.fromCharCode(10)
        + 'ומעכשיו הקובץ נשמר יחד עם העבודה ולא יאבד שוב.');
      inp.click();
    });
  }

  function setFile(file) {
    if (!file) return;
    const name = (file.name || '').toLowerCase();
    if (!name.endsWith('.xlsx') && !name.endsWith('.xls')) {
      showError('יש לבחור קובץ אקסל בלבד (.xlsx).', '');
      return;
    }
    selectedFile = file;
    rememberFileBytes(file);
    fileNameEl.textContent = file.name;
    show(fileChosen);
    inspectBtn.disabled = false;
    hide(errorBox);
  }

  function resetFile() {
    selectedFile = null;
    fileData = null;
    inspectData = null;
    fileInput.value = '';
    hide(fileChosen);
    inspectBtn.disabled = true;
  }

  function showError(title, detail) {
    $('errorTitle').textContent = title || 'אירעה שגיאה';
    errorDetail.textContent = detail || '';
    hide(loading);
    show(errorBox);
  }

  // --- בחירת קובץ ---
  browseBtn.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('click', (e) => { if (e.target !== browseBtn) fileInput.click(); });
  dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) setFile(fileInput.files[0]);
  });
  clearFile.addEventListener('click', resetFile);

  ['dragenter', 'dragover'].forEach((ev) => dropZone.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation(); dropZone.classList.add('drag-over');
  }));
  ['dragleave', 'drop'].forEach((ev) => dropZone.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation(); dropZone.classList.remove('drag-over');
  }));
  dropZone.addEventListener('drop', (e) => {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files[0]) setFile(files[0]);
  });

  // --- שלב 1: בדיקת הקובץ ואכלוס מסך ההגדרות ---
  inspectBtn.addEventListener('click', async () => {
    if (!selectedFile) return;
    hide(errorBox); hide(results); show(loading);
    inspectBtn.disabled = true;
    try {
      const fd = new FormData();
      fd.append('file', selectedFile);
      const resp = await send('/api/inspect', { method: 'POST', body: fd });
      const data = await resp.json();
      hide(loading);
      if (!data.ok) {
        showError(data.error || 'שגיאה בקריאת הקובץ.', data.detail || '');
        inspectBtn.disabled = false;
        return;
      }
      inspectData = data;
      if (data.fileId) fileId = data.fileId;
      buildSettings(data);
      hide(uploadSection);
      show(settingsSection);
      updateSteps('settings');
      settingsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      hide(loading);
      const msg = (err && err.message) || String(err);
      const network = /Failed to fetch|NetworkError|Load failed/.test(msg);
      showError(
        network ? 'לא הצלחנו להגיע לשרת. ודאו שהוא פועל ונסו שוב.'
                : 'אירעה תקלה בקריאת הקובץ.',
        msg
      );
    } finally {
      inspectBtn.disabled = false;
    }
  });

  backBtn.addEventListener('click', () => goStep('upload'));

  // --- בניית טבלאות ההגדרות ---
  function opt(value, label, selected) {
    return `<option value="${value}"${selected ? ' selected' : ''}>${label}</option>`;
  }

  // פילוח השיעורים לפי מגדר — הנתון שעליו מבוססת ההצעה בעמודת המתחם.
  function genderBreakdown(t) {
    const total = (t.boysLessons || 0) + (t.girlsLessons || 0);
    if (!total) return '';
    const p = t.boysPercent;
    return p >= 50 ? p + '% בנים' : (100 - p) + '% בנות';
  }

  const DAY_ORDER = ['יום א', 'יום ב', 'יום ג', 'יום ד', 'יום ה', 'יום ו'];
  function orderDays(days) {
    return days.slice().sort((a, b) => {
      const i = DAY_ORDER.indexOf(a), j = DAY_ORDER.indexOf(b);
      return (i === -1 ? 99 : i) - (j === -1 ? 99 : j);
    });
  }

  function buildSettings(data) {
    const days = orderDays(data.meta && data.meta.days ? data.meta.days : []);
    allTeacherNames = data.teachers.map((t) => t.name);

    // תיבות בחירת ימים למורה חדש
    const dayBox = $('newTeacherDays');
    if (dayBox && !dayBox.childElementCount) {
      dayBox.innerHTML = days.map((d) =>
        `<label class="day-pick"><input type="checkbox" value="${d}"> ${d.replace('יום ', '')}</label>`
      ).join('');
    }

    // מורים
    const tb = $('teachersTable').querySelector('tbody');
    tb.innerHTML = '';
    data.teachers.forEach((t) => {
      const tr = document.createElement('tr');
      tr.dataset.name = t.name;
      // מורה שנוכח בכל יום חייב יום חופשי מוגדר, אחרת ישובץ גם ביום שאינו בא.
      const needsDayOff = t.alwaysPresent
        && !(Array.isArray(t.daysOff) ? t.daysOff.length : t.dayOff);
      if (needsDayOff) tr.className = 'needs-attention';

      const typeOpts = TEACHER_TYPES
        .map((ty) => opt(ty, ty, ty === t.type)).join('');
      const offSet = new Set(Array.isArray(t.daysOff) ? t.daysOff : (t.dayOff ? [t.dayOff] : []));
      const dayBoxes = days.map((d) =>
        `<label class="day-pick sm"><input type="checkbox" class="f-off" value="${d}"${offSet.has(d) ? ' checked' : ''}> ${d.replace('יום ', '')}</label>`
      ).join('');

      tr.innerHTML = `
        <td class="t-name">${t.name}${t.rabbi ? ' <span class="badge">רב</span>' : ''}${t.isNew ? ' <span class="badge badge-new">נוסף</span>' : ''}</td>
        <td class="t-days">${t.numDaysWorked}</td>
        <td><select class="f-type">${typeOpts}</select></td>
        <td>
          <select class="f-gender">
            ${opt('', 'גמיש — שני המתחמים', !t.genderArea)}${opt('בנים', 'בנים', t.genderArea === 'בנים')}${opt('בנות', 'בנות', t.genderArea === 'בנות')}
          </select>
          <span class="gender-breakdown">${genderBreakdown(t)}</span>
        </td>
        <td class="center"><input type="checkbox" class="f-noduty"${t.noDuty ? ' checked' : ''} /></td>
        <td>
          <div class="days-off">${dayBoxes}</div>
          ${needsDayOff ? '<span class="must-fill">חובה לסמן</span>' : ''}
        </td>
        <td class="center">
          <button type="button" class="btn-remove btn-drop-teacher"
                  data-name="${t.name}" title="הסר מהשיבוץ">הסר</button>
        </td>`;
      tb.appendChild(tr);
    });

    // כיתות
    const cb = $('classesTable').querySelector('tbody');
    cb.innerHTML = '';
    data.classes.forEach((c) => {
      const tr = document.createElement('tr');
      tr.dataset.id = c.id;
      tr.innerHTML = `
        <td class="t-name">${c.id}</td>
        <td><select class="f-cgender">
          ${opt('', '—', !c.gender)}${opt('בנים', 'בנים', c.gender === 'בנים')}${opt('בנות', 'בנות', c.gender === 'בנות')}
        </select></td>`;
      cb.appendChild(tr);
    });
  }

  // לשוניות
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      $('tab-teachers').hidden = tab !== 'teachers';
      $('tab-classes').hidden = tab !== 'classes';
    });
  });

  // חיפוש מורה
  teacherFilter.addEventListener('input', () => {
    const q = teacherFilter.value.trim();
    $('teachersTable').querySelectorAll('tbody tr').forEach((tr) => {
      tr.style.display = (!q || tr.dataset.name.includes(q)) ? '' : 'none';
    });
  });

  // ---------- ניווט בין שלבים ----------
  // גלוי תמיד, כדי שאפשר יהיה לחזור להגדרות או ללוח בלי להעלות מחדש.

  function goStep(step) {
    if (step === 'settings' && !inspectData) return;
    if (step === 'results' && !assignments.length) return;
    hide(uploadSection); hide(settingsSection); hide(results); hide(errorBox);
    if (step === 'upload') show(uploadSection);
    else if (step === 'settings') show(settingsSection);
    else show(results);
    updateSteps(step);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function updateSteps(current) {
    if (!stepNav) return;
    const has = { upload: true, settings: !!inspectData, results: assignments.length > 0 };
    let anyBeyond = false;
    stepNav.querySelectorAll('.step').forEach((b) => {
      const s = b.dataset.step;
      b.disabled = !has[s];
      b.classList.toggle('active', s === current);
      if (s !== 'upload' && has[s]) anyBeyond = true;
    });
    stepNav.hidden = !anyBeyond;
  }

  if (stepNav) {
    stepNav.addEventListener('click', (e) => {
      const b = e.target.closest('.step');
      if (b && !b.disabled) goStep(b.dataset.step);
    });
  }

  // חזרה למסך ההגדרות עם אותו קובץ, כדי לשנות ולחשב מחדש.
  // הצפייה עצמה אינה מוחקת דבר — האזהרה על אובדן השינויים ניתנת בעת החישוב.
  if (backToSettingsBtn) {
    backToSettingsBtn.addEventListener('click', () => {
      goStep('settings');
    });
  }

  // חזרה לדף ההעלאה. כל מה שנעשה ידנית על הלוח הנוכחי יאבד, ולכן נדרש אישור.
  if (restartBtn) {
    restartBtn.addEventListener('click', () => {
      const manual = removed.length + manualPins.length
        + extraTeachers.length + removedTeachers.length;
      const NL = String.fromCharCode(10);
      let msg = 'לחזור להעלאת קובץ חדש?' + NL + NL;
      if (manual) {
        msg += 'שימו לב: יש ' + manual + ' שינויים ידניים בלוח הנוכחי —'
          + ' החלפות, הסרות ותוספות של מורים.' + NL
          + 'כל אלה יימחקו ולא ניתן יהיה לשחזר אותם.' + NL + NL;
      } else {
        msg += 'הלוח הנוכחי והתוצאות שעל המסך יימחקו.' + NL + NL;
      }
      msg += 'אם עדיין לא הורדתם את הקובץ למורים — הורידו לפני שתמשיכו.';
      if (!confirm(msg)) return;

      removed = [];
      manualPins = [];
      extraTeachers = [];
      removedTeachers = [];
      assignments = [];
      inspectData = null;
      fileId = null;
      clearState();
      resetFile();
      hide(results);
      hide(settingsSection);
      hide(errorBox);
      show(uploadSection);
      uploadSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  // ---------- שמירת מצב העבודה ----------
  // נשמר בשרת אחרי כל חישוב ואחרי כל שינוי ידני, כדי שיציאה מהאתר
  // לא תמחק את הלוח ואת ההגדרות.

  function currentState() {
    return {
      fileId,
      fileData,
      fileName: fileNameEl ? fileNameEl.textContent : '',
      inspectData,
      overrides: inspectData ? collectOverrides() : null,
      removed, manualPins, extraTeachers, removedTeachers,
      assignments,
      staff,
      violations,
      unfilled,
      summary: lastSummary,
      downloadId: lastDownloadId,
    };
  }

  // המצב נשמר בשני מקומות: בשרת — כדי שגם מי שנכנס ממחשב אחר יראה אותו,
  // ובדפדפן — כי בשרת החינמי הדיסק נמחק בכל הפעלה מחדש, והשמירה בו אובדת.
  const LOCAL_KEY = 'yardDutyState';

  let saveTimer = null;
  function saveState() {
    if (restoring || !fileId) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const st = currentState();
      st.savedAt = new Date().toISOString();
      try { localStorage.setItem(LOCAL_KEY, JSON.stringify(st)); } catch (_) { /* אין מקום */ }
      send('/api/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: st }),
      }).catch(() => { /* שמירה שקטה — לא מפריעים לעבודה */ });
    }, 400);
  }

  function clearState() {
    try { localStorage.removeItem(LOCAL_KEY); } catch (_) { /* אין גישה */ }
    send('/api/state', { method: 'DELETE' }).catch(() => {});
  }

  function applyState(st) {
    restoring = true;
    try {
      fileId = st.fileId || null;
      fileData = st.fileData || null;
      inspectData = st.inspectData || null;
      removed = st.removed || [];
      manualPins = st.manualPins || [];
      extraTeachers = st.extraTeachers || [];
      removedTeachers = st.removedTeachers || [];
      assignments = st.assignments || [];
      staff = st.staff || [];
      violations = st.violations || [];
      unfilled = st.unfilled || [];
      normalizeEdits();
      lastSummary = st.summary || null;
      lastDownloadId = st.downloadId || null;

      if (inspectData) buildSettings(inspectData);
      if (st.overrides) applyOverridesToForm(st.overrides);

      if (assignments.length) {
        renderResults({
          summary: lastSummary, assignments, staff, violations, unfilled,
          downloadId: lastDownloadId,
        });
      } else if (inspectData) {
        hide(uploadSection);
        show(settingsSection);
        updateSteps('settings');
      }
      if (st.fileName && fileNameEl) {
        fileNameEl.textContent = st.fileName;
        show(fileChosen);
      }
    } finally {
      restoring = false;
    }
  }

  // החזרת ערכי הטופס שנשמרו לתוך טבלת ההגדרות.
  function applyOverridesToForm(ov) {
    const t = (ov && ov.teachers) || {};
    $('teachersTable').querySelectorAll('tbody tr').forEach((tr) => {
      const o = t[tr.dataset.name];
      if (!o) return;
      const set = (sel, val) => { const el = tr.querySelector(sel); if (el && val != null) el.value = val; };
      set('.f-type', o.type);
      set('.f-gender', o.genderArea || '');
      const nd = tr.querySelector('.f-noduty');
      if (nd) nd.checked = !!o.noDuty;
      const off = new Set(o.daysOff || []);
      tr.querySelectorAll('.f-off').forEach((c) => { c.checked = off.has(c.value); });
    });
    const c = (ov && ov.classes) || {};
    $('classesTable').querySelectorAll('tbody tr').forEach((tr) => {
      const o = c[tr.dataset.id];
      const el = tr.querySelector('.f-cgender');
      if (o && el && o.gender) el.value = o.gender;
    });
  }

  // בטעינת הדף — אם יש עבודה שמורה, להציע לשחזר אותה.
  (async function offerRestore() {
    let st = null;
    try {
      const resp = await fetch('/api/state');
      const data = await resp.json();
      st = data && data.state;
    } catch (_) { /* אין שרת — ננסה מהדפדפן */ }

    // גיבוי מקומי: שורד גם הפעלה מחדש של השרת, שמוחקת את הדיסק.
    let local = null;
    try { local = JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null'); } catch (_) { /* אין */ }
    if (local && (!st || (local.savedAt || '') > (st.savedAt || ''))) st = local;

    if (!st || (!st.fileId && !st.fileData)) return;

    const when = st.savedAt ? new Date(st.savedAt).toLocaleString('he-IL') : '';
    const manual = (st.removed || []).length + (st.manualPins || []).length;
    const bar = document.createElement('div');
    bar.className = 'restore-bar';
    bar.innerHTML = `
      <span>נמצאה עבודה שמורה${st.fileName ? ' על "' + st.fileName + '"' : ''}${when ? ' מ-' + when : ''}
        ${manual ? '· ' + manual + ' שינויים ידניים' : ''}</span>
      <span class="restore-actions">
        <button type="button" id="restoreYes" class="btn btn-secondary">שחזר</button>
        <button type="button" id="restoreNo" class="btn btn-plain">התחל חדש</button>
      </span>`;
    const main = document.querySelector('main.container');
    main.insertBefore(bar, main.firstChild);

    bar.querySelector('#restoreYes').addEventListener('click', async () => {
      applyState(st);
      bar.remove();
      // עבודה שנשמרה מכאן והלאה נושאת את הקובץ עצמו — אין מה לבדוק.
      if (st.fileData) return;
      // עבודה ישנה מסתמכת על מזהה בשרת, והדיסק של השרת החינמי נמחק בכל
      // עלייה מחדש. בודקים מראש, כדי שלא תגלה זאת רק כשתנסה לשנות משהו.
      try {
        const fd = new FormData();
        fd.append('fileId', st.fileId);
        fd.append('overrides', '{}');
        const probe = await send('/api/run', { method: 'POST', body: fd });
        const pd = await probe.json();
        if (!pd.ok) throw new Error('missing');
      } catch (_) {
        const note = document.createElement('div');
        note.className = 'restore-bar warn';
        note.textContent = 'הלוח שוחזר במלואו, אך קובץ השעות עצמו אינו שמור בשרת יותר. '
          + 'בפעולה הראשונה שתעשו נבקש לבחור אותו שוב — השינויים הידניים יישמרו, '
          + 'ומאז הקובץ יישמר יחד עם העבודה ולא יאבד שוב.';
        const main = document.querySelector('main.container');
        main.insertBefore(note, main.firstChild);
      }
    });
    bar.querySelector('#restoreNo').addEventListener('click', () => {
      clearState();
      bar.remove();
    });
  })();

  // --- הוספה והסרה של מורים ---

  const addTeacherBtn = $('addTeacherBtn');
  if (addTeacherBtn) {
    addTeacherBtn.addEventListener('click', () => {
      const input = $('newTeacherName');
      const name = (input.value || '').trim();
      if (!name) { input.focus(); return; }
      if (allTeacherNames.indexOf(name) !== -1) {
        alert('המורה "' + name + '" כבר קיים ברשימה.');
        return;
      }
      const type = $('newTeacherType').value;
      const chosenDays = [...$('newTeacherDays').querySelectorAll('input:checked')]
        .map((c) => c.value);
      extraTeachers.push({ name, days: chosenDays });
      inspectData.teachers.push({
        name, type, noDuty: false, genderArea: null,
        boysLessons: 0, girlsLessons: 0, boysPercent: null,
        homeroomOf: null, dayOff: null, numDaysWorked: chosenDays.length, rabbi: false,
        alwaysPresent: false, isNew: true,
      });
      buildSettings(inspectData);
      input.value = '';
      $('newTeacherDays').querySelectorAll('input:checked').forEach((c) => { c.checked = false; });
    });
  }

  // הסרת מורה מהשיבוץ
  $('teachersTable').addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-drop-teacher');
    if (!btn) return;
    const name = btn.dataset.name;
    if (!confirm('להסיר את "' + name + '" מהשיבוץ? הוא לא יקבל תורנויות כלל בחישוב הזה.')) return;
    if (extraTeachers.some((t) => t.name === name)) {
      extraTeachers = extraTeachers.filter((t) => t.name !== name);
    } else {
      removedTeachers.push(name);
    }
    inspectData.teachers = inspectData.teachers.filter((t) => t.name !== name);
    buildSettings(inspectData);
  });

  // שמירת מגדר הכיתות לשנה הנוכחית — נשמר בשרת וחל על כל העלאה הבאה.
  if (saveClassesBtn) {
    saveClassesBtn.addEventListener('click', async () => {
      const genderByClass = {};
      $('classesTable').querySelectorAll('tbody tr').forEach((tr) => {
        const g = tr.querySelector('.f-cgender').value;
        if (g) genderByClass[tr.dataset.id] = g;
      });

      saveClassesBtn.disabled = true;
      try {
        const resp = await send('/api/save-classes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ genderByClass }),
        });
        const data = await resp.json();
        saveClassesMsg.textContent = data.ok
          ? 'נשמר — ' + data.saved + ' כיתות. יחול גם על ההעלאות הבאות.'
          : (data.error || 'השמירה נכשלה.');
        saveClassesMsg.className = 'save-msg' + (data.ok ? ' ok' : ' bad');
      } catch (err) {
        saveClassesMsg.textContent = 'לא הצלחנו לשמור — בדקו את החיבור לשרת.';
        saveClassesMsg.className = 'save-msg bad';
      } finally {
        show(saveClassesMsg);
        saveClassesBtn.disabled = false;
      }
    });
  }

  // איסוף העקיפות מהטופס
  function collectOverrides() {
    const overrides = { teachers: {}, classes: {} };
    $('teachersTable').querySelectorAll('tbody tr').forEach((tr) => {
      const o = {};
      const type = tr.querySelector('.f-type').value;
      const gender = tr.querySelector('.f-gender').value;
      const daysOff = [...tr.querySelectorAll('.f-off:checked')].map((c) => c.value);
      if (type) o.type = type;
      if (gender) o.genderArea = gender;
      o.noDuty = tr.querySelector('.f-noduty').checked;
      o.daysOff = daysOff;
      overrides.teachers[tr.dataset.name] = o;
    });
    $('classesTable').querySelectorAll('tbody tr').forEach((tr) => {
      const g = tr.querySelector('.f-cgender').value;
      if (g) overrides.classes[tr.dataset.id] = { gender: g };
    });
    return overrides;
  }

  // --- שלב 2: חישוב הלוחות ---
  let keepScroll = null;

  // חישוב הלוח. keepRest=true משמר את שאר השיבוצים ומחליף רק את מה שהוסר.
  async function computePlan(keepRest) {
    if (!selectedFile && !fileId) return;
    // עדכון אחרי שינוי ידני — לא מציגים מחוון טעינה על כל המסך ולא גוללים.
    freshRun = !keepRest;
    if (keepRest) {
      keepScroll = window.scrollY;
    } else {
      show(loading);
    }
    hide(errorBox);
    runBtn.disabled = true;
    if (redistributeBtn) redistributeBtn.disabled = true;
    try {
      const overrides = collectOverrides();
      overrides.blocked = removed;
      overrides.extraTeachers = extraTeachers;
      overrides.removedTeachers = removedTeachers;
      if (keepRest) {
        const isRemoved = (a) => removed.some((b) =>
          b.teacher === a.teacherName && b.day === a.day && b.break === a.break);
        overrides.pinned = manualPins.concat(
          assignments.filter((a) => !isRemoved(a)).map((a) => ({
            teacher: a.teacherName, day: a.day, break: a.break, area: a.area, role: a.role,
          })));
      }

      const send = (useBytes) => {
        const fd = new FormData();
        if (selectedFile && !useBytes) fd.append('file', selectedFile);
        else if (useBytes && fileData) {
          fd.append('file', b64ToBlob(fileData),
            (fileNameEl && fileNameEl.textContent) || 'workbook.xlsx');
        } else if (selectedFile) fd.append('file', selectedFile);
        else if (fileId) fd.append('fileId', fileId);
        fd.append('overrides', JSON.stringify(overrides));
        return send('/api/run', { method: 'POST', body: fd });
      };

      let resp = await send(false);
      let data;
      try { data = await resp.json(); }
      catch (_) { throw new Error('השרת החזיר תשובה שאינה תקינה.'); }
      // הדיסק של השרת החינמי נמחק בכל עלייה מחדש, והמזהה של הקובץ שהועלה
      // כבר לא קיים. שולחים שוב את העותק ששמור אצלנו, בלי להטריד את המשתמש.
      if (!data.ok && /לא התקבל קובץ/.test(String(data.error || ''))) {
        // אין עותק? מבקשים מהמשתמש לבחור שוב את אותו קובץ.
        const ready = fileData ? true : await askForFileAgain();
        if (ready) {
          resp = await send(!selectedFile);
          try { data = await resp.json(); }
          catch (_) { throw new Error('השרת החזיר תשובה שאינה תקינה.'); }
        }
      }
      hide(loading);
      if (!data.ok) {
        showError(data.error || 'אירעה שגיאה בעיבוד הקובץ.', data.detail || '');
        return;
      }
      renderResults(data);
      if (keepRest) flashSaved();
    } catch (err) {
      hide(loading);
      const msg = (err && err.message) || String(err);
      // הפרדה בין נפילת רשת לבין תקלה בהצגת התוצאה — אחרת כל תקלה
      // נראית כאילו השרת לא זמין, וזה שולח לכיוון הלא נכון.
      const network = /Failed to fetch|NetworkError|Load failed|תקינה/.test(msg);
      showError(
        network ? 'לא הצלחנו להגיע לשרת. ודאו שהוא פועל ונסו שוב.'
                : 'הלוח חושב, אך אירעה תקלה בהצגתו.',
        msg
      );
    } finally {
      runBtn.disabled = false;
      if (redistributeBtn) redistributeBtn.disabled = false;
    }
  }

  runBtn.addEventListener('click', () => {
    const manual = removed.length + manualPins.length;
    if (manual) {
      const NL = String.fromCharCode(10);
      if (!confirm('לחשב את הלוח מחדש?' + NL + NL
        + 'יש ' + manual + ' שינויים ידניים בלוח — החלפות והסרות.' + NL
        + 'חישוב מחדש ימחק אותם והלוח ייבנה מאפס.')) return;
    }
    removed = [];
    manualPins = [];
    assignments = [];
    hide(results);
    computePlan(false);
  });

  // הרצה מחדש לפי הכללים הנוכחיים, בלי לאבד שום שינוי ידני. נחוץ כי לוח
  // שנשמר לפני שינוי בכללים ממשיך להציג את המצב הישן עד ההרצה הבאה.
  const refreshRulesBtn = $('refreshRulesBtn');
  if (refreshRulesBtn) {
    refreshRulesBtn.addEventListener('click', () => {
      if (!assignments.length) return;
      computePlan(true);
    });
  }

  // חלוקה מחדש של כל הלוח — ההסרות הידניות נשמרות, השיבוצים הידניים לא.
  // בלי האזהרה הזו לחיצה אחת מוחקת בשקט את כל מי ששובץ ידנית.
  if (redistributeBtn) {
    redistributeBtn.addEventListener('click', () => {
      if (manualPins.length) {
        const NL = String.fromCharCode(10);
        if (!confirm('לחלק מחדש את כל הלוח?' + NL + NL
          + 'יש ' + manualPins.length + ' שיבוצים ידניים — הם יימחקו.' + NL
          + 'ההסרות (' + removed.length + ') יישמרו.')) return;
        manualPins = [];
        saveState();
      }
      computePlan(false);
    });
  }

  // ---- שינויים ידניים: ההחלטה האחרונה גוברת ----
  // בלי זה נעיצות ישנות נערמות: הן מוחלות לפני החדשות, תופסות את העמדה,
  // וההחלפה החדשה "לא נתפסת". וכן — הסרה נשארה לנצח בלי דרך לבטלה.

  const sameSlotAs = (p, x) => p.day === x.day && p.break === x.break
    && (p.area || null) === (x.area || null) && p.role === x.role
    // שתי עמדות מ"מ באותה הפסקה נראות זהות; המספר הסידורי מבדיל ביניהן,
    // ובלעדיו שיבוץ לעמדה השנייה היה מוחק את השיבוץ לראשונה.
    && (p.idx == null || x.idx == null || p.idx === x.idx);

  function pinTeacher(slot, teacher) {
    manualPins = manualPins.filter((p) => !sameSlotAs(p, slot)
      && !(p.teacher === teacher && p.day === slot.day && p.break === slot.break));
    // שובץ מחדש להפסקה שהוסר ממנה — ההסרה בטלה.
    removed = removed.filter((b) => !(b.teacher === teacher
      && b.day === slot.day && b.break === slot.break));
    manualPins.push({
      teacher, day: slot.day, break: slot.break,
      area: slot.area || null, role: slot.role,
      idx: (slot.idx != null ? slot.idx : undefined), manual: true,
    });
  }

  // עבודה שנשמרה בגרסה ישנה מכילה רישומים סותרים: שתי נעיצות על אותה
  // עמדה, נעיצות כפולות, והסרה של מי שאחר כך שובץ חזרה. שם הנעיצה
  // הישנה הייתה גוברת על החדשה. כאן מנקים אותם בטעינה — האחרון גובר.
  let editsCleaned = 0;
  function normalizeEdits() {
    const before = removed.length + manualPins.length;
    const slotKeyOf = (p) => [p.day, p.break, p.area || '', p.role,
      (p.idx != null ? p.idx : '')].join('|');
    const manKeyOf = (p) => [p.teacher, p.day, p.break].join('|');

    const lastForSlot = new Map();
    manualPins.forEach((p) => lastForSlot.set(slotKeyOf(p), p));
    manualPins = manualPins.filter((p) => lastForSlot.get(slotKeyOf(p)) === p);

    const lastForMan = new Map();
    manualPins.forEach((p) => lastForMan.set(manKeyOf(p), p));
    manualPins = manualPins.filter((p) => lastForMan.get(manKeyOf(p)) === p);

    // הסרה של מי שננעץ במפורש לאותה הפסקה בטלה — הנעיצה גוברת ממילא.
    const pinnedMen = new Set(manualPins.map(manKeyOf));
    const seenRm = new Set();
    removed = removed.filter((b) => {
      const k = manKeyOf(b);
      if (seenRm.has(k) || pinnedMen.has(k)) return false;
      seenRm.add(k);
      return true;
    });
    editsCleaned = before - (removed.length + manualPins.length);
  }

  // כללי בית הספר משתנים (למשל: ביטול הפסקת צהריים ביום שלישי), ואז
  // שינויים ידניים שנשמרו מצביעים על עמדות שכבר אינן קיימות. הם לא היו
  // עושים דבר, אבל היו נשארים ברשימה ומבלבלים. כאן מסירים אותם.
  let staleDropped = 0;
  function pruneStaleEdits() {
    const breaks = new Set();
    const slots = new Set();
    const add = (x) => {
      breaks.add(x.day + '|' + x.break);
      slots.add([x.day, x.break, x.area || '', x.role].join('|'));
    };
    assignments.forEach(add);
    unfilled.forEach(add);
    if (!breaks.size) return;

    const before = removed.length + manualPins.length;
    removed = removed.filter((b) => breaks.has(b.day + '|' + b.break));
    manualPins = manualPins.filter((p) =>
      slots.has([p.day, p.break, p.area || '', p.role].join('|')));
    staleDropped += before - (removed.length + manualPins.length);
  }

  function removeTeacher(a) {
    // נעיצה קודמת של אותו איש צוות באותה הפסקה הייתה מחזירה אותו מיד.
    manualPins = manualPins.filter((p) => !(p.teacher === a.teacherName
      && p.day === a.day && p.break === a.break));
    if (!removed.some((b) => b.teacher === a.teacherName
      && b.day === a.day && b.break === a.break)) {
      removed.push({ teacher: a.teacherName, day: a.day, break: a.break, role: a.role, area: a.area || null });
    }
  }

  // ---- טבלת התורנויות ----

  // סדר ההפסקות ביום, לצורך מיון הטבלה.
  const BREAK_ORDER = ['תחילת יום', 'אחרי 1', 'אחרי 2', 'אחרי 3', 'אחרי 4',
    'אחרי 5', 'אחרי 6', 'סוף יום'];
  const ROLE_ORDER = ['תחילת יום', 'חצר', 'מבנה', 'סייר', 'מ"מ', 'סוף יום'];
  const orderIn = (list, v) => { const i = list.indexOf(v); return i === -1 ? 99 : i; };

  function renderDuties() {
    const tb = dutiesTable.querySelector('tbody');
    tb.innerHTML = '';
    // הטבלה ממוינת לפי יום ← הפסקה ← תפקיד, אחרת שיבוץ ידני קופץ לראשה
    // וקשה למצוא בה עמדה מסוימת.
    // העמדות הריקות מוצגות בטבלה עצמה. בלעדיהן עמדה שלא אוישה פשוט
    // נעלמה מהרשימה, ולא היה איפה לחפש אותה.
    const view = assignments.map((a, i) => ({ a, i }))
      .concat(unfilled.map((u, k) => ({ a: u, i: -1, unf: k })))
      .sort((x, y) =>
      orderIn(DAY_ORDER, x.a.day) - orderIn(DAY_ORDER, y.a.day)
      || orderIn(BREAK_ORDER, x.a.break) - orderIn(BREAK_ORDER, y.a.break)
      || orderIn(ROLE_ORDER, x.a.role) - orderIn(ROLE_ORDER, y.a.role)
      || String(x.a.area || '').localeCompare(String(y.a.area || ''), 'he'));
    view.forEach(({ a, i, unf }) => {
      const tr = document.createElement('tr');
      const isEmpty = (unf != null);
      if (isEmpty) tr.className = 'row-unfilled';
      tr.innerHTML = `
        <td>${dayName(a.day)}</td>
        <td>${brkName(a.break)}</td>
        <td>${a.role}</td>
        <td>${a.area || '—'}</td>
        <td class="t-name">${isEmpty ? '<span class="no-one">לא אויש</span>' : a.teacherName}</td>
        <td class="center">${isEmpty
          ? `<button type="button" class="btn-swap" data-unf="${unf}"
                  title="בחר תורן לעמדה">שבץ</button>`
          : `<button type="button" class="btn-swap" data-idx="${i}"
                  title="החלף לתורן אחר">החלף</button>
             <button type="button" class="btn-remove" data-idx="${i}"
                  title="הסר ומצא מחליף אוטומטית">הסר</button>`}
        </td>`;
      tb.appendChild(tr);
    });
    applyDutyFilter();

    renderManualChanges();
  }

  // רשימת השינויים הידניים, כל אחד עם כפתור ביטול. בלעדיה הסרה הייתה
  // החלטה סופית שאין ממנה חזרה, וזו הייתה תלונה מפורשת של ההנהלה.
  function renderManualChanges() {
    if (!removedNote) return;
    const items = removed.map((b, i) => ({ kind: 'removed', i, b }))
      .concat(manualPins.map((p, i) => ({ kind: 'pin', i, b: p })));
    if (!items.length && !editsCleaned && !staleDropped) { hide(removedNote); return; }

    removedNote.innerHTML =
      '<div class="mc-head"><strong>שינויים ידניים (' + items.length + ')</strong>'
      + '<button type="button" class="link-btn" id="undoAllBtn">בטל את כולם</button></div>'
      + (staleDropped ? '<p class="mc-cleaned">הוסרו ' + staleDropped
        + ' שינויים ידניים שהצביעו על עמדות שכבר אינן קיימות בלוח '
        + '(למשל הפסקה שבוטלה).</p>' : '')
      + (editsCleaned ? '<p class="mc-cleaned">נוקו ' + editsCleaned
        + ' רישומים כפולים או סותרים מעבודה קודמת. בכל עמדה נשמרה הבחירה '
        + 'האחרונה שלכם — כדאי לעבור על הרשימה ולוודא שהיא נכונה.</p>' : '')
      + '<ul class="mc-list">' + items.map((it) => {
        const where = dayName(it.b.day) + ' · ' + brkName(it.b.break)
          + (it.b.area ? ' · ' + it.b.area : (it.b.role ? ' · ' + it.b.role : ''));
        const what = it.kind === 'removed'
          ? '<span class="mc-out">הוסר</span> ' + it.b.teacher
          : '<span class="mc-in">שובץ</span> ' + it.b.teacher;
        return '<li>' + what + ' — ' + where
          + ' <button type="button" class="link-btn mc-undo" data-kind="' + it.kind
          + '" data-i="' + it.i + '">בטל</button></li>';
      }).join('') + '</ul>';
    show(removedNote);
  }

  if (removedNote) {
    removedNote.addEventListener('click', (e) => {
      if (e.target.id === 'undoAllBtn') {
        const NL = String.fromCharCode(10);
        if (!confirm('לבטל את כל השינויים הידניים?' + NL + NL
          + 'הלוח ייבנה מחדש מאפס, בלי ההסרות וההחלפות שעשיתם.')) return;
        removed = [];
        manualPins = [];
        saveState();
        // חישוב מלא, בלי נעיצות — אחרת הלוח הנוכחי נשמר כמות שהוא
        // ורק האילוצים נמחקים, וזה לא "חזרה ללוח שהמערכת חישבה".
        computePlan(false);
        return;
      }
      const btn = e.target.closest('.mc-undo');
      if (!btn) return;
      const i = Number(btn.dataset.i);
      if (btn.dataset.kind === 'removed') {
        const b = removed[i];
        if (!b) return;
        removed.splice(i, 1);
        // ביטול הסרה מחזיר את התורן המקורי לעמדתו, ולא רק מסיר את החסימה:
        // בלי הנעיצה, המחליף שנכנס במקומו נשאר שם והשינוי נראה כאילו לא בוצע.
        if (b.role) pinTeacher(b, b.teacher);
      } else {
        manualPins.splice(i, 1);
      }
      saveState();
      computePlan(true);
    });
  }

  // סינון הטבלה — לאתר עמדה או תורן מסוים בלי לגלול 160 שורות.
  const dutyFilter = $('dutyFilter');
  function applyDutyFilter() {
    const q = (dutyFilter && dutyFilter.value || '').trim();
    const rows = dutiesTable.querySelectorAll('tbody tr');
    let shown = 0;
    rows.forEach((tr) => {
      const hit = !q || tr.textContent.indexOf(q) !== -1;
      tr.hidden = !hit;
      if (hit) shown++;
    });
    const count = $('dutyFilterCount');
    if (count) count.textContent = q ? shown + ' מתוך ' + rows.length : '';
  }
  if (dutyFilter) dutyFilter.addEventListener('input', applyDutyFilter);

  // הסרת תורן — המערכת תמצא מחליף לאותה הפסקה, ושאר הלוח נשמר.
  dutiesTable.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('.btn-remove');
    if (removeBtn) {
      const a = assignments[Number(removeBtn.dataset.idx)];
      if (!a) return;
      const where = a.day + ', ' + a.break + ', ' + (a.area || a.role);
      if (!confirm('להסיר את ' + a.teacherName + ' מ' + where + '?'
        + ' המערכת תמצא תורן אחר לעמדה, ושאר הלוח יישמר.')) return;
      removeTeacher(a);
      saveState();
      computePlan(true);
      return;
    }

    const swapBtn = e.target.closest('.btn-swap');
    if (swapBtn) {
      const tr = swapBtn.closest('tr');
      const u = swapBtn.dataset.unf != null ? unfilled[Number(swapBtn.dataset.unf)] : null;
      openSwap(tr, u || assignments[Number(swapBtn.dataset.idx)]);
    }
  });

  // --- החלפה ידנית של תורן ---

  // מי פנוי לאותה עמדה, ומי שלא — ולמה. קודם הרשימה הייתה 102 שמות בלי
  // שום סימון, ואפשר היה לשבץ מורה שאינה בבית הספר באותו יום.
  function availableFor(a) {
    const byName = {};
    for (const t of staff) byName[t.name] = t;
    const busy = new Set(assignments
      .filter((x) => x.day === a.day && x.break === a.break)
      .map((x) => x.teacherName));
    const sameDay = new Set(assignments
      .filter((x) => x.day === a.day).map((x) => x.teacherName));

    return allTeacherNames
      .filter((n) => !busy.has(n))
      .map((n) => {
        const t = byName[n] || {};
        let why = null;
        if (t.noDuty) why = 'פטור מתורנות';
        else if ((t.daysOff || []).indexOf(a.day) !== -1) why = 'יום חופש שלו';
        else if (!t.alwaysPresent && (t.daysWorked || []).length
          && (t.daysWorked || []).indexOf(a.day) === -1) why = 'אינו עובד ביום זה';
        else if (sameDay.has(n)) why = 'כבר יש לו תורנות באותו יום';
        else if (t.base != null && t.total >= t.base) why = 'מילא את מכסתו (' + t.total + ')';
        return { name: n, why };
      })
      .sort((x, y) => (x.why ? 1 : 0) - (y.why ? 1 : 0)
        || x.name.localeCompare(y.name, 'he'));
  }

  // a — שיבוץ קיים (החלפה) או עמדה ריקה (שיבוץ ראשון אליה).
  function openSwap(tr, a) {
    if (!tr || !a || tr.querySelector('.swap-box')) return;

    // לעמדה ריקה יש רשימת מועמדים מהמנוע, עם סיבת פסילה מדויקת לכל אחד
    // (כולל הרשאות תפקיד). לשורה מאוישת נבנית הרשימה כאן, מהנתונים שבדפדפן.
    const options = Array.isArray(a.candidates)
      ? a.candidates.map((c) => ({ name: c.rawName, label: c.name, why: c.reason }))
      : availableFor(a).map((o) => ({ name: o.name, label: o.name, why: o.why }));
    if (!options.length) {
      alert('אין מורה פנוי אחר להפסקה הזו.');
      return;
    }

    const cell = tr.querySelector('td:last-child');
    const box = document.createElement('div');
    box.className = 'swap-box';
    box.innerHTML = `
      <select class="swap-pick">${options.map((o) =>
        `<option value="${o.name}">${o.label}${o.why ? ' — ' + o.why : ''}</option>`).join('')}</select>
      <button type="button" class="btn-swap-ok">אישור</button>
      <button type="button" class="btn-swap-cancel">ביטול</button>`;
    cell.appendChild(box);

    box.querySelector('.btn-swap-cancel').addEventListener('click', () => box.remove());
    box.querySelector('.btn-swap-ok').addEventListener('click', () => {
      const sel = box.querySelector('.swap-pick');
      const to = sel.value;
      const why = (options.find((o) => o.name === to) || {}).why;
      const NL = String.fromCharCode(10);
      const where = dayName(a.day) + ', ' + brkName(a.break) + ', ' + (a.area || a.role);
      let msg = a.teacherName
        ? 'להחליף ב' + where + '?' + NL + 'במקום: ' + a.teacherName + NL + 'לשבץ: ' + to
        : 'לשבץ את ' + to + ' ל' + where + '?';
      if (why) msg += NL + NL + 'שימו לב: ' + why + '.';
      if (!confirm(msg)) return;

      // המורה היוצא נחסם מהעמדה, והנכנס ננעץ אליה. שאר הלוח נשמר.
      if (a.teacherName) removeTeacher(a);
      pinTeacher(a, to);
      saveState();
      computePlan(true);
    });
  }

  function renderResults(data) {
    statsEl.innerHTML = '';
    const summary = data.summary || {};
    STAT_ORDER.forEach((key) => {
      const value = (summary[key] != null) ? summary[key] : 0;
      const card = document.createElement('div');
      card.className = 'stat' + (key === 'violations' && value > 0 ? ' stat-warn' : '');
      card.innerHTML = `<div class="stat-num">${value}</div><div class="stat-label">${STAT_LABELS[key] || key}</div>`;
      statsEl.appendChild(card);
    });

    assignments = Array.isArray(data.assignments) ? data.assignments : [];
    if (Array.isArray(data.staff)) staff = data.staff;
    violations = Array.isArray(data.violations) ? data.violations : [];
    unfilled = Array.isArray(data.unfilled) ? data.unfilled : [];
    renderUnfilled();
    renderIssues();
    if (data.fileId) fileId = data.fileId;
    lastSummary = data.summary || null;
    lastDownloadId = data.downloadId || null;
    pruneStaleEdits();
    renderDuties();
    renderBoard();
    // הבדיקה השמית מוצגת תמיד ומתעדכנת בכל שינוי — בלי צורך ללחוץ עליה.
    renderCheck();
    saveState();

    if (data.downloadId) {
      const id = encodeURIComponent(data.downloadId);
      downloadBtn.href = '/api/download/' + id;
      downloadBtn.style.display = '';
      if (teachersBtn) {
        teachersBtn.href = '/api/teachers-sheet/' + id;
        teachersBtn.style.display = '';
      }
    } else {
      downloadBtn.style.display = 'none';
      if (teachersBtn) teachersBtn.style.display = 'none';
    }

    show(results);
    updateSteps('results');
    if (freshRun) {
      results.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (keepScroll != null) {
      // שמירת מיקום הגלילה — שינוי ידני לא אמור להזיז את המסך.
      window.scrollTo({ top: keepScroll });
      keepScroll = null;
    }
  }

  // חיווי קצר שהשינוי נקלט — מחליף את קפיצת המסך שהייתה קודם.
  let flashTimer = null;
  function flashSaved() {
    let el = document.getElementById('changeFlash');
    if (!el) {
      el = document.createElement('div');
      el.id = 'changeFlash';
      el.className = 'change-flash';
      document.body.appendChild(el);
    }
    el.textContent = 'השינוי נקלט';
    el.classList.add('show');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => el.classList.remove('show'), 1600);
  }

  // ---------- עמדות שלא אוישו ----------
  // לכל עמדה ריקה — כל אנשי הצוות הנוכחים באותה שעה, וסיבת הפסילה לכל אחד.
  // ההנהלה בוחרת מי לשבץ, וההחלטה נשמרת כשיבוץ ידני.

  const BRK = { 'אחרי 2': 'הפסקת 10', 'אחרי 4': 'הפסקת 12', 'אחרי 6': 'הפסקת צהריים' };
  const DAYF = {
    'יום א': 'יום ראשון', 'יום ב': 'יום שני', 'יום ג': 'יום שלישי',
    'יום ד': 'יום רביעי', 'יום ה': 'יום חמישי', 'יום ו': 'יום שישי',
  };

  function renderUnfilled() {
    if (!unfilledCard) return;
    if (!unfilled.length) { hide(unfilledCard); return; }

    unfilledCount.textContent = unfilled.length;
    unfilledList.innerHTML = unfilled.map((u, i) => {
      const free = u.candidates.filter((c) => !c.reason).length;
      // בתחילת/סוף יום שם ההפסקה והתפקיד זהים — אין טעם לכתוב אותם פעמיים.
      const edge = (u.break === u.role);
      const where = (DAYF[u.day] || u.day) + ' · ' + (BRK[u.break] || u.break)
        + (edge ? '' : ' · ' + u.role) + (u.area ? ' · ' + u.area : '');
      return `
        <details class="unf" data-idx="${i}">
          <summary>
            <span class="unf-where">${where}</span>
            <span class="unf-meta">${u.candidates.length} אנשי צוות נוכחים${free ? ' · ' + free + ' פנויים' : ''}</span>
          </summary>
          <div class="unf-body">
            <p class="unf-sum">${u.summary}</p>
            <table class="unf-table">
              <thead><tr><th>שם</th><th>תפקיד</th><th>תורנויות</th><th>מדוע לא נבחר</th><th></th></tr></thead>
              <tbody>${u.candidates.map((c, j) => `
                <tr class="${c.reason ? '' : 'free'}">
                  <td class="t-name">${c.name}</td>
                  <td>${c.type}</td>
                  <td class="center">${c.duties}</td>
                  <td>${c.reason || '<span class="ok-txt">פנוי לשיבוץ</span>'}</td>
                  <td class="center"><button type="button" class="btn-pick"
                        data-slot="${i}" data-cand="${j}">שבץ</button></td>
                </tr>`).join('')}</tbody>
            </table>
          </div>
        </details>`;
    }).join('');
    show(unfilledCard);
  }

  if (unfilledList) {
    unfilledList.addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-pick');
      if (!btn) return;
      const u = unfilled[Number(btn.dataset.slot)];
      const c = u && u.candidates[Number(btn.dataset.cand)];
      if (!u || !c) return;
      const NL = String.fromCharCode(10);
      const where = (DAYF[u.day] || u.day) + ', ' + (BRK[u.break] || u.break)
        + ', ' + (u.area || u.role);
      let msg = 'לשבץ את ' + c.name + ' ל' + where + '?';
      if (c.reason) msg += NL + NL + 'שימו לב: ' + c.reason + '.';
      if (!confirm(msg)) return;
      pinTeacher(u, c.rawName);
      saveState();
      computePlan(true);
    });
  }

  // ---------- נקודות לבדיקה ----------
  // ההפרות אינן שגיאות: הלוח תקין, אלה מקומות שבהם לא ניתן היה לעמוד
  // בכל הכללים. הצגתן בממשק חוסכת חיפוש בגיליון הבקרה שבאקסל.

  // סיווג לפי סוג, כדי שיהיה ברור מה דורש טיפול ומה רק לידיעה.
  function issueKind(text) {
    if (/נדרשה פשרה/.test(text)) return { label: 'פשרה באיוש', cls: 'warn' };
    if (/חסר יום חופשי/.test(text)) return { label: 'חסר נתון', cls: 'must' };
    if (/מכסת בסיס/.test(text)) return { label: 'לא הגיע למכסה', cls: 'info' };
    if (/מעבר למכסה/.test(text)) return { label: 'מעל המכסה', cls: 'warn' };
    if (/פעמים ב/.test(text)) return { label: 'תורנות כפולה ביום', cls: 'must' };
    if (/בניגוד/.test(text)) return { label: 'סתירת כלל', cls: 'must' };
    if (/איזון/.test(text)) return { label: 'איזון חצר/מבנה', cls: 'info' };
    return { label: 'לבדיקה', cls: 'info' };
  }

  function renderIssues() {
    if (!issuesCard) return;
    if (!violations.length) { hide(issuesCard); return; }

    const order = { must: 0, warn: 1, info: 2 };
    const items = violations
      .map((v) => ({ text: v, kind: issueKind(v) }))
      .sort((a, b) => order[a.kind.cls] - order[b.kind.cls]);

    issuesList.innerHTML = items.map((it) =>
      `<li class="issue ${it.kind.cls}"><span class="issue-tag">${it.kind.label}</span>`
      + `<span class="issue-text">${it.text}</span></li>`).join('');
    issuesCount.textContent = violations.length;
    show(issuesCard);
  }

  if (issuesToggle) {
    issuesToggle.addEventListener('click', () => {
      const hidden = issuesList.hasAttribute('hidden');
      if (hidden) { issuesList.removeAttribute('hidden'); issuesToggle.textContent = 'הסתר'; }
      else { issuesList.setAttribute('hidden', ''); issuesToggle.textContent = 'הצג'; }
    });
  }

  // ================= הלוח הגדול לפני הפצה =================
  // מציג את השבוע כמו הלוח שמופץ לצוות, ומאפשר לגרור תורן מתא לתא.
  // גרירה מחליפה בין שני התורנים, ותמיד מבקשת אישור.

  const bigBoard = $('bigBoard');

  const BREAK_FULL = { 'אחרי 2': 'הפסקת 10', 'אחרי 4': 'הפסקת 12', 'אחרי 6': 'הפסקת צהריים' };
  const DAY_FULL = {
    'יום א': 'יום ראשון', 'יום ב': 'יום שני', 'יום ג': 'יום שלישי',
    'יום ד': 'יום רביעי', 'יום ה': 'יום חמישי', 'יום ו': 'יום שישי',
  };
  const brkName = (b) => BREAK_FULL[b] || b;
  const dayName = (d) => DAY_FULL[d] || d;

  // ---------- בדיקה שמית ----------
  // רשימה לפי א'-ב': לכל איש צוות כמה תורנויות רגילות וכמה מ"מ, מתי בדיוק,
  // ומה המכסה שנקבעה לו. מיועדת לבדיקה סופית אחרי השינויים הידניים.

  function slotLabel(a) {
    const d = DAYF[a.day] || a.day;
    if (a.break === 'תחילת יום' || a.break === 'סוף יום') return d + ' · ' + a.break;
    return d + ' · ' + (BRK[a.break] || a.break) + ' · ' + a.role
      + (a.area ? ' (' + a.area + ')' : '');
  }

  function sortDuties(list) {
    return list.slice().sort((x, y) => {
      const dx = DAY_ORDER.indexOf(x.day), dy = DAY_ORDER.indexOf(y.day);
      if (dx !== dy) return dx - dy;
      return String(x.break).localeCompare(String(y.break), 'he');
    });
  }

  // בונה את שורות הדוח ממה שמוצג על המסך ברגע זה — כולל שינויים ידניים.
  function checkRows() {
    const byName = {};
    for (const a of assignments) (byName[a.teacherName] = byName[a.teacherName] || []).push(a);

    const known = staff.length
      ? staff.slice()
      : Object.keys(byName).map((n) => ({ name: n, short: n, type: '—' }));

    // מי ששובץ אך אינו במצבת (למשל מורה שנוסף ידנית) — מצורף בסוף.
    for (const n of Object.keys(byName)) {
      if (!known.some((t) => t.name === n)) known.push({ name: n, short: n, type: '—' });
    }

    return known.map((t) => {
      const mine = sortDuties(byName[t.name] || []);
      const count = (fn) => mine.filter(fn).length;
      return {
        name: t.short || t.name,
        type: t.type || '—',
        regular: count((a) => a.role === 'חצר' || a.role === 'מבנה'),
        patrol: count((a) => a.role === 'סייר'),
        sub: count((a) => a.role === 'מ"מ'),
        edges: count((a) => a.role === 'תחילת יום' || a.role === 'סוף יום'),
        total: mine.length,
        base: (t.base != null ? t.base : null),
        under: !!t.under,
        noDuty: !!t.noDuty,
        daysOff: Array.isArray(t.daysOff) ? t.daysOff : [],
        duties: mine.map(slotLabel),
      };
    }).sort((a, b) => a.name.localeCompare(b.name, 'he'));
  }

  function checkHtml(rows) {
    const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
    const under = rows.filter((r) => r.under);
    const none = rows.filter((r) => !r.noDuty && r.total === 0);

    const stat = (num, label, warn) =>
      '<div class="stat' + (warn && num ? ' stat-warn' : '') + '">'
      + '<div class="stat-num">' + num + '</div>'
      + '<div class="stat-label">' + label + '</div></div>';

    const head = '<div class="stats check-stats">'
      + stat(rows.filter((r) => r.total > 0).length, 'אנשי צוות בתורנות')
      + stat(sum('total'), 'סה"כ תורנויות')
      + stat(sum('regular'), 'תורנויות רגילות')
      + stat(sum('patrol'), 'סיירת')
      + stat(sum('sub'), 'מילוי מקום')
      + stat(sum('edges'), 'תחילת/סוף יום')
      + stat(under.length, 'מתחת למכסה', true)
      + stat(none.length, 'ללא תורנות כלל', true)
      + '</div>';

    // שתי שורות לכל איש צוות: הספירות, ומתחתן פירוט התורנויות עצמן.
    const body = rows.map((r, i) => {
      const flag = r.noDuty ? ' <span class="chk-tag">פטור</span>'
        : (r.under ? ' <span class="chk-tag warn">מתחת למכסה</span>' : '');
      const off = r.daysOff.length ? '<div class="chk-off">חופשי: ' + r.daysOff.join(', ') + '</div>' : '';
      const det = r.duties.length
        ? r.duties.map((d) => '<span class="chk-chip">' + d + '</span>').join('')
        : '<span class="chk-none">אין תורנויות</span>';
      return '<tr class="chk-main">'
        + '<td class="center">' + (i + 1) + '</td>'
        + '<td class="t-name">' + r.name + flag + off + '</td>'
        + '<td>' + r.type + '</td>'
        + '<td class="center">' + r.regular + '</td>'
        + '<td class="center">' + r.patrol + '</td>'
        + '<td class="center">' + r.sub + '</td>'
        + '<td class="center">' + r.edges + '</td>'
        + '<td class="center strong">' + r.total + '</td>'
        + '<td class="center">' + (r.base != null ? r.base : '—') + '</td>'
        + '</tr>'
        + '<tr class="chk-det"><td></td><td colspan="8">' + det + '</td></tr>';
    }).join('');

    return head
      + '<div class="table-wrap"><table class="check-table">'
      + '<thead><tr><th>#</th><th>שם</th><th>תפקיד</th><th>רגילות</th><th>סיירת</th>'
      + '<th>מ"מ</th><th>תחילת/סוף יום</th><th>סה"כ</th><th>מכסה</th></tr></thead>'
      + '<tbody>' + body + '</tbody></table></div>';
  }

  function renderCheck() {
    if (!checkOut) return;
    const rows = checkRows();
    checkOut.innerHTML = checkHtml(rows);
    show(checkOut);
    if (printCheckBtn) printCheckBtn.hidden = false;
    if (runCheckBtn) runCheckBtn.textContent = 'רענן בדיקה';
  }

  if (runCheckBtn) {
    runCheckBtn.addEventListener('click', () => {
      if (!assignments.length) return;
      renderCheck();
      checkOut.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  // אזהרה לפני הפצה: בלוח למורים עמדה שלא אוישה נראית כתא ריק, ואי אפשר
  // להבחין בינה לבין הפסקה שאינה מתקיימת. עדיף לעצור מאשר להפיץ לוח חסר.
  function exportGuard(e) {
    if (!unfilled.length) return;
    const NL = String.fromCharCode(10);
    const list = unfilled.slice(0, 6)
      .map((u) => '· ' + dayName(u.day) + ', ' + brkName(u.break)
        + ', ' + (u.area || u.role)).join(NL);
    const more = unfilled.length > 6 ? NL + '· ועוד ' + (unfilled.length - 6) : '';
    if (!confirm('יש ' + unfilled.length + ' עמדות שלא אוישו:' + NL + NL
      + list + more + NL + NL
      + 'בלוח למורים הן ייראו כתא ריק. להמשיך בכל זאת?')) {
      e.preventDefault();
    }
  }
  if (teachersBtn) teachersBtn.addEventListener('click', exportGuard);
  if (downloadBtn) downloadBtn.addEventListener('click', exportGuard);

  // קיצור מראש מסך התוצאות אל הרשימה השמית.
  const toCheckBtn = $('toCheckBtn');
  if (toCheckBtn) {
    toCheckBtn.addEventListener('click', () => {
      if (!assignments.length) return;
      if (checkOut && checkOut.hidden) renderCheck();
      document.querySelector('.check-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  if (printCheckBtn) {
    printCheckBtn.addEventListener('click', () => {
      const rows = checkRows();
      const w = window.open('', '_blank');
      if (!w) return;
      const css = 'body{font-family:Arial,Helvetica,sans-serif;direction:rtl;margin:24px;color:#111}'
        + 'h1{font-size:20px;margin:0 0 4px}p.sub{color:#666;font-size:13px;margin:0 0 16px}'
        + 'table{border-collapse:collapse;width:100%;font-size:12px}'
        + 'th,td{border:1px solid #bbb;padding:4px 6px;vertical-align:top}'
        + 'th{background:#eee}.center{text-align:center}.strong{font-weight:700}'
        + '.chk-chip{display:inline-block;border:1px solid #ddd;border-radius:10px;'
        + 'padding:1px 6px;margin:1px 2px;font-size:11px;background:#fafafa}'
        + '.chk-det td{border-top:0;padding-top:0}.chk-main td{border-bottom:0}'
        + '.stats{display:none}.chk-tag{font-size:11px;color:#b45309}'
        + '.chk-off{font-size:11px;color:#666}.chk-none{color:#999}'
        + 'tr{break-inside:avoid}';
      const when = new Date().toLocaleString('he-IL');
      w.document.write('<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8">'
        + '<title>בדיקה שמית — תורנויות</title><style>' + css + '</style></head><body>'
        + '<h1>בדיקה שמית — תורנויות לפי איש צוות</h1>'
        + '<p class="sub">הופק ב-' + when + '</p>'
        + checkHtml(rows) + '</body></html>');
      w.document.close();
    });
  }

  function renderBoard() {
    if (!bigBoard) return;
    const tb = bigBoard.querySelector('tbody');
    tb.innerHTML = '';
    if (!assignments.length) return;

    const days = orderDays([...new Set(assignments.map((a) => a.day))]);
    const regular = [...new Set(assignments.map((a) => a.break))]
      .filter((b) => b !== 'תחילת יום' && b !== 'סוף יום')
      .sort((a, b) => {
        const n = (x) => { const m = /(\d+)/.exec(x); return m ? +m[1] : 99; };
        return n(a) - n(b);
      });

    const head = document.createElement('tr');
    head.innerHTML = '<th class="corner"></th>'
      + days.map((d) => `<th>${dayName(d)}</th>`).join('');
    tb.appendChild(head);

    // אילו הפסקות מתקיימות בכל יום. יום קצר (שישי) אין בו את כל ההפסקות,
    // ולכן התא שלו ריק — וזה שונה לגמרי ממשבצת שלא אוישה.
    const breaksOfDay = {};
    for (const a of assignments) {
      (breaksOfDay[a.day] = breaksOfDay[a.day] || new Set()).add(a.break);
    }
    const dayHasBreak = (day, brk) => !!(breaksOfDay[day] && breaksOfDay[day].has(brk));

    // brk = ההפסקה שהשורה שייכת לה, או null לשורות שאינן תלויות בהפסקה.
    // עמדה ריקה מוצגת כשבבה נפרדת, גם כשחלק מהעמדות באותו תא כן אוישו.
    // היא גם יעד גרירה: גוררים אליה תורן והוא עובר לשם.
    const emptyChip = (u) =>
      `<span class="chip chip-empty" data-day="${u.day}" data-break="${u.break}"`
      + ` data-role="${u.role}" data-area="${u.area || ''}" data-idx2="${u.idx != null ? u.idx : ''}"`
      + ` title="עמדה שלא אוישה — אפשר לגרור לכאן תורן">לא אויש</span>`;

    const rowFor = (label, cls, match, brk, role) => {
      const tr = document.createElement('tr');
      if (cls) tr.className = cls;
      tr.innerHTML = `<th class="rh">${label}</th>` + days.map((day) => {
        const items = assignments
          .map((a, i) => ({ a, i }))
          .filter(({ a }) => a.day === day && match(a));
        const gaps = role
          ? unfilled.filter((u) => u.day === day && u.break === brk && u.role === role)
          : [];
        if (items.length || gaps.length) {
          return '<td>' + items.map(({ a, i }) =>
            `<span class="chip" draggable="true" data-idx="${i}" title="${a.role}${a.area ? ' · ' + a.area : ''}">${a.teacherName}</span>`
          ).join('') + gaps.map(emptyChip).join('') + '</td>';
        }
        // אין שיבוץ. להבחין בין הפסקה שאינה מתקיימת ביום זה לבין עמדה שלא אוישה.
        if (brk && !dayHasBreak(day, brk)) {
          return '<td class="no-break" title="אין הפסקה זו ביום זה">—</td>';
        }
        return '<td class="unfilled" title="העמדה לא אוישה">לא אויש</td>';
      }).join('');
      tb.appendChild(tr);
    };

    rowFor('תחילת יום', 'mgmt', (a) => a.break === 'תחילת יום', 'תחילת יום', 'תחילת יום');

    for (const brk of regular) {
      const label = brkName(brk);
      rowFor(label + ' — חצר', 'yard', (a) => a.break === brk && a.role === 'חצר', brk, 'חצר');
      rowFor(label + ' — מבנה', 'bld', (a) => a.break === brk && a.role === 'מבנה', brk, 'מבנה');
      const dynDays = [...new Set(assignments
        .filter((a) => a.break === brk && a.role === 'דינמיקלאס').map((a) => a.day))];
      if (dynDays.length) {
        // דינמיקלאס מתקיים רק בימים מסוימים — תא ריק בשאר הימים אינו חוסר.
        const tr = document.createElement('tr');
        tr.className = 'sub';
        tr.innerHTML = '<th class="rh">דינמיקלאס</th>' + days.map((day) => {
          const items = assignments.map((a, i) => ({ a, i }))
            .filter(({ a }) => a.day === day && a.break === brk && a.role === 'דינמיקלאס');
          if (items.length) {
            return '<td>' + items.map(({ a, i }) =>
              `<span class="chip" draggable="true" data-idx="${i}" title="דינמיקלאס">${a.teacherName}</span>`).join('') + '</td>';
          }
          return '<td class="no-break" title="אין דינמיקלאס ביום זה">—</td>';
        }).join('');
        tb.appendChild(tr);
      }
      rowFor('מ"מ', 'sub', (a) => a.break === brk && a.role === 'מ"מ', brk, 'מ"מ');
      rowFor('סיירת', 'sub patrol', (a) => a.break === brk && a.role === 'סייר', brk, 'סייר');
    }

    rowFor('סיום יום', 'mgmt', (a) => a.break === 'סוף יום', 'סוף יום', 'סוף יום');
  }

  // --- גרירה ---
  let dragIdx = null;

  if (bigBoard) {
    bigBoard.addEventListener('dragstart', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      dragIdx = Number(chip.dataset.idx);
      chip.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(dragIdx)); } catch (_) { /* דפדפנים ישנים */ }
    });

    bigBoard.addEventListener('dragend', () => {
      dragIdx = null;
      bigBoard.querySelectorAll('.dragging, .drop-target')
        .forEach((el) => el.classList.remove('dragging', 'drop-target'));
    });

    bigBoard.addEventListener('dragover', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip || dragIdx === null) return;
      if (!chip.classList.contains('chip-empty') && Number(chip.dataset.idx) === dragIdx) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      chip.classList.add('drop-target');
    });

    bigBoard.addEventListener('dragleave', (e) => {
      const chip = e.target.closest('.chip');
      if (chip) chip.classList.remove('drop-target');
    });

    bigBoard.addEventListener('drop', (e) => {
      e.preventDefault();
      const chip = e.target.closest('.chip');
      if (!chip || dragIdx === null) return;
      if (chip.classList.contains('chip-empty')) {
        moveToEmpty(dragIdx, {
          day: chip.dataset.day, break: chip.dataset.break,
          role: chip.dataset.role, area: chip.dataset.area || null,
          idx: chip.dataset.idx2 === '' ? undefined : Number(chip.dataset.idx2),
        });
        return;
      }
      const toIdx = Number(chip.dataset.idx);
      if (toIdx === dragIdx) return;
      swapAssignments(dragIdx, toIdx);
    });
  }

  // גרירת תורן אל עמדה שלא אוישה — הוא עובר לשם, ומקומו הקודם מתפנה.
  function moveToEmpty(i, slot) {
    const a = assignments[i];
    if (!a || !slot || !slot.day) return;
    const NL = String.fromCharCode(10);
    const place = (x) => dayName(x.day) + ', ' + brkName(x.break) + ', ' + (x.area || x.role);
    if (!confirm('להעביר את ' + a.teacherName + ' לעמדה שלא אוישה?' + NL + NL
      + 'מ: ' + place(a) + NL + 'אל: ' + place(slot) + NL + NL
      + 'העמדה הקודמת שלו תתפנה, והמערכת תנסה למצוא לה תורן אחר.')) return;
    removeTeacher(a);
    pinTeacher(slot, a.teacherName);
    saveState();
    computePlan(true);
  }

  // החלפה בין שני שיבוצים קיימים, לאחר אישור.
  function swapAssignments(i, j) {
    const a = assignments[i];
    const b = assignments[j];
    if (!a || !b) return;

    const NL = String.fromCharCode(10);
    const place = (x) => dayName(x.day) + ', ' + brkName(x.break) + ', ' + (x.area || x.role);
    const msg = 'להחליף בין שני התורנים?' + NL + NL
      + a.teacherName + ' — ' + place(a) + NL
      + b.teacherName + ' — ' + place(b) + NL + NL
      + 'לאחר ההחלפה:' + NL
      + b.teacherName + ' → ' + place(a) + NL
      + a.teacherName + ' → ' + place(b);
    if (!confirm(msg)) return;

    // שני הצדדים נחסמים ממקומם הנוכחי וננעצים במקום החדש.
    removeTeacher(a);
    removeTeacher(b);
    pinTeacher(a, b.teacherName);
    pinTeacher(b, a.teacherName);
    saveState();
    computePlan(true);
  }

})();
