// עיבוד יומן ההחלטות (DECISIONS.md) לדף קריא בדפדפן.
// תומך בתת-הקבוצה של Markdown שבשימוש בקובץ: כותרות, טבלאות, רשימות,
// הדגשה, קוד, וקווים מפרידים. אין תלות בספרייה חיצונית.

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// הדגשה, קוד ולינקים בתוך שורה.
function inline(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
}

function isTableRow(line) {
  return /^\s*\|.*\|\s*$/.test(line);
}
function isTableDivider(line) {
  return /^\s*\|[\s:|-]+\|\s*$/.test(line);
}
function cellsOf(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
}

function renderDecisions(md) {
  const lines = String(md).split(/\r?\n/);
  const out = [];
  const toc = [];
  let i = 0;
  let listOpen = null; // 'ul' | 'ol'

  const closeList = () => {
    if (listOpen) { out.push('</' + listOpen + '>'); listOpen = null; }
  };

  while (i < lines.length) {
    const line = lines[i];

    // גוש קוד
    if (/^```/.test(line)) {
      closeList();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
      continue;
    }

    // טבלה
    if (isTableRow(line) && isTableDivider(lines[i + 1] || '')) {
      closeList();
      const head = cellsOf(line);
      i += 2;
      const body = [];
      while (i < lines.length && isTableRow(lines[i])) { body.push(cellsOf(lines[i])); i++; }
      out.push('<div class="table-wrap"><table><thead><tr>'
        + head.map((c) => '<th>' + inline(c) + '</th>').join('')
        + '</tr></thead><tbody>'
        + body.map((r) => '<tr>' + r.map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('')
        + '</tbody></table></div>');
      continue;
    }

    // כותרות
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      const level = h[1].length;
      const text = h[2].trim();
      if (level === 2) {
        const id = 's' + toc.length;
        toc.push({ id, text });
        out.push('<h2 id="' + id + '">' + inline(text) + '</h2>');
      } else {
        out.push('<h' + level + '>' + inline(text) + '</h' + level + '>');
      }
      i++;
      continue;
    }

    // קו מפריד
    if (/^\s*---+\s*$/.test(line)) { closeList(); out.push('<hr>'); i++; continue; }

    // רשימות
    const ol = /^\s*(\d+)\.\s+(.*)$/.exec(line);
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    if (ol || ul) {
      const want = ol ? 'ol' : 'ul';
      if (listOpen !== want) { closeList(); out.push('<' + want + '>'); listOpen = want; }
      out.push('<li>' + inline((ol ? ol[2] : ul[1])) + '</li>');
      i++;
      continue;
    }

    // שורה ריקה
    if (!line.trim()) { closeList(); i++; continue; }

    // פסקה — מאחדת שורות עוקבות
    closeList();
    const buf = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*---+\s*$|\s*[-*]\s|\s*\d+\.\s)/.test(lines[i]) && !isTableRow(lines[i])) {
      buf.push(lines[i].trim());
      i++;
    }
    out.push('<p>' + inline(buf.join(' ')) + '</p>');
  }
  closeList();

  const nav = toc.map((t) => '<a href="#' + t.id + '">' + esc(t.text) + '</a>').join('');

  return `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>יומן החלטות — מערכת התורנויות</title>
<style>
  *{box-sizing:border-box;}
  body{
    margin:0; background:#f3f6fb; color:#1f2d3d;
    font-family:"Segoe UI","Arial Hebrew",Arial,sans-serif; line-height:1.65;
  }
  .wrap{ max-width:1080px; margin:0 auto; padding:28px 20px 60px;
         display:grid; grid-template-columns:230px 1fr; gap:28px; align-items:start; }
  nav{ position:sticky; top:20px; background:#fff; border:1px solid #e2e8f0;
       border-radius:14px; padding:14px; max-height:85vh; overflow:auto; }
  nav b{ display:block; font-size:.82rem; color:#6b7a8d; margin-bottom:8px; }
  nav a{ display:block; padding:5px 8px; border-radius:7px; font-size:.85rem;
         color:#2c5580; text-decoration:none; }
  nav a:hover{ background:#eef5ff; }
  main{ background:#fff; border:1px solid #e2e8f0; border-radius:14px; padding:28px 32px; }
  .back{ display:inline-block; margin-bottom:16px; color:#2c5580; font-size:.9rem; }
  h1{ font-size:1.7rem; margin:0 0 6px; color:#2c5580; }
  h2{ font-size:1.25rem; margin:32px 0 12px; padding-bottom:6px;
      border-bottom:2px solid #e2e8f0; color:#2c5580; scroll-margin-top:20px; }
  h3{ font-size:1.02rem; margin:20px 0 8px; }
  p{ margin:0 0 12px; }
  hr{ border:none; border-top:1px solid #eef1f6; margin:26px 0; }
  ul,ol{ margin:0 0 12px; padding-inline-start:22px; }
  li{ margin:3px 0; }
  code{ background:#f0f4fa; padding:1px 5px; border-radius:5px;
        font-family:ui-monospace,Consolas,monospace; font-size:.88em; }
  pre{ background:#f6f8fc; border:1px solid #e2e8f0; border-radius:10px;
       padding:12px 14px; overflow-x:auto; direction:ltr; text-align:left; }
  pre code{ background:none; padding:0; }
  .table-wrap{ overflow-x:auto; margin:0 0 14px; }
  table{ border-collapse:collapse; width:100%; font-size:.92rem; }
  th,td{ border:1px solid #e2e8f0; padding:7px 10px; text-align:right; vertical-align:top; }
  th{ background:#eef5ff; color:#2c5580; }
  @media (max-width:820px){
    .wrap{ grid-template-columns:1fr; }
    nav{ position:static; max-height:none; }
  }
</style>
</head>
<body>
<div class="wrap">
  <nav><b>ניווט</b>${nav}</nav>
  <main>
    <a class="back" href="/">◂ חזרה למערכת</a>
    ${out.join('\n')}
  </main>
</div>
</body>
</html>`;
}

module.exports = { renderDecisions };
