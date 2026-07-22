// סוכן 2 — לוח מגרש (yard schedule).
// קובע לבד איזו כיתה במגרש בכל חלון/הפסקה, ממוטב לנוחות:
// מעדיף חלון שבו מחנך הכיתה פנוי (freeSlot/standbySlot סמוך) → homeroomPresent.
// אינו מקודד שמות כיתות קשיח — הכל נגזר מהמודל ומ-config/rules.json.

const fs = require('fs');
const path = require('path');

const DEFAULT_BREAKS = ['אחרי 1', 'אחרי 2', 'אחרי 3', 'אחרי 4'];
const AREA_BOYS = 'חצר בנים';
const AREA_GIRLS = 'חצר בנות';

const rulesPath = path.join(__dirname, '..', '..', 'config', 'rules.json');

function loadBreaks() {
  let breaks = null;
  try {
    const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    if (Array.isArray(rules.breaks) && rules.breaks.length) breaks = rules.breaks.slice();
  } catch (_) { /* אין rules.json — ברירת מחדל */ }
  if (!breaks) breaks = DEFAULT_BREAKS.slice();
  // חלונות מגרש הם הפסקות *בין שיעורים* בלבד — מסננים תחילת/סוף יום.
  return breaks.filter(b => b !== 'תחילת יום' && b !== 'סוף יום');
}

// "אחרי N" → הפסקה בין שיעור N לשיעור N+1. צוות "סמוך" אם פנוי בשיעור N או N+1.
function breakToPeriods(brk) {
  const m = /(\d+)/.exec(brk);
  if (!m) return [];
  const n = parseInt(m[1], 10);
  return [n, n + 1];
}

function areaForClass(cls) {
  if (cls && cls.gender === 'בנות') return AREA_GIRLS;
  if (cls && cls.gender === 'בנים') return AREA_BOYS;
  return AREA_BOYS; // ברירת מחדל כשאין הפרדה מגדרית מוגדרת
}

// בונה מפה: teacherId → Set("יום|period") של שעות שהמורה פנוי/שהייה (זמין לליווי מגרש).
function buildAvailability(model) {
  const avail = new Map();
  for (const t of model.teachers || []) {
    const set = new Set();
    for (const s of t.freeSlots || []) set.add(s.day + '|' + s.period);
    for (const s of t.standbySlots || []) set.add(s.day + '|' + s.period);
    avail.set(t.id, set);
  }
  return avail;
}

// כל איש צוות שיש לו שיעור עם הכיתה — מועמד ללוות אותה (מורה מקצועי/מחנך/תומך).
function buildClassStaff(model) {
  const map = new Map(); // classId → Set(teacherId)
  for (const t of model.teachers || []) {
    for (const l of t.lessons || []) {
      if (!l.cls) continue;
      if (!map.has(l.cls)) map.set(l.cls, new Set());
      map.get(l.cls).add(t.id);
    }
  }
  return map;
}

// האם איש צוות כלשהו של הכיתה פנוי בחלון הזה?
function staffFree(classId, day, periods, classStaff, avail) {
  const staff = classStaff.get(classId);
  if (!staff) return false;
  for (const tid of staff) {
    const set = avail.get(tid);
    if (!set) continue;
    for (const p of periods) if (set.has(day + '|' + p)) return true;
  }
  return false;
}

// האם מחנך הכיתה פנוי בחלון? (freeSlot/standby סמוך)
function homeroomFree(homeroomId, day, periods, avail) {
  if (!homeroomId) return false;
  const set = avail.get(homeroomId);
  if (!set) return false;
  for (const p of periods) if (set.has(day + '|' + p)) return true;
  return false;
}

function assignYard(model, options = {}) {
  const warnings = [];
  const days = (model.meta && model.meta.days) || [];
  const breaks = loadBreaks();
  const classes = (model.classes || []).filter(c => c && c.id);

  const avail = buildAvailability(model);
  const classStaff = buildClassStaff(model);
  const homeroomById = new Map();
  for (const c of classes) homeroomById.set(c.id, c.homeroomTeacherId || null);

  // יעד הוגן: לפזר את כל חלונות השבוע בין הכיתות באופן שווה.
  const totalWindows = days.length * breaks.length;          // כמה משבצות חלון×יום קיימות
  const slotsPerWindow = Math.max(1, Math.floor(classes.length / breaks.length) || 1);
  // מטרה: כל כיתה תקבל בערך אותו מספר חלונות לאורך השבוע.
  const targetPerClass = Math.max(1, Math.round((totalWindows * Math.min(slotsPerWindow, classes.length)) / Math.max(1, classes.length)));

  // מצב פיזור פר-כיתה.
  const state = new Map(); // classId → {count, days:Set, windows:Map(brk→n), present:n}
  for (const c of classes) state.set(c.id, { count: 0, days: new Set(), windows: new Map(), present: 0 });

  const slots = [];
  const byClass = {};
  for (const c of classes) byClass[c.id] = [];

  // עבור כל חלון (יום×הפסקה) נבחר אילו כיתות במגרש — slotsPerWindow כיתות.
  for (const day of days) {
    for (const brk of breaks) {
      const periods = breakToPeriods(brk);

      // מועמדות: כיתות עם לפחות איש צוות אחד פנוי בחלון, ושעוד לא הגיעו ליעד.
      const candidates = classes.filter(c => staffFree(c.id, day, periods, classStaff, avail));

      // דירוג: עדיפות (1) מחנך פנוי, (2) פחות חלונות עד כה, (3) טרם שובצה היום,
      // (4) פחות שימוש בחלון הזה (אחרי N) — להימנע מהצפה של אותו חלון.
      const ranked = candidates
        .map(c => {
          const st = state.get(c.id);
          const hp = homeroomFree(homeroomById.get(c.id), day, periods, avail);
          return {
            cls: c,
            hp,
            score:
              (hp ? 1000 : 0) +                       // מחנך פנוי — עדיפות עליונה
              (st.days.has(day) ? -300 : 0) +         // כבר שובצה היום — להוריד
              (st.windows.get(brk) || 0) * -150 +     // הצפת אותו חלון — להוריד
              (targetPerClass - st.count) * 40        // מי שמאחור ביעד — להעלות
          };
        })
        .sort((a, b) => b.score - a.score);

      const take = Math.min(slotsPerWindow, ranked.length);
      const chosenAreas = new Set();
      let placed = 0;
      for (const r of ranked) {
        if (placed >= take) break;
        const st = state.get(r.cls.id);
        if (st.count >= targetPerClass + 1) continue; // לא לחרוג בהרבה מהיעד
        const area = areaForClass(r.cls);
        slots.push({
          day,
          break: brk,
          area,
          classId: r.cls.id,
          homeroomPresent: !!r.hp
        });
        byClass[r.cls.id].push({ day, break: brk });
        st.count++;
        st.days.add(day);
        st.windows.set(brk, (st.windows.get(brk) || 0) + 1);
        if (r.hp) st.present++;
        chosenAreas.add(area);
        placed++;
      }
    }
  }

  // אזהרות.
  let withHomeroom = 0;
  for (const c of classes) {
    const st = state.get(c.id);
    if (st.count === 0) {
      warnings.push(`כיתה ${c.id}: לא שובצה לאף חלון מגרש (אין צוות פנוי בחלונות הזמינים).`);
    } else if (st.present === 0) {
      warnings.push(`כיתה ${c.id}: שובצה ל-${st.count} חלונות אך באף אחד מהם המחנך/ת לא היה פנוי.`);
    }
    if (st.present > 0) withHomeroom++;
  }

  // ציון: שילוב של אחוז כיתות עם מחנך נוכח + איכות הפיזור (פחות סטיית תקן = טוב).
  const counts = classes.map(c => state.get(c.id).count);
  const mean = counts.reduce((a, b) => a + b, 0) / Math.max(1, counts.length);
  const variance = counts.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, counts.length);
  const spreadScore = 1 / (1 + Math.sqrt(variance)); // 0..1, גבוה=פיזור אחיד
  const totalPresent = slots.filter(s => s.homeroomPresent).length;
  const presentRatio = slots.length ? totalPresent / slots.length : 0;
  const score = Math.round((0.6 * presentRatio + 0.4 * spreadScore) * 1000) / 10; // 0..100

  return { slots, byClass, warnings, score };
}

module.exports.assignYard = assignYard;
