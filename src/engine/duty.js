// סוכן 3 — סולבר לוח התורנויות.
// module.exports.assignDuties(model, rules, options={}) -> dutyPlan
// dutyPlan = { assignments:[{day, break, area, role, teacherId, teacherName}],
//              perTeacher:{ teacherId:{yard, building, total, quotaOk} },
//              violations:string[], score:number }
//
// אלגוריתם חמדני/הוריסטי: עובר עמדה-עמדה (יום × הפסקה × אזור × מספר עמדה),
// ובכל עמדה בוחר את המורה הזמין-הכשיר עם הכי פחות תורנויות עד כה (לאיזון),
// תוך כיבוד כל האילוצים (מכסה, מגדר, חלון-זמן, noDuty, הנהלה, יאיר, איזון חצר/מבנה,
// הצמדה לשעת שהייה, וקרבה לכיתות אם קיים config/locations.json).
// בסוף מריץ ולידציה פר-מורה ומייצר violations + score. אין קידוד שמות קשיח.

const fs = require('fs');
const path = require('path');

// ---------- ברירות מחדל לכללים (משולבות עם rules שנמסר) ----------
const DEFAULT_RULES = {
  breaks: ['תחילת יום', 'אחרי 1', 'אחרי 2', 'אחרי 3', 'אחרי 4', 'סוף יום'],
  areas: ['חצר בנים', 'חצר בנות', 'מבנה בנים', 'מבנה בנות'],
  stationsPerBreakArea: 1,
  stationsOverride: { 'תחילת יום': 1, 'סוף יום': 1 },
  quotas: {
    'תומכת למידה': 2,
    'מחנכת': 1,
    'מורה משלימה תקשורת': 1,
    'מורה מקצועי': 2,
    'הנהלה': 2,
    'חוגים': 0,
    _default: 1,
  },
  extraSubstitution: 1,
  minDaysForFullQuota: 3,
  lowDaysQuotaCap: 2,
  balanceYardBuilding: true,
  balanceTolerancePerc: 0.5,
  managementBreaks: ['תחילת יום', 'סוף יום'],
  managementType: 'הנהלה',
  rabbiNameKeyword: 'יאיר',
  rabbiStartOfDayBreak: 'תחילת יום',
  preferStandbyAdjacency: true,
  useLocations: true,
};

function mergeRules(rules) {
  const r = Object.assign({}, DEFAULT_RULES, rules || {});
  // מיזוג עמוק לאובייקטים מקוננים שחשובים
  r.quotas = Object.assign({}, DEFAULT_RULES.quotas, (rules && rules.quotas) || {});
  r.stationsOverride = Object.assign({}, DEFAULT_RULES.stationsOverride, (rules && rules.stationsOverride) || {});
  if (!Array.isArray(r.breaks) || !r.breaks.length) r.breaks = DEFAULT_RULES.breaks.slice();
  if (!Array.isArray(r.areas) || !r.areas.length) r.areas = DEFAULT_RULES.areas.slice();
  if (!Array.isArray(r.managementBreaks)) r.managementBreaks = DEFAULT_RULES.managementBreaks.slice();
  return r;
}

// גיזרות מיוחדות שאינן מגיעות מקובץ הגיזרות: שער הכניסה (תחילת/סוף יום)
// ועמדת הדינמיקלאס. אין להן מגדר ואינן נספרות באיזון חצר/מבנה.
const GATE_ZONE = 'שער כניסה';
const DYNAMIC_ZONE = 'דינמיקלאס';

// ---------- מתחמים (config/zones.json) ----------
// כל כיתה שייכת לשני מתחמים. המתחמים מחליפים את חלוקת "חצר/מבנה בנים/בנות" הישנה.
function loadZones() {
  try {
    const p = path.join(__dirname, '..', '..', 'config', 'zones.json');
    const z = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!z || !Array.isArray(z.zones) || !z.zones.length) return null;
    return z;
  } catch (e) {
    return null;
  }
}

// מגדר של מתחם = המגדר של רוב הכיתות שסמוכות לו.
function buildZoneGender(zones, model) {
  const genderOfClass = {};
  for (const c of (model && model.classes) || []) {
    if (c && c.id && c.gender) genderOfClass[c.id] = c.gender;
  }
  const tally = {};
  for (const [cls, list] of Object.entries(zones.zonesByClass || {})) {
    const g = genderOfClass[cls];
    if (!g) continue;
    for (const zone of list || []) {
      const acc = tally[zone] || (tally[zone] = { 'בנים': 0, 'בנות': 0 });
      acc[g]++;
    }
  }
  const out = {};
  for (const [zone, acc] of Object.entries(tally)) {
    if (acc['בנים'] === acc['בנות']) out[zone] = null; // מעורב — פתוח לשניהם
    else out[zone] = acc['בנים'] > acc['בנות'] ? 'בנים' : 'בנות';
  }
  return out;
}

// סיווג מתחם כחצר או כמבנה — לצורך כלל האיזון בלבד.
// ניתן לקבוע מפורשות ב-zones.json תחת "kindByZone"; אחרת מסווג לפי שם המתחם.
function buildZoneKind(zones) {
  const explicit = (zones && zones.kindByZone) || {};
  const out = {};
  for (const zone of zones.zones) {
    if (explicit[zone] === 'חצר' || explicit[zone] === 'מבנה') {
      out[zone] = explicit[zone];
      continue;
    }
    out[zone] = /חצר|מגרש|אמפי|פינה ירוקה|דשא/.test(zone) ? 'חצר' : 'מבנה';
  }
  return out;
}

// הקשר המתחמים להרצה הנוכחית. null כשאין קובץ מתחמים (אז נשמרת ההתנהגות הישנה).
let ZONES = null;

// ---------- עזרי אזור ----------
function isYardArea(area) {
  if (typeof area !== 'string') return false;
  if (ZONES && ZONES.kind[area]) return ZONES.kind[area] === 'חצר';
  return area.indexOf('חצר') !== -1;
}
function isBuildingArea(area) {
  if (typeof area !== 'string') return false;
  if (ZONES && ZONES.kind[area]) return ZONES.kind[area] === 'מבנה';
  return area.indexOf('מבנה') !== -1;
}
function areaGender(area) {
  if (typeof area !== 'string') return null;
  if (ZONES && Object.prototype.hasOwnProperty.call(ZONES.gender, area)) {
    return ZONES.gender[area];
  }
  if (area.indexOf('בנות') !== -1) return 'בנות';
  if (area.indexOf('בנים') !== -1) return 'בנים';
  return null;
}
function roleForArea(area) {
  if (isYardArea(area)) return 'חצר';
  if (isBuildingArea(area)) return 'מבנה';
  return 'חצר';
}

// המתחמים שבהם המורה נמצא פיזית סמוך להפסקה — לפי הכיתה שבה לימד בשיעור שלפניה.
// מחזיר null אם לא לימד בכיתה בשיעור הקודם (ואז נופלים לכלל ה-80%).
function zonesFromPreviousLesson(teacher, day, brk) {
  if (!ZONES) return null;
  const periods = breakToPeriods(brk);
  if (!periods) return null;
  const prev = periods[0];
  const zones = new Set();
  for (const l of teacher.lessons || []) {
    if (l.day !== day || l.period !== prev || !l.cls) continue;
    for (const z of ZONES.byClass[l.cls] || []) zones.add(z);
  }
  return zones.size ? zones : null;
}

// המגדר שקובע לשיבוץ: קודם לפי הכיתה שלימד בה בשיעור הקודם, אחרת המתחם הקבוע של המורה.
function effectiveGender(teacher, day, brk) {
  if (ZONES) {
    const periods = breakToPeriods(brk);
    if (periods) {
      for (const l of teacher.lessons || []) {
        if (l.day !== day || l.period !== periods[0] || !l.cls) continue;
        const g = ZONES.genderOfClass[l.cls];
        if (g) return g;
      }
    }
  }
  const ga = teacher.genderArea;
  return (ga === 'בנים' || ga === 'בנות') ? ga : null;
}

// "אחרי N" → הפסקה בין שיעור N לשיעור N+1 (תואם yard.js).
function breakToPeriods(brk) {
  const m = /(\d+)/.exec(String(brk));
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return [n, n + 1];
}
function isManagementBreak(brk, r) {
  return r.managementBreaks.indexOf(brk) !== -1;
}

// ---------- טעינת locations (אופציונלי) ----------
function loadLocations() {
  try {
    const p = path.join(__dirname, '..', '..', 'config', 'locations.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null; // לעולם לא לקרוס בגלל locations
  }
}

// ---------- חישוב מכסה אפקטיבית למורה ----------
function baseQuota(teacher, r) {
  const q = r.quotas;
  if (Object.prototype.hasOwnProperty.call(q, teacher.type)) return q[teacher.type];
  return q._default != null ? q._default : 1;
}
function effectiveQuota(teacher, r) {
  if (teacher.noDuty) return 0;
  let q = baseQuota(teacher, r);
  q += (r.extraSubstitution || 0); // תורנות מ"מ נוספת
  // מורה עם מעט ימים — גובר על המכסה
  const nd = typeof teacher.numDaysWorked === 'number'
    ? teacher.numDaysWorked
    : (Array.isArray(teacher.daysWorked) ? teacher.daysWorked.length : 0);
  // כלל "פחות משלושה ימים" חל רק כשידוע כמה ימים המורה עובד — מהמערכת
  // או מבחירה ידנית. מורה בלי נתון כלל מקבל מכסה מלאה.
  const daysKnown = !hasNoSchedule(teacher) || teacher.manualDays;
  if (daysKnown && nd < (r.minDaysForFullQuota || 3)) {
    q = Math.min(q, r.lowDaysQuotaCap != null ? r.lowDaysQuotaCap : 2);
  }
  return Math.max(0, q);
}

// ---------- בדיקת זמינות זמן (חלון עבודה) ----------
// אסור לשבץ תורנות לפני workSpan.first או אחרי workSpan.last באותו יום,
// מלבד תחילת/סוף יום (הנהלה).
// מורה שאין לו שיעורים כלל בקובץ (למשל תומכות למידה, שאין מידע על כיתותיהן).
// לא ניתן להסיק מתי הוא בבית הספר — לכן הוא נחשב זמין בכל הפסקה, ומשובץ
// לפי מה שמתאים. החלטת הנהלה, 27.8.2026.
function hasNoSchedule(teacher) {
  return !Array.isArray(teacher.lessons) || teacher.lessons.length === 0;
}

function withinWorkSpan(teacher, day, brk, r) {
  if (isManagementBreak(brk, r)) return true; // תחילת/סוף יום פטורים
  if (hasNoSchedule(teacher)) return true;    // אין מערכת — זמין בכל שעה
  const ws = teacher.workSpan && teacher.workSpan[day];
  if (!ws) return false; // אם המורה לא עובד באותו יום — לא זמין
  const periods = breakToPeriods(brk);
  if (!periods) return false;
  const [a, b] = periods; // ההפסקה בין a ל-b
  // התורנות חוקית אם ההפסקה גובלת בטווח העבודה: a >= first ו-b <= last+?
  // הפסקה "אחרי N" יושבת בין שיעור N (a) לשיעור N+1 (b). חוקי אם a בטווח [first,last].
  return a >= ws.first && a <= ws.last;
}

function worksOnDay(teacher, day) {
  // מי שמסומן alwaysPresent נמצא בבית הספר בכל יום, גם ביום בלי שיעורים.
  // חל על אנשי סגל בודדים בלבד — לא על צוות ההנהלה כולו.
  if (teacher.alwaysPresent) return true;
  if (Array.isArray(teacher.daysWorked) && teacher.daysWorked.length) {
    return teacher.daysWorked.indexOf(day) !== -1;
  }
  if (hasNoSchedule(teacher)) return true; // אין מערכת ולא נבחרו ימים — זמין בכל יום
  return !!(teacher.workSpan && teacher.workSpan[day]);
}

// האם המורה צמוד לשעת שהייה/פרטני סביב ההפסקה (בונוס).
function adjacentToStandby(teacher, day, brk) {
  const periods = breakToPeriods(brk);
  if (!periods) return false;
  const set = new Set((teacher.standbySlots || []).map(s => s.day + '|' + s.period));
  return set.has(day + '|' + periods[0]) || set.has(day + '|' + periods[1]);
}

// האם המורה פנוי (freeSlot/standby) סביב ההפסקה — עדיף לא לשבץ כשהוא מלמד בדיוק אז.
function freeAroundBreak(teacher, day, brk) {
  const periods = breakToPeriods(brk);
  if (!periods) return true;
  const teaching = new Set((teacher.lessons || [])
    .filter(l => !l.standby)
    .map(l => l.day + '|' + l.period));
  // אם מלמד בשני השיעורים הגובלים — פחות נוח, אך עדיין מותר.
  const t0 = teaching.has(day + '|' + periods[0]);
  const t1 = teaching.has(day + '|' + periods[1]);
  return !(t0 && t1);
}

// בדיקת התאמה מגדרית בין מורה לאזור, בהקשר של יום והפסקה מסוימים.
// המגדר הקובע: הכיתה שבה לימד בשיעור שלפני ההפסקה; ורק אם אין כזו — המתחם הקבוע שלו.
function genderOk(teacher, area, day, brk) {
  const ga = effectiveGender(teacher, day, brk);
  if (ga !== 'בנים' && ga !== 'בנות') return true; // לא ידוע → מותר בשני המתחמים
  const ag = areaGender(area);
  if (ag == null) return true;
  return ga === ag;
}

// קרבה לכיתות (אופציונלי). מחזיר בונוס 0..1.
function locationBonus(teacher, area, locations) {
  if (!locations) return 0;
  // מבנה צפוי: locations = { areaName: [classIds...] } או { classId: areaName }.
  try {
    const taughtClasses = new Set((teacher.lessons || []).map(l => l.cls));
    let classesInArea = null;
    if (Array.isArray(locations[area])) {
      classesInArea = new Set(locations[area]);
    } else if (locations.areas && Array.isArray(locations.areas[area])) {
      classesInArea = new Set(locations.areas[area]);
    }
    if (classesInArea) {
      for (const c of taughtClasses) if (classesInArea.has(c)) return 1;
      return 0;
    }
    // מיפוי הפוך: classId -> area
    for (const c of taughtClasses) {
      if (locations[c] === area) return 1;
    }
    return 0;
  } catch (e) {
    return 0;
  }
}

// כמה עמדות תורנות (חצר/מבנה) בהפסקה נתונה — עם התחשבות בהפסקות מיוחדות (דינמיקלאס).
function postsForBreak(day, brk, r) {
  const sb = r.specialBreaks;
  if (sb && Array.isArray(sb.days) && Array.isArray(sb.breaks)
      && sb.days.indexOf(day) !== -1 && sb.breaks.indexOf(brk) !== -1) {
    return sb.postsPerBreak != null ? sb.postsPerBreak : (r.postsPerRegularBreak || 6);
  }
  // תמיכה לאחור: אם הוגדר stationsPerBreakArea, נגזור סה"כ = פר-אזור × מס' אזורים.
  if (r.postsPerRegularBreak != null) return r.postsPerRegularBreak;
  if (r.stationsPerBreakArea != null) return r.stationsPerBreakArea * (r.areas ? r.areas.length : 4);
  return 6;
}

// ---------- בניית רשימת העמדות (slots) לשיבוץ ----------
// השיעור האחרון שמתקיים בפועל בכל יום, לפי מערכת השעות.
// ביום קצר (שישי) אין הפסקה אחרי שיעור שכבר אינו מתקיים.
function lastPeriodByDay(model) {
  const out = {};
  for (const t of (model && model.teachers) || []) {
    for (const l of t.lessons || []) {
      if (!Number.isFinite(l.period)) continue;
      if (out[l.day] == null || l.period > out[l.day]) out[l.day] = l.period;
    }
  }
  return out;
}

function buildSlots(model, r) {
  const days = (model.meta && model.meta.days) || [];
  const areas = r.areas || [];
  const slots = [];
  const lastPeriod = lastPeriodByDay(model);
  for (const day of days) {
    for (const brk of r.breaks) {
      // הפסקה שאחרי שיעור שאינו מתקיים באותו יום — אינה קיימת.
      const periods = breakToPeriods(brk);
      if (periods && lastPeriod[day] != null && periods[0] >= lastPeriod[day]) continue;
      // תחילת/סוף יום — עמדות הנהלה (לא חצר/מבנה).
      if (isManagementBreak(brk, r)) {
        const count = (r.stationsOverride && r.stationsOverride[brk] != null) ? r.stationsOverride[brk] : 1;
        for (let i = 0; i < count; i++) {
          slots.push({
            day, break: brk, area: GATE_ZONE,
            role: (brk === 'סוף יום' ? 'סוף יום' : 'תחילת יום'), mgmt: true, idx: i,
          });
        }
        continue;
      }
      // הפסקה רגילה — N עמדות תורנות מתחלקות בין האזורים (round-robin), + סייר + מ"מ.
      const posts = postsForBreak(day, brk, r);
      const baseposts = areas.length || (r.postsPerRegularBreak || 6);
      for (let i = 0; i < posts; i++) {
        // עמדה מעבר למספר המתחמים — עמדת דינמיקלאס (ימי ב׳ ו-ד׳, הפסקות 10 ו-12).
        if (i >= baseposts) {
          slots.push({ day, break: brk, area: DYNAMIC_ZONE, role: 'דינמיקלאס', mgmt: false, dynamic: true, idx: i });
          continue;
        }
        const area = areas.length ? areas[i % areas.length] : null;
        slots.push({ day, break: brk, area, role: roleForArea(area), mgmt: false, idx: i });
      }
      const patrol = r.patrolPerBreak || 0;
      for (let i = 0; i < patrol; i++) {
        slots.push({ day, break: brk, area: null, role: 'סייר', mgmt: false, patrol: true, idx: i });
      }
      const subs = (r.substitutesOverride && r.substitutesOverride[brk] != null)
        ? r.substitutesOverride[brk]
        : (r.substitutesPerBreak || 0);
      for (let i = 0; i < subs; i++) {
        slots.push({ day, break: brk, area: null, role: 'מ"מ', mgmt: false, substitute: true, idx: i });
      }
    }
  }
  return slots;
}

// ---------- הסולבר ----------
function assignDuties(model, rules, options = {}) {
  const r = mergeRules(rules);
  const locations = (r.useLocations) ? loadLocations() : null;
  const violations = [];
  const warnings = [];

  // מתחמי התורנות. כשקיים config/zones.json הם מחליפים את ארבעת האזורים הישנים,
  // ועמדה אחת נפתחת בכל מתחם בכל הפסקה.
  const zonesFile = loadZones();
  if (zonesFile) {
    const genderOfClass = {};
    for (const c of (model && model.classes) || []) {
      if (c && c.id && c.gender) genderOfClass[c.id] = c.gender;
    }
    ZONES = {
      byClass: zonesFile.zonesByClass || {},
      genderOfClass,
      gender: buildZoneGender(zonesFile, model),
      kind: buildZoneKind(zonesFile),
    };
    r.areas = zonesFile.zones.slice();
    if (r.postsPerRegularBreak == null) r.postsPerRegularBreak = r.areas.length;
  } else {
    ZONES = null;
  }

  const teachers = (model && model.teachers) || [];
  const byId = new Map(teachers.map(t => [t.id, t]));

  // מצב פר-מורה
  const state = new Map();
  for (const t of teachers) {
    state.set(t.id, {
      teacher: t,
      yard: 0,
      building: 0,
      mgmt: 0,
      total: 0,
      quota: effectiveQuota(t, r),
      perDay: {}, // day -> count (כדי לא לשבץ אותו מורה לכמה הפסקות באותו יום אם אפשר)
      assignedSlots: new Set(), // "day|break" כדי למנוע כפילות באותה הפסקה
    });
  }

  const assignments = [];

  // ---------- שלב 1: הנהלה — תחילת/סוף יום ----------
  const management = teachers.filter(t => t.type === r.managementType && !t.noDuty);
  const rabbiKw = r.rabbiNameKeyword;
  const rabbis = teachers.filter(t => rabbiKw && t.name && t.name.indexOf(rabbiKw) !== -1 && !t.noDuty);

  // מורה שנוכח בכל יום חייב יום חופשי מוגדר — אחרת ישובץ גם ביום שאינו בא.
  for (const t of teachers) {
    if (!t.alwaysPresent || t.noDuty || daysOffOf(t).length) continue;
    violations.push('חסר יום חופשי: "' + t.name + '" מסומן כנוכח בכל יום, ולכן שובץ '
      + 'בכל ימי השבוע. יש לקבוע את יומו החופשי במסך ההגדרות.');
  }

  const hasManagement = management.length > 0;
  if (!hasManagement) {
    warnings.push('אזהרה: אין אף מורה מסוג "' + r.managementType + '" — תורנויות תחילת יום/סוף יום לא שובצו (פרט להרב יאיר אם הוגדר).');
  }

  const slots = buildSlots(model, r);

  // ---------- הסרות ידניות ונעילות ----------
  // blocked: תורנויות שהוסרו ידנית — אותו מורה לא ישובץ שוב לאותה הפסקה,
  //          והמערכת תמצא תורן אחר לעמדה שהתפנתה.
  // pinned:  תורנויות שכבר נקבעו ויש לשמר אותן — כדי שהסרה בודדת
  //          לא תערבב את כל הלוח.
  const blockedSet = new Set(
    (options.blocked || []).map(b => (b.teacher || '') + '|' + (b.day || '') + '|' + (b.break || ''))
  );
  const isBlocked = (teacher, day, brk) => blockedSet.has(teacher.name + '|' + day + '|' + brk);

  // תופס עמדה עבור מורה ומעדכן את מצבו. משותף לשיבוץ ידני ולשיבוץ אוטומטי.
  const takeSlot = (slot, t) => {
    const st = state.get(t.id);
    slot._taken = true;
    assignments.push({
      day: slot.day, break: slot.break, area: slot.area,
      role: slot.role, teacherId: t.id, teacherName: t.name,
    });
    if (slot.mgmt) st.mgmt++;
    else if (slot.patrol) st.patrol = (st.patrol || 0) + 1;
    else if (slot.substitute) st.sub = (st.sub || 0) + 1;
    else if (slot.dynamic) st.dynamic = (st.dynamic || 0) + 1;
    else if (isYardArea(slot.area)) st.yard++;
    else st.building++;
    st.total++;
    st.perDay[slot.day] = (st.perDay[slot.day] || 0) + 1;
    st.assignedSlots.add(slot.day + '|' + slot.break);
  };

  // שיבוצים משומרים — נתפסים ראשונים, לפני כל חישוב אוטומטי.
  for (const p of options.pinned || []) {
    if (!p || !p.teacher) continue;
    if (blockedSet.has(p.teacher + '|' + p.day + '|' + p.break)) continue;
    const t = teachers.find(x => x.name === p.teacher);
    if (!t) continue;
    const st = state.get(t.id);
    if (st.assignedSlots.has(p.day + '|' + p.break)) continue;
    const slot = slots.find(s => !s._taken && s.day === p.day && s.break === p.break
      && (p.area ? s.area === p.area : s.area == null) && s.role === p.role);
    if (!slot) continue;
    takeSlot(slot, t);
  }

  // יעד האיזון חצר/מבנה נגזר מהמצבת בפועל ולא מחצי-חצי:
  // אם 4 מתוך 6 המתחמים הם חצר, היעד לכל מורה הוא שני שלישים חצר.
  const yardSlots = slots.filter((s) => !s.mgmt && !s.patrol && !s.substitute && isYardArea(s.area)).length;
  const buildingSlots = slots.filter((s) => !s.mgmt && !s.patrol && !s.substitute && isBuildingArea(s.area)).length;
  r._yardShare = (yardSlots + buildingSlots) > 0 ? yardSlots / (yardSlots + buildingSlots) : 0.5;

  // קודם — הרב יאיר לתורן תחילת יום בכל יום עבודה מלבד dayOff.
  const days = (model.meta && model.meta.days) || [];
  const startBreak = r.rabbiStartOfDayBreak || 'תחילת יום';
  for (const rb of rabbis) {
    for (const day of days) {
      if (isDayOff(rb, day)) continue;
      if (!worksOnDay(rb, day) && daysOffOf(rb).length) continue;
      if (!worksOnDay(rb, day)) continue;
      if (isBlocked(rb, day, startBreak)) continue;
      const st = state.get(rb.id);
      if (st.assignedSlots.has(day + '|' + startBreak)) continue;
      const slot = slots.find(s => s.day === day && s.break === startBreak && s.mgmt && !s._taken);
      if (!slot) continue;
      takeSlot(slot, rb);
    }
  }

  // שאר עמדות ההנהלה (תחילת/סוף יום) — למורי הנהלה.
  for (const slot of slots) {
    if (!slot.mgmt || slot._taken) continue;
    const cands = management.filter(t => {
      const st = state.get(t.id);
      if (st.assignedSlots.has(slot.day + '|' + slot.break)) return false;
      if (!worksOnDay(t, slot.day)) return false;
      if (isDayOff(t, slot.day)) return false;
      if (isBlocked(t, slot.day, slot.break)) return false;
      if (isExcluded(t, slot, r)) return false;
      if (st.total >= st.quota) return false;
      return true;
    });
    if (!cands.length) continue;
    cands.sort((a, b) => scoreCandidate(a, b, slot, state, r, locations));
    takeSlot(slot, cands[0]);
  }

  // ---------- שלב 2: עמדות חצר/מבנה ----------
  // מיון העמדות כדי לקבל פיזור טוב (יום אחר יום, הפסקה אחר הפסקה).
  const dutySlots = slots.filter(s => !s.mgmt && !s._taken);

  for (const slot of dutySlots) {
    const cands = eligibleForDuty(slot, teachers, state, r)
      .filter(t => !isBlocked(t, slot.day, slot.break));
    if (!cands.length) continue;
    cands.sort((a, b) => scoreCandidate(a, b, slot, state, r, locations));
    takeSlot(slot, cands[0]);
  }

  // ---------- שלב 3: תורנות מ"מ (substitution) — מילוי עמדות שנותרו ----------
  // אם נשארו עמדות לא משובצות ועדיין יש מורים מתחת ל"מכסה+מ"מ" — כבר טופל בשלב 2,
  // כי effectiveQuota כולל את ה-extraSubstitution. אין צורך בשלב נפרד.

  // ---------- ולידציה ----------
  const perTeacher = {};
  let quotasMet = 0;
  let quotasExpected = 0;

  for (const t of teachers) {
    const st = state.get(t.id);
    const total = st.total;
    const expected = st.quota; // כולל מ"מ ואת מגבלת הימים

    let quotaOk = true;

    if (t.noDuty) {
      // חייב להיות אפס
      if (total > 0) {
        violations.push('מורה "' + t.name + '" מסומן ללא תורנות (noDuty) אך שובצו לו ' + total + ' תורנויות.');
        quotaOk = false;
      }
      perTeacher[t.id] = { yard: st.yard, building: st.building, total, quotaOk };
      continue; // לא נספר במכסות
    }

    if (t.type === 'חוגים') {
      // מורי חוגים — אין מכסה; דלג על ספירה.
      perTeacher[t.id] = { yard: st.yard, building: st.building, total, quotaOk: true };
      continue;
    }

    quotasExpected++;

    // תורנויות תחילת יום של הרב הן חובה יומית לפי הכללים, ואינן נספרות במכסה.
    const isRabbi = rabbis.indexOf(t) !== -1;
    const mandated = isRabbi
      ? assignments.filter(a => a.teacherId === t.id && a.break === startBreak).length
      : 0;
    const counted = Math.max(0, total - mandated);

    // מכסה הושגה? (מאפשרים גמישות: total >= מכסת בסיס. ה-מ"מ הוא בונוס.)
    const base = Math.max(0, baseQuota(t, r));
    const nd = typeof t.numDaysWorked === 'number' ? t.numDaysWorked : (t.daysWorked || []).length;
    let cappedBase = (nd < (r.minDaysForFullQuota || 3)) ? Math.min(base, r.lowDaysQuotaCap != null ? r.lowDaysQuotaCap : 2) : base;
    // מי שנוכח כל השבוע — כלל "פחות משלושה ימים" אינו חל עליו.
    if (t.alwaysPresent) cappedBase = base;

    // תורנויות חובה נספרות לזכות המורה במילוי המכסה, אך אינן נחשבות חריגה.
    if (total < cappedBase) {
      violations.push('מורה "' + t.name + '" (' + t.type + '): שובצו ' + total + ' תורנויות מתוך מכסת בסיס ' + cappedBase + '.');
      quotaOk = false;
    } else {
      quotasMet++;
    }

    // חריגה מעבר למכסה+מ"מ? (בלי התורנויות שהכללים מחייבים)
    if (counted > expected) {
      violations.push('מורה "' + t.name + '" שובץ ' + counted + ' תורנויות, מעבר למכסה המרבית ' + expected + '.');
      quotaOk = false;
    }

    // איזון חצר/מבנה — מול היחס הקיים בפועל, לא מול חצי-חצי.
    if (r.balanceYardBuilding && (st.yard + st.building) >= 2) {
      const n = st.yard + st.building;
      const share = r._yardShare != null ? r._yardShare : 0.5;
      const diff = Math.abs(st.yard - n * share);
      const tol = Math.max(1, Math.ceil(n * (r.balanceTolerancePerc != null ? r.balanceTolerancePerc : 0.5)));
      if (diff > tol) {
        const expected = Math.round(n * share);
        violations.push('מורה "' + t.name + '": חוסר איזון חצר/מבנה — ' + st.yard + ' חצר מול ' + st.building
          + ' מבנה (המצופה לפי המצבת: כ-' + expected + ' חצר מתוך ' + n + ').');
        quotaOk = false;
      }
    }

    // בדיקת מגדר וחלון-זמן על השיבוצים בפועל
    const myAssigns = assignments.filter(a => a.teacherId === t.id && a.role !== 'תחילת יום' && a.role !== 'סוף יום');
    for (const a of myAssigns) {
      if (!genderOk(t, a.area, a.day, a.break)) {
        violations.push('מורה "' + t.name + '" שובץ באזור "' + a.area + '" בניגוד למתחם המגדרי שלו (' + effectiveGender(t, a.day, a.break) + ').');
        quotaOk = false;
      }
      if (!withinWorkSpan(t, a.day, a.break, r)) {
        violations.push('מורה "' + t.name + '" שובץ ב-' + a.day + ' / ' + a.break + ' מחוץ לטווח העבודה שלו באותו יום.');
        quotaOk = false;
      }
      if (isExcluded(t, a, r)) {
        violations.push('מורה "' + t.name + '" (' + t.type + ') שובץ ל' + a.role
          + ' ב-' + a.day + ' בניגוד לאיסור שיבוץ מפורש.');
        quotaOk = false;
      }
    }

    perTeacher[t.id] = { yard: st.yard, building: st.building, total, quotaOk };
  }

  // ולידציה: עמדות הנהלה לא מאוישות (אם יש הנהלה אך לא הספיקה)
  const unfilledMgmt = slots.filter(s => s.mgmt && !s._taken);
  if (unfilledMgmt.length && hasManagement) {
    warnings.push('נותרו ' + unfilledMgmt.length + ' עמדות הנהלה (תחילת/סוף יום) ללא שיבוץ.');
  }

  // ולידציה: יאיר שובץ לתחילת יום בכל יום פעיל מלבד dayOff
  for (const rb of rabbis) {
    for (const day of days) {
      if (isDayOff(rb, day)) continue;
      if (!worksOnDay(rb, day)) continue;
      const has = assignments.some(a => a.teacherId === rb.id && a.day === day && a.break === startBreak && a.role === 'תחילת יום');
      if (!has) {
        violations.push('הרב "' + rb.name + '" לא שובץ לתורן תחילת יום ב-' + day + '.');
      }
    }
  }

  // צירוף אזהרות לרשימת ההפרות (כדי שיופיעו בדוח), עם תיוג "אזהרה".
  for (const w of warnings) violations.push(w);

  // ---------- ציון ----------
  // score = שיעור המכסות שהושגו, פחות קנס יחסי על הפרות.
  const quotaScore = quotasExpected > 0 ? quotasMet / quotasExpected : 1;
  const hardViolations = violations.length - warnings.length;
  const penalty = quotasExpected > 0 ? (hardViolations / (quotasExpected * 2)) : 0;
  let score = quotaScore - penalty;
  if (score < 0) score = 0;
  if (score > 1) score = 1;
  score = Math.round(score * 1000) / 1000;

  return { assignments, perTeacher, violations, score };
}

// איסורי שיבוץ מ-config/rules.json. כל כלל מצרף סוגי מורים, ימים ותפקידים
// וגיזרות; שדה שאינו מופיע בכלל אינו מגביל. מחזיר true אם השיבוץ אסור.
function isExcluded(teacher, slot, r) {
  const rules = Array.isArray(r.exclusions) ? r.exclusions : [];
  for (const rule of rules) {
    if (!rule) continue;
    if (Array.isArray(rule.types) && rule.types.indexOf(teacher.type) === -1) continue;
    if (Array.isArray(rule.days) && rule.days.indexOf(slot.day) === -1) continue;
    if (Array.isArray(rule.roles) && rule.roles.indexOf(slot.role) === -1) continue;
    if (Array.isArray(rule.breaks) && rule.breaks.indexOf(slot.break) === -1) continue;
    if (Array.isArray(rule.zones) && rule.zones.indexOf(slot.area) === -1) continue;
    if (Array.isArray(rule.names) && rule.names.indexOf(teacher.name) === -1) continue;
    // onlyRoles — היתר בלעדי: כל תפקיד אחר אסור.
    if (Array.isArray(rule.onlyRoles)) {
      if (rule.onlyRoles.indexOf(slot.role) === -1) return true;
      continue;
    }
    return true;
  }
  return false;
}

// ---------- בחירת מועמדים לתורנות חצר/מבנה ----------
function eligibleForDuty(slot, teachers, state, r) {
  const out = [];
  for (const t of teachers) {
    if (t.noDuty) continue;
    // הנהלה — תחילת/סוף יום, ובנוסף רשאית לקחת תורנות סייר.
    if (t.type === r.managementType && !slot.patrol) continue;
    if (t.type === 'חוגים') continue;              // מורי חוגים ללא תורנות מגרש
    const st = state.get(t.id);
    if (st.total >= st.quota) continue;            // תקרה כוללת (כולל תקרת מורה במיעוט ימים)
    // תורנות מ"מ היא תורנות רזרבה נוספת: אחת לכל מורה, מעבר למכסת התורנויות הרגילות.
    if (slot.substitute) {
      if ((st.sub || 0) >= (r.extraSubstitution || 0)) continue;
    } else if ((st.total - (st.sub || 0)) >= baseQuota(t, r)) {
      continue;                                    // מכסת התורנויות הרגילות מולאה
    }
    if (st.assignedSlots.has(slot.day + '|' + slot.break)) continue; // כבר משובץ באותה הפסקה
    if (!worksOnDay(t, slot.day)) continue;
    // ימי חופש שנקבעו ידנית — אין תורנות בהם גם אם המורה בבית הספר.
    if (isDayOff(t, slot.day)) continue;
    if (!withinWorkSpan(t, slot.day, slot.break, r)) continue; // חלון זמן
    if (!genderOk(t, slot.area, slot.day, slot.break)) continue;  // מגדר
    if (isExcluded(t, slot, r)) continue;           // איסור שיבוץ מפורש
    if (!freeAroundBreak(t, slot.day, slot.break)) continue; // לא מלמד בשני הצדדים
    out.push(t);
  }
  return out;
}

// כל ימי החופש של המורה.
function daysOffOf(teacher) {
  if (Array.isArray(teacher.daysOff) && teacher.daysOff.length) return teacher.daysOff;
  return teacher.dayOff ? [teacher.dayOff] : [];
}
function isDayOff(teacher, day) {
  return daysOffOf(teacher).indexOf(day) !== -1;
}

// כמה ימים בשבוע המורה זמין לתורנות.
// מי שאין עליו נתון זמין בכל יום, ולכן נספר כמלוא ימי הלימוד — לא כאפס.
function availableDayCount(teacher, r) {
  const week = (r && r._weekDays) || 6;
  const off = daysOffOf(teacher).length;
  if (teacher.alwaysPresent) return Math.max(1, week - off);
  const days = Array.isArray(teacher.daysWorked) ? teacher.daysWorked : [];
  if (!days.length) return Math.max(1, week - off);
  return Math.max(1, days.length - off);
}

// ---------- פונקציית ניקוד מועמד (קטן יותר = עדיף) ----------
// משמשת ל-sort: comparator שמחזיר שלילי אם a עדיף על b.
function scoreCandidate(a, b, slot, state, r, locations) {
  return candidateCost(a, slot, state, r, locations) - candidateCost(b, slot, state, r, locations);
}

function candidateCost(t, slot, state, r, locations) {
  const st = state.get(t.id);
  let cost = 0;

  // (1) איזון עומס — לפי אחוז מיצוי המכסה, לא לפי מספר מוחלט.
  // כך מורה שמכסתו גדולה יותר נבחר קודם, והמכסות ממוצות במקום להשתוות.
  cost += (st.quota > 0 ? (st.total / st.quota) : 1) * 300;

  // (2) איזון חצר/מבנה מול היחס הקיים בפועל — מי שכבר מעל היעד באותו סוג נדחה.
  if (!slot.mgmt) {
    const n = st.yard + st.building;
    const share = r._yardShare != null ? r._yardShare : 0.5;
    if (isYardArea(slot.area)) cost += (st.yard - n * share) * 50;
    else if (isBuildingArea(slot.area)) cost += (st.building - n * (1 - share)) * 50;
  }

  // (3) פיזור יומי — העדפה קלה בלבד לפזר על פני ימים. ניתן לכוונון
  // ב-config/rules.json תחת sameDayPenalty; שיבוץ כפול באותו יום מותר.
  const dayPenalty = (r.sameDayPenalty != null) ? r.sameDayPenalty : 40;
  cost += (st.perDay[slot.day] || 0) * dayPenalty;

  // (4) הצמדה לשעת שהייה/פרטני — בונוס (הורדת עלות).
  if (r.preferStandbyAdjacency && !slot.mgmt && adjacentToStandby(t, slot.day, slot.break)) {
    cost -= 60;
  }

  // (5) המתחם שבו המורה כבר נמצא פיזית — הכיתה שלימד בה בשיעור שלפני ההפסקה.
  // זה השיקול החזק ביותר אחרי איזון העומס: לא מחצים את בית הספר בשתי דקות.
  if (!slot.mgmt && ZONES) {
    const near = zonesFromPreviousLesson(t, slot.day, slot.break);
    if (near && near.has(slot.area)) cost -= 120;
  }

  // (6) קרבה לכיתות שהמורה מלמד בכלל (locations) — בונוס משני.
  if (!slot.mgmt && locations) {
    cost -= locationBonus(t, slot.area, locations) * 30;
  }

  // (6) עמדת דינמיקלאס מאוישת בתומכת למידה.
  if (slot.dynamic && t.type === 'תומכת למידה') cost -= 200;

  // (7) מי שזמין בפחות ימים מקבל עדיפות — יש לו פחות הזדמנויות בשבוע,
  // ובלי זה הוא מפסיד כל תחרות ונשאר בלי תורנויות.
  cost += availableDayCount(t, r) * 12;

  // (8) שובר שוויון יציב לפי id.
  cost += idTiebreak(t.id) * 0.001;

  return cost;
}

function idTiebreak(id) {
  const m = /(\d+)/.exec(String(id));
  return m ? parseInt(m[1], 10) : 0;
}

module.exports = { assignDuties };
