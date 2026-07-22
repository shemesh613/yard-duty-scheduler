# SPEC — מערכת שיבוץ תורנויות חצר ולוח מגרש

חוזה משותף לכל הסוכנים. **כל מודול חייב לעמוד בממשקים כאן בדיוק** כדי שהכל יתחבר.
שפה: Node.js (CommonJS, `require`/`module.exports`). ללא תלות שלא ב-`package.json`.

## מטרת המערכת
המשתמש (מורה, לא מתכנת) מעלה **קובץ אקסל של מערכת השעות** (פורמט להלן). המערכת:
1. בונה מודל מנורמל + מסיקה מטא-דאטה חסרה.
2. **לוח מגרש** — קובעת לבד איזו כיתה במגרש בכל חלון, ממוטב לנוחות (מחנך עם הכיתה).
3. **לוח תורנויות** — משבצת מורים לתורנויות לפי הכללים.
4. מפיקה אקסל + תצוגת HTML, ומאפשרת הורדה.

> כל הקבצים הם דוגמה. המערכת חייבת לעבוד על **כל** קובץ חדש שיועלה באותו פורמט — אסור לקודד שמות/כיתות קשיח.

## פורמט קובץ הקלט (אקסל)
גיליון יחיד. בשורה ~4 כותרות: `כיתה | יום | שעה | מקצוע | מורה`. כל שורה = שיעור אחד.
- ימים: "יום א".."יום ו". שעות: מספרים 1..9.
- מקצוע "פרטני"/"שהייה" = שעת שהייה (מועמדת להצמדת תורנות).
- כיתות כמו "תפקיד/ ללא כיתה" אינן כיתה אמיתית — מסוננות.

## מודל מנורמל (הפלט של סוכן 1 = הקלט לסוכנים 2,3,4)
ראו דוגמה אמיתית מלאה: `samples/model.sample.json`. הסכמה:
```jsonc
{
  "meta": { "school": string, "sourceFile": string, "days": string[], "periods": number[] },
  "classes": [{ "id":"א1", "grade":"א", "homeroomTeacherId":"t3|null", "gender":"בנים|בנות|null" }],
  "teachers": [{
    "id":"t3", "name":"ויטן לאה",
    "type":"מחנכת|תומכת למידה|מורה מקצועי|מורה משלימה תקשורת|חוגים|הנהלה",
    "rabbi": false,
    "daysWorked": string[], "numDaysWorked": number,
    "noDuty": false,            // (ל) — לא עושה תורנות כלל
    "genderArea": "בנים|בנות|null",
    "homeroomOf": "א1|null",
    "dayOff": "יום ה|null",     // יום חופשי (רלוונטי להרב יאיר)
    "workSpan": { "יום א": {"first":3,"last":6}, ... },   // שעה ראשונה/אחרונה ביום
    "lessons": [{ "day","period","cls","subject","standby":bool }],
    "freeSlots": [{ "day","period" }],      // בתוך טווח העבודה, בלי שיעור
    "standbySlots": [{ "day","period" }]    // שעות שהייה/פרטני
  }],
  "lessons": [{ "day","period","cls","subject","teacher" }]
}
```
שדות מוסקים שניתן לעקוף ידנית: `type`, `noDuty`, `homeroomOf`, `genderArea`, `dayOff`.
ה-overrides נטענים מ-`config/overrides.json` (ראו סוכן 1).

## כללי לוח התורנויות (מההודעה — מקור האמת)
מכסות תורנויות לפי סוג מורה (פלוס תורנות מ"מ = מילוי מקום נוסף):
- תומכת למידה → 2 + מ"מ
- מחנכת → 1 + מ"מ
- מורה משלימה בכיתת תקשורת → 1 + מ"מ
- מורה מקצועי → 2 + מ"מ
- תורנות **תחילת יום** ו**סוף יום** → צוות הנהלה (`type:"הנהלה"`).
- הרב יאיר (`name` מכיל "יאיר") → תורן תחילת יום כל יום מלבד `dayOff`.
- מורה עם `noDuty:true` ((ל)) → אפס תורנויות.
- איזון בין תורנויות **חצר** לתורנויות **מבנה** לכל מורה (≈חצי-חצי).
- מורה עם `numDaysWorked < 3` → 2 תורנויות בלבד (גובר על המכסה).
- הפרדה מגדרית: `genderArea:"בנות"`→מתחם בנות; "בנים"→מתחם בנים.
- קרבה: להעדיף שיבוץ באזור הכיתות שהמורה מלמד (לפי `config/locations.json`, אופציונלי).
- עדיפות להצמיד תורנות **צמוד לשעת שהייה/פרטני** (`standbySlots`).
- אסור לשבץ תורנות לפני השעה הראשונה או אחרי האחרונה של המורה באותו יום (מלבד תחילת/סוף יום).

### חלונות תורנות (zones)
תורנות מתקיימת ב**הפסקה** בין שיעורים. הגדרת ברירת מחדל ב-`config/rules.json`:
```jsonc
{ "breaks": ["תחילת יום","אחרי 1","אחרי 2","אחרי 3","אחרי 4","סוף יום"],
  "areas": ["חצר בנים","חצר בנות","מבנה בנים","מבנה בנות"] }
```
"slot" של תורנות = `{ day, break, area }`. סוכן 3 מחליט כמה עמדות לכל slot (ברירת מחדל מ-rules).

## ממשקי המודולים (חובה — חתימות מדויקות)
### סוכן 1 — `src/engine/parse.js`, `src/engine/infer.js`
```js
// parse.js
module.exports.parseWorkbook = function(buffer|filePath) -> rawLessons[]   // {cls,day,period,subject,teacher}
// infer.js
module.exports.buildModel = function(rawLessons, overrides={}) -> model     // הסכמה למעלה
module.exports.overrideTemplate = function(model) -> overridesObject         // תבנית ריקה לעריכה ידנית
```
### סוכן 2 — `src/engine/yard.js`
```js
module.exports.assignYard = function(model, options={}) -> yardPlan
// yardPlan = { slots:[{day, period|break, area, classId, homeroomPresent:bool}],
//              byClass:{ "א1":[{day,break}] }, warnings:string[], score:number }
```
ממטב: כל כיתה כמות חלונות הוגנת לשבוע; להעדיף חלון שבו מחנך הכיתה פנוי (freeSlot/standby) → `homeroomPresent`.
### סוכן 3 — `src/engine/duty.js`
```js
module.exports.assignDuties = function(model, rules, options={}) -> dutyPlan
// dutyPlan = { assignments:[{day, break, area, role:"חצר|מבנה|תחילת יום|סוף יום|מ\"מ",
//                            teacherId, teacherName}],
//              perTeacher:{ teacherId:{yard:n, building:n, total:n, quotaOk:bool} },
//              violations:string[], score:number }
```
חייב ולידציה: לכל מורה לבדוק מכסה, איזון, מגדר, חלון-זמן. הפרות → `violations`.
### סוכן 4 — `src/engine/report.js`
```js
module.exports.buildWorkbook = function(model, yardPlan, dutyPlan) -> Buffer  // xlsx
module.exports.buildHtml = function(model, yardPlan, dutyPlan) -> string      // עברית RTL
```
גיליונות אקסל: "לוח תורנויות" (יום×הפסקה, תאים=מורים), "לוח מגרש" (יום×חלון, תאים=כיתות),
"בקרה" (מכסות והפרות פר-מורה).
### סוכן 5 — `server.js`, `public/index.html`, `start.bat`
שרת Express. נתיבים:
- `GET /` → ממשק.
- `POST /api/run` (multipart, שדה `file`) → מריץ pipeline, מחזיר JSON `{model, yardPlan, dutyPlan, html, downloadId}`.
- `GET /api/download/:id` → קובץ האקסל.
משתמש ב-`src/engine/index.js` (אורקסטרטור) שמייצא `runPipeline(buffer, overrides) -> {model,yardPlan,dutyPlan,workbookBuffer,html}`.
האורקסטרטור (`src/engine/index.js`) נכתב ע"י השלד — אל תשכתבו אותו; רק עמדו בחתימות.

## בעלות על קבצים (ללא חפיפה!)
- שלד (כבר קיים): `SPEC.md`, `package.json`, `samples/model.sample.json`, `src/engine/index.js`.
- סוכן 1: `src/engine/parse.js`, `src/engine/infer.js`, `config/overrides.example.json`.
- סוכן 2: `src/engine/yard.js`.
- סוכן 3: `src/engine/duty.js`, `config/rules.json`.
- סוכן 4: `src/engine/report.js`.
- סוכן 5: `server.js`, `public/index.html`, `public/style.css`, `start.bat`.

## בדיקה
כל סוכן יבדוק את המודול שלו מול `samples/model.sample.json` עם `node`, וידפיס סיכום שפוי.
פקודת קצה: `npm start` → שרת על http://localhost:3000
