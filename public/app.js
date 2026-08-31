// לוגיקת צד-לקוח: בחירת/גרירת קובץ ← מסך הגדרות ← חישוב והצגת תוצאות.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

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
  const htmlPreview = $('htmlPreview');
  const downloadBtn = $('downloadBtn');
  const teachersBtn = $('teachersBtn');

  const saveClassesBtn = $('saveClassesBtn');
  const saveClassesMsg = $('saveClassesMsg');

  const restartBtn = $('restartBtn');

  const dutiesTable = $('dutiesTable');
  const redistributeBtn = $('redistributeBtn');
  const removedNote = $('removedNote');

  let selectedFile = null;
  let inspectData = null;
  let assignments = [];        // השיבוצים מההרצה האחרונה
  let removed = [];            // תורנויות שהוסרו ידנית: {teacher, day, break}
  let extraTeachers = [];      // מורים שנוספו ידנית ואינם בקובץ
  let removedTeachers = [];    // מורים שהוסרו ידנית
  let allTeacherNames = [];    // לרשימת הבחירה בהחלפת תורן
  let manualPins = [];         // שיבוצים שנקבעו ידנית ויש לשמרם

  const TEACHER_TYPES = ['מחנכת', 'תומכת למידה', 'מורה מקצועי', 'מורה משלימה תקשורת', 'הנהלה', 'חוגים'];

  const STAT_LABELS = {
    teachers: 'מורים', classes: 'כיתות',
    dutySlots: 'שיבוצי תורנות', violations: 'הפרות'
  };
  const STAT_ORDER = ['teachers', 'classes', 'dutySlots', 'violations'];

  const show = (el) => { el.hidden = false; };
  const hide = (el) => { el.hidden = true; };

  function setFile(file) {
    if (!file) return;
    const name = (file.name || '').toLowerCase();
    if (!name.endsWith('.xlsx') && !name.endsWith('.xls')) {
      showError('יש לבחור קובץ אקסל בלבד (.xlsx).', '');
      return;
    }
    selectedFile = file;
    fileNameEl.textContent = file.name;
    show(fileChosen);
    inspectBtn.disabled = false;
    hide(errorBox);
  }

  function resetFile() {
    selectedFile = null;
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
      const resp = await fetch('/api/inspect', { method: 'POST', body: fd });
      const data = await resp.json();
      hide(loading);
      if (!data.ok) {
        showError(data.error || 'שגיאה בקריאת הקובץ.', data.detail || '');
        inspectBtn.disabled = false;
        return;
      }
      inspectData = data;
      buildSettings(data);
      hide(uploadSection);
      show(settingsSection);
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

  backBtn.addEventListener('click', () => {
    hide(settingsSection);
    show(uploadSection);
    uploadSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

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
      const needsDayOff = t.alwaysPresent && !t.dayOff;
      if (needsDayOff) tr.className = 'needs-attention';

      const typeOpts = TEACHER_TYPES
        .map((ty) => opt(ty, ty, ty === t.type)).join('');
      const dayOpts = ['<option value="">—</option>']
        .concat(days.map((d) => opt(d, d, d === t.dayOff))).join('');

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
          <select class="f-dayoff">${dayOpts}</select>
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
      resetFile();
      hide(results);
      hide(settingsSection);
      hide(errorBox);
      show(uploadSection);
      uploadSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

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
        const resp = await fetch('/api/save-classes', {
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
      const dayoff = tr.querySelector('.f-dayoff').value;
      if (type) o.type = type;
      if (gender) o.genderArea = gender;
      o.noDuty = tr.querySelector('.f-noduty').checked;
      if (dayoff) o.dayOff = dayoff;
      overrides.teachers[tr.dataset.name] = o;
    });
    $('classesTable').querySelectorAll('tbody tr').forEach((tr) => {
      const g = tr.querySelector('.f-cgender').value;
      if (g) overrides.classes[tr.dataset.id] = { gender: g };
    });
    return overrides;
  }

  // --- שלב 2: חישוב הלוחות ---
  // חישוב הלוח. keepRest=true משמר את שאר השיבוצים ומחליף רק את מה שהוסר.
  async function computePlan(keepRest) {
    if (!selectedFile) return;
    hide(errorBox); show(loading);
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

      const fd = new FormData();
      fd.append('file', selectedFile);
      fd.append('overrides', JSON.stringify(overrides));
      const resp = await fetch('/api/run', { method: 'POST', body: fd });
      let data;
      try { data = await resp.json(); }
      catch (_) { throw new Error('השרת החזיר תשובה שאינה תקינה.'); }
      hide(loading);
      if (!data.ok) {
        showError(data.error || 'אירעה שגיאה בעיבוד הקובץ.', data.detail || '');
        return;
      }
      renderResults(data);
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
    removed = [];
    manualPins = [];
    assignments = [];
    hide(results);
    computePlan(false);
  });

  // חלוקה מחדש של כל הלוח — ההסרות הידניות נשמרות.
  if (redistributeBtn) {
    redistributeBtn.addEventListener('click', () => computePlan(false));
  }

  // ---- טבלת התורנויות ----

  function renderDuties() {
    const tb = dutiesTable.querySelector('tbody');
    tb.innerHTML = '';
    assignments.forEach((a, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${a.day}</td>
        <td>${a.break}</td>
        <td>${a.role}</td>
        <td>${a.area || '—'}</td>
        <td class="t-name">${a.teacherName}</td>
        <td class="center">
          <button type="button" class="btn-swap" data-idx="${i}"
                  title="החלף לתורן אחר">החלף</button>
          <button type="button" class="btn-remove" data-idx="${i}"
                  title="הסר ומצא מחליף אוטומטית">הסר</button>
        </td>`;
      tb.appendChild(tr);
    });

    if (removed.length) {
      removedNote.textContent = 'הוסרו ידנית: ' + removed.length
        + ' תורנויות. הן לא יוחזרו לאותם מורים בחישובים הבאים.';
      show(removedNote);
    } else {
      hide(removedNote);
    }
  }

  // הסרת תורן — המערכת תמצא מחליף לאותה הפסקה, ושאר הלוח נשמר.
  dutiesTable.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('.btn-remove');
    if (removeBtn) {
      const a = assignments[Number(removeBtn.dataset.idx)];
      if (!a) return;
      const where = a.day + ', ' + a.break + ', ' + (a.area || a.role);
      if (!confirm('להסיר את ' + a.teacherName + ' מ' + where + '?'
        + ' המערכת תמצא תורן אחר לעמדה, ושאר הלוח יישמר.')) return;
      removed.push({ teacher: a.teacherName, day: a.day, break: a.break });
      computePlan(true);
      return;
    }

    const swapBtn = e.target.closest('.btn-swap');
    if (swapBtn) openSwap(Number(swapBtn.dataset.idx));
  });

  // --- החלפה ידנית של תורן ---

  // מי פנוי לאותה עמדה: כל מי שאינו משובץ כבר באותו יום ואותה הפסקה.
  function availableFor(a) {
    const busy = new Set(assignments
      .filter((x) => x.day === a.day && x.break === a.break)
      .map((x) => x.teacherName));
    return allTeacherNames.filter((n) => !busy.has(n)).sort((x, y) => x.localeCompare(y, 'he'));
  }

  function openSwap(idx) {
    const a = assignments[idx];
    if (!a) return;
    const row = dutiesTable.querySelectorAll('tbody tr')[idx];
    if (!row || row.querySelector('.swap-box')) return;

    const options = availableFor(a);
    if (!options.length) {
      alert('אין מורה פנוי אחר להפסקה הזו.');
      return;
    }

    const cell = row.querySelector('td:last-child');
    const box = document.createElement('div');
    box.className = 'swap-box';
    box.innerHTML = `
      <select class="swap-pick">${options.map((n) => `<option>${n}</option>`).join('')}</select>
      <button type="button" class="btn-swap-ok">אישור</button>
      <button type="button" class="btn-swap-cancel">ביטול</button>`;
    cell.appendChild(box);

    box.querySelector('.btn-swap-cancel').addEventListener('click', () => box.remove());
    box.querySelector('.btn-swap-ok').addEventListener('click', () => {
      const to = box.querySelector('.swap-pick').value;
      const where = a.day + ', ' + a.break + ', ' + (a.area || a.role);
      if (!confirm('להחליף ב' + where + '?' + String.fromCharCode(10)
        + 'במקום: ' + a.teacherName + String.fromCharCode(10)
        + 'לשבץ: ' + to)) return;

      // המורה היוצא נחסם מהעמדה, והנכנס ננעץ אליה. שאר הלוח נשמר.
      removed.push({ teacher: a.teacherName, day: a.day, break: a.break });
      manualPins.push({ teacher: to, day: a.day, break: a.break, area: a.area, role: a.role });
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
    renderDuties();

    htmlPreview.innerHTML = data.html || '<p class="muted">אין תצוגה זמינה.</p>';

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
    results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
})();
