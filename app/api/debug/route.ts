import { NextResponse } from "next/server";

export async function GET() {
  const results: Record<string, unknown> = {};

  // Test 1: AFL events
  try {
    const r = await fetch(
      "https://api.the-odds-api.com/v4/sports/aussierules_afl/events/?apiKey=0f0d4c20983592fffeaa6e1b11206ebd"
    );
    const events = await r.json();
    results.eventsCount = Array.isArray(events) ? events.length : "error";
    results.firstEventId = Array.isArray(events) ? events[0]?.id : null;
  } catch (e) {
    results.eventsError = String(e);
  }

  // Test 2: Player disposal market for first event
  if (results.firstEventId) {
    try {
      const r = await fetch(
        `https://api.the-odds-api.com/v4/sports/aussierules_afl/events/${results.firstEventId}/odds/?apiKey=0f0d4c20983592fffeaa6e1b11206ebd&regions=au&markets=player_disposals&oddsFormat=decimal`
      );
      const data = await r.json();
      const bm = data.bookmakers?.[0];
      const market = bm?.markets?.[0];
      results.disposalBookmakers = data.bookmakers?.length ?? 0;
      results.firstOutcome = market?.outcomes?.[0] ?? null;
      results.firstOutcomeKeys = market?.outcomes?.[0] ? Object.keys(market.outcomes[0]) : [];
    } catch (e) {
      results.disposalError = String(e);
    }
  }

  // Test 3: AFL Tables fetch for Brayshaw
  try {
    const r = await fetch(
      "https://afltables.com/afl/stats/players/A/Andrew_Brayshaw.html",
      { headers: { "User-Agent": "Mozilla/5.0 (compatible; afl-multi-builder/1.0)" } }
    );
    results.aflTablesStatus = r.status;
    if (r.ok) {
      const html = await r.text();
      results.aflTablesLength = html.length;
      results.has2026 = html.includes("2026");
      results.trCount = (html.match(/<tr/gi) || []).length;

      // Test parse: extract first 5 rows and show cell values
      const rowRegex = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
      const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      const rows = html.match(rowRegex) || [];
      const sample: string[][] = [];
      for (const row of rows.slice(0, 20)) {
        const cells: string[] = [];
        let m: RegExpExecArray | null;
        cellRegex.lastIndex = 0;
        while ((m = cellRegex.exec(row)) !== null) {
          cells.push(m[1].replace(/<[^>]+>/g, "").trim());
        }
        if (cells.length >= 10 && !isNaN(parseInt(cells[0]))) {
          sample.push(cells.slice(0, 12));
        }
      }
      results.sampleRows = sample.slice(0, 3);
    }
  } catch (e) {
    results.aflTablesError = String(e);
  }

  return NextResponse.json(results);
}
