import fs from "fs";
const url = "https://afltables.com/afl/stats/players/A/Andrew_Brayshaw.html";
const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } });
const html = await res.text();

function extractTable(html, anchorIdx) {
  const tableStart = html.indexOf("<table", anchorIdx);
  if (tableStart === -1) return null;
  let depth = 0, pos = tableStart, tableEnd = -1;
  while (pos < html.length) {
    const open = html.indexOf("<table", pos);
    const close = html.indexOf("</table>", pos);
    if (close === -1) break;
    if (open !== -1 && open < close) { depth++; pos = open + 6; }
    else { depth--; if (depth === 0) { tableEnd = close + 8; break; } pos = close + 8; }
  }
  return tableEnd === -1 ? null : html.slice(tableStart, tableEnd);
}

const disposals = [];
for (const year of [2024, 2025, 2026]) {
  const anchorIdx = html.indexOf(`name="${year}0"`);
  if (anchorIdx === -1) continue;
  const tableHtml = extractTable(html, anchorIdx);
  if (!tableHtml) continue;
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
    const cells = [];
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let t;
    while ((t = tdRegex.exec(rowMatch[1])) !== null) cells.push(t[1].replace(/<[^>]+>/g,"").trim());
    if (cells.length < 9) continue;
    if (!/^(\d+|EF|QF|SF|PF|GF)$/i.test(cells[2])) continue;
    const d = parseInt(cells[8]);
    if (!isNaN(d) && d >= 0 && d <= 60) disposals.push({ year, round: cells[2], d });
  }
}

console.log(`Total: ${disposals.length} games`);
console.log(`Avg: ${(disposals.reduce((a,b)=>a+b.d,0)/disposals.length).toFixed(1)}`);
console.log(`Hit rate >24.5: ${(disposals.filter(g=>g.d>24.5).length/disposals.length*100).toFixed(1)}%`);
console.log("Sample:", disposals.slice(0,5));
