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

// ---------- עזרי אזור ----------
function isYardArea(area) {
  return typeof area === 'string' && area.indexOf('חצר') !== -1;
}
function isBuildingArea(area) {
  return typeof area === 'string' && area.indexOf('מבנה') !== -1;
}
function areaGender(area) {
  if (typeof area !== 'string') return null;
  if (area.indexOf('בנות') !== -1) return 'בנות';
  if (area.indexOf('בנים') !== -1) return 'בנים';
  return null;
}
function roleForArea(area) {
  if (isYardArea(area)) return 'חצר';
  if (isBuildingArea(area)) return 'מבנה';
  return 'חצר';
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
  if (nd < (r.minDaysForFullQuota || 3)) {
    q = Math.min(q, r.lowDaysQuotaCap != null ? r.lowDaysQuotaCap : 2);
  }
  return Math.max(0, q);
}

// ---------- בדיקת זמינות זמן (חלון עבודה) ----------
// אסור לשבץ תורנות לפני workSpan.first או אחרי workSpan.last באותו יום,
// מלבד תחילת/סוף יום (הנהלה).
function withinWorkSpan(teacher, day, brk, r) {
  if (isManagementBreak(brk, r)) return true; // תחילת/סוף יום פטורים
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
  if (Array.isArray(teacher.daysWorked) && teacher.daysWorked.length) {
    return teacher.daysWorked.indexOf(day) !== -1;
  }
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

// בדיקת התאמה מגדרית בין מורה לאזור.
function genderOk(teacher, area) {
  const ga = teacher.genderArea;
  if (ga !== 'בנים' && ga !== 'בנות') return true; // null/לא מוגדר → מותר בשני המתחמים
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
function buildSlots(model, r) {
  const days = (model.meta && model.meta.days) || [];
  const areas = r.areas || [];
  const slots = [];
  for (const day of days) {
    for (const brk of r.breaks) {
      // תחילת/סוף יום — עמדות הנהלה (לא חצר/מבנה).
      if (isManagementBreak(brk, r)) {
        const count = (r.stationsOverride && r.stationsOverride[brk] != null) ? r.stationsOverride[brk] : 1;
        for (let i = 0; i < count; i++) {
          slots.push({ day, break: brk, area: null, role: (brk === 'סוף יום' ? 'סוף יום' : 'תחילת יום'), mgmt: true, idx: i });
        }
        continue;
      }
      // הפסקה רגילה — N עמדות תורנות מתחלקות בין האזורים (round-robin), + סייר + מ"מ.
      const posts = postsForBreak(day, brk, r);
      for (let i = 0; i < posts; i++) {
        const area = areas.length ? areas[i % areas.length] : null;
        slots.push({ day, break: brk, area, role: roleForArea(area), mgmt: false, idx: i });
      }
      const patrol = r.patrolPerBreak || 0;
      for (let i = 0; i < patrol; i++) {
        slots.push({ day, break: brk, area: null, role: 'סייר', mgmt: false, patrol: true, idx: i });
      }
      const subs = r.substitutesPerBreak || 0;
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

  const hasManagement = management.length > 0;
  if (!hasManagement) {
    warnings.push('אזהרה: אין אף מורה מסוג "' + r.managementType + '" — תורנויות תחילת יום/סוף יום לא שובצו (פרט להרב יאיר אם הוגדר).');
  }

  const slots = buildSlots(model, r);

  // קודם — הרב יאיר לתורן תחילת יום בכל יום עבודה מלבד dayOff.
  const days = (model.meta && model.meta.days) || [];
  const startBreak = r.rabbiStartOfDayBreak || 'תחילת יום';
  for (const rb of rabbis) {
    for (const day of days) {
      if (rb.dayOff && rb.dayOff === day) continue;
      if (!worksOnDay(rb, day) && rb.dayOff) continue; // אם לא עובד וגם לא יום חופשי מוגדר — נשבץ בכל יום פעיל
      if (!worksOnDay(rb, day)) continue;
      const slot = slots.find(s => s.day === day && s.break === startBreak && s.mgmt && !s._taken);
      if (!slot) continue;
      slot._taken = true;
      const st = state.get(rb.id);
      assignments.push({ day, break: startBreak, area: null, role: 'תחילת יום', teacherId: rb.id, teacherName: rb.name });
      st.mgmt++; st.total++;
      st.perDay[day] = (st.perDay[day] || 0) + 1;
      st.assignedSlots.add(day + '|' + startBreak);
    }
  }

  // שאר עמדות ההנהלה (תחילת/סוף יום) — למורי הנהלה.
  for (const slot of slots) {
    if (!slot.mgmt || slot._taken) continue;
    const cands = management.filter(t => {
      const st = state.get(t.id);
      if (st.assignedSlots.has(slot.day + '|' + slot.break)) return false;
      if (!worksOnDay(t, slot.day)) return false;
      if (st.total >= st.quota) return false;
      return true;
    });
    if (!cands.length) continue;
    cands.sort((a, b) => scoreCandidate(a, b, slot, state, r, locations));
    const chosen = cands[0];
    const st = state.get(chosen.id);
    slot._taken = true;
    assignments.push({ day: slot.day, break: slot.break, area: null, role: slot.role, teacherId: chosen.id, teacherName: chosen.name });
    st.mgmt++; st.total++;
    st.perDay[slot.day] = (st.perDay[slot.day] || 0) + 1;
    st.assignedSlots.add(slot.day + '|' + slot.break);
  }

  // ---------- שלב 2: עמדות חצר/מבנה ----------
  // מיון העמדות כדי לקבל פיזור טוב (יום אחר יום, הפסקה אחר הפסקה).
  const dutySlots = slots.filter(s => !s.mgmt && !s._taken);

  for (const slot of dutySlots) {
    const cands = eligibleForDuty(slot, teachers, state, r);
    if (!cands.length) continue;
    cands.sort((a, b) => scoreCandidate(a, b, slot, state, r, locations));
    const chosen = cands[0];
    const st = state.get(chosen.id);
    slot._taken = true;
    assignments.push({
      day: slot.day, break: slot.break, area: slot.area,
      role: slot.role, teacherId: chosen.id, teacherName: chosen.name,
    });
    // סייר ומ"מ אינם נספרים באיזון חצר/מבנה — רק בסה"כ.
    if (!slot.patrol && !slot.substitute) {
      if (isYardArea(slot.area)) st.yard++; else st.building++;
    } else if (slot.patrol) { st.patrol = (st.patrol || 0) + 1; }
    else if (slot.substitute) { st.sub = (st.sub || 0) + 1; }
    st.total++;
    st.perDay[slot.day] = (st.perDay[slot.day] || 0) + 1;
    st.assignedSlots.add(slot.day + '|' + slot.break);
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

    // מכסה הושגה? (מאפשרים גמישות: total >= מכסת בסיס. ה-מ"מ הוא בונוס.)
    const base = Math.max(0, baseQuota(t, r));
    const nd = typeof t.numDaysWorked === 'number' ? t.numDaysWorked : (t.daysWorked || []).length;
    const cappedBase = (nd < (r.minDaysForFullQuota || 3)) ? Math.min(base, r.lowDaysQuotaCap != null ? r.lowDaysQuotaCap : 2) : base;

    if (total < cappedBase) {
      violations.push('מורה "' + t.name + '" (' + t.type + '): שובצו ' + total + ' תורנויות מתוך מכסת בסיס ' + cappedBase + '.');
      quotaOk = false;
    } else {
      quotasMet++;
    }

    // חריגה מעבר למכסה+מ"מ?
    if (total > expected) {
      violations.push('מורה "' + t.name + '" שובץ ' + total + ' תורנויות, מעבר למכסה המרבית ' + expected + '.');
      quotaOk = false;
    }

    // איזון חצר/מבנה
    if (r.balanceYardBuilding && (st.yard + st.building) >= 2) {
      const diff = Math.abs(st.yard - st.building);
      const tol = Math.max(1, Math.ceil((st.yard + st.building) * (r.balanceTolerancePerc != null ? r.balanceTolerancePerc : 0.5)));
      if (diff > tol) {
        violations.push('מורה "' + t.name + '": חוסר איזון חצר/מבנה — ' + st.yard + ' חצר מול ' + st.building + ' מבנה.');
        quotaOk = false;
      }
    }

    // בדיקת מגדר וחלון-זמן על השיבוצים בפועל
    const myAssigns = assignments.filter(a => a.teacherId === t.id && a.role !== 'תחילת יום' && a.role !== 'סוף יום');
    for (const a of myAssigns) {
      if (!genderOk(t, a.area)) {
        violations.push('מורה "' + t.name + '" שובץ באזור "' + a.area + '" בניגוד למתחם המגדרי שלו (' + t.genderArea + ').');
        quotaOk = false;
      }
      if (!withinWorkSpan(t, a.day, a.break, r)) {
        violations.push('מורה "' + t.name + '" שובץ ב-' + a.day + ' / ' + a.break + ' מחוץ לטווח העבודה שלו באותו יום.');
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
      if (rb.dayOff === day) continue;
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

// ---------- בחירת מועמדים לתורנות חצר/מבנה ----------
function eligibleForDuty(slot, teachers, state, r) {
  const out = [];
  for (const t of teachers) {
    if (t.noDuty) continue;
    if (t.type === r.managementType) continue;     // הנהלה לתחילת/סוף יום בלבד
    if (t.type === 'חוגים') continue;              // מורי חוגים ללא תורנות מגרש
    const st = state.get(t.id);
    if (st.total >= st.quota) continue;            // מכסה (כולל מ"מ) מולאה
    if (st.assignedSlots.has(slot.day + '|' + slot.break)) continue; // כבר משובץ באותה הפסקה
    if (!worksOnDay(t, slot.day)) continue;
    if (!withinWorkSpan(t, slot.day, slot.break, r)) continue; // חלון זמן
    if (!genderOk(t, slot.area)) continue;          // מגדר
    if (!freeAroundBreak(t, slot.day, slot.break)) continue; // לא מלמד בשני הצדדים
    out.push(t);
  }
  return out;
}

// ---------- פונקציית ניקוד מועמד (קטן יותר = עדיף) ----------
// משמשת ל-sort: comparator שמחזיר שלילי אם a עדיף על b.
function scoreCandidate(a, b, slot, state, r, locations) {
  return candidateCost(a, slot, state, r, locations) - candidateCost(b, slot, state, r, locations);
}

function candidateCost(t, slot, state, r, locations) {
  const st = state.get(t.id);
  let cost = 0;

  // (1) איזון עומס כולל — הכי פחות תורנויות עד כה עדיף.
  cost += st.total * 100;

  // (2) איזון חצר/מבנה — אם זו עמדת חצר, מי שיש לו יותר חצר נדחה, ולהפך.
  if (!slot.mgmt) {
    if (isYardArea(slot.area)) cost += (st.yard - st.building) * 25;
    else if (isBuildingArea(slot.area)) cost += (st.building - st.yard) * 25;
  }

  // (3) פיזור יומי — אם כבר יש לו תורנות באותו יום, פחות עדיף.
  cost += (st.perDay[slot.day] || 0) * 40;

  // (4) הצמדה לשעת שהייה/פרטני — בונוס (הורדת עלות).
  if (r.preferStandbyAdjacency && !slot.mgmt && adjacentToStandby(t, slot.day, slot.break)) {
    cost -= 60;
  }

  // (5) קרבה לכיתות (locations) — בונוס.
  if (!slot.mgmt && locations) {
    cost -= locationBonus(t, slot.area, locations) * 30;
  }

  // (6) שובר שוויון יציב לפי id.
  cost += idTiebreak(t.id) * 0.001;

  return cost;
}

function idTiebreak(id) {
  const m = /(\d+)/.exec(String(id));
  return m ? parseInt(m[1], 10) : 0;
}

module.exports = { assignDuties };
