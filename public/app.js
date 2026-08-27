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

  const dutiesTable = $('dutiesTable');
  const redistributeBtn = $('redistributeBtn');
  const removedNote = $('removedNote');

  let selectedFile = null;
  let inspectData = null;
  let assignments = [];   // השיבוצים מההרצה האחרונה
  let removed = [];       // תורנויות שהוסרו ידנית: {teacher, day, break}

  const TEACHER_TYPES = ['מחנכת', 'תומכת למידה', 'מורה מקצועי', 'מורה משלימה תקשורת', 'הנהלה', 'חוגים'];

  const STAT_LABELS = {
    teachers: 'מורים', classes: 'כיתות', yardSlots: 'חלונות מגרש',
    dutySlots: 'שיבוצי תורנות', violations: 'הפרות'
  };
  const STAT_ORDER = ['teachers', 'classes', 'yardSlots', 'dutySlots', 'violations'];

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
      showError('שגיאת תקשורת מול השרת.', (err && err.message) || '');
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

  function buildSettings(data) {
    const days = data.meta && data.meta.days ? data.meta.days : [];

    // מורים
    const tb = $('teachersTable').querySelector('tbody');
    tb.innerHTML = '';
    data.teachers.forEach((t) => {
      const tr = document.createElement('tr');
      tr.dataset.name = t.name;

      const typeOpts = TEACHER_TYPES
        .map((ty) => opt(ty, ty, ty === t.type)).join('');
      const dayOpts = ['<option value="">—</option>']
        .concat(days.map((d) => opt(d, d, d === t.dayOff))).join('');

      tr.innerHTML = `
        <td class="t-name">${t.name}${t.rabbi ? ' <span class="badge">רב</span>' : ''}</td>
        <td class="t-days">${t.numDaysWorked}</td>
        <td><select class="f-type">${typeOpts}</select></td>
        <td><select class="f-gender">
          ${opt('', '—', !t.genderArea)}${opt('בנים', 'בנים', t.genderArea === 'בנים')}${opt('בנות', 'בנות', t.genderArea === 'בנות')}
        </select></td>
        <td class="center"><input type="checkbox" class="f-noduty"${t.noDuty ? ' checked' : ''} /></td>
        <td><select class="f-dayoff">${dayOpts}</select></td>`;
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
      if (keepRest) {
        const isRemoved = (a) => removed.some((b) =>
          b.teacher === a.teacherName && b.day === a.day && b.break === a.break);
        overrides.pinned = assignments.filter((a) => !isRemoved(a)).map((a) => ({
          teacher: a.teacherName, day: a.day, break: a.break, area: a.area, role: a.role,
        }));
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
      showError('שגיאת תקשורת מול השרת.', (err && err.message) || '');
    } finally {
      runBtn.disabled = false;
      if (redistributeBtn) redistributeBtn.disabled = false;
    }
  }

  runBtn.addEventListener('click', () => {
    removed = [];
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
        <td>${a.area || a.role}</td>
        <td class="t-name">${a.teacherName}</td>
        <td class="center"><button type="button" class="btn-remove" data-idx="${i}"
              title="הסר את התורן הזה ומצא אחר">הסר</button></td>`;
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
    const btn = e.target.closest('.btn-remove');
    if (!btn) return;
    const a = assignments[Number(btn.dataset.idx)];
    if (!a) return;
    removed.push({ teacher: a.teacherName, day: a.day, break: a.break });
    computePlan(true);
  });

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
