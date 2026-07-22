@echo off
REM ============================================================
REM  קובץ הפעלה למערכת שיבוץ תורנויות ולוח מגרש (Windows)
REM  בודק תלויות, מריץ את השרת, ופותח את הדפדפן.
REM ============================================================

REM מעבר לתיקיית הסקריפט (גם אם מריצים מתיקייה אחרת)
cd /d "%~dp0"

echo.
echo === מערכת שיבוץ תורנויות ולוח מגרש ===
echo.

REM בדיקה ש-Node.js מותקן
where node >nul 2>nul
if errorlevel 1 (
  echo [שגיאה] לא נמצא Node.js במחשב.
  echo התקינו Node.js מהכתובת https://nodejs.org ואז הריצו שוב.
  pause
  exit /b 1
)

REM התקנת תלויות אם תיקיית node_modules חסרה
if not exist "node_modules" (
  echo מתקין תלויות בפעם הראשונה, אנא המתינו...
  call npm install
  if errorlevel 1 (
    echo [שגיאה] התקנת התלויות נכשלה.
    pause
    exit /b 1
  )
)

REM פתיחת הדפדפן בכתובת המערכת (השרת יעלה תוך רגע)
echo פותח את הדפדפן בכתובת http://localhost:3000 ...
start "" "http://localhost:3000"

REM הרצת השרת (חוסם את החלון עד לסגירה)
echo מפעיל את השרת... לעצירה לחצו Ctrl+C
echo.
call npm start

pause
