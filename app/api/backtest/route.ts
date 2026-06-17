import { NextResponse } from "next/server";

const SQUIGGLE = "https://api.squiggle.com.au";
const SOURCE = 8; // Aggregate model
const YEARS = [2018, 2019, 2020, 2021, 2022, 2023, 2024];

interface SquiggleTip {
  confidence: number;
  correct: number;
  hteam: string;
  ateam: string;
  tip: string;
  year: number;
  round: number;
  margin: number;
}

const BANDS = [
  { label: "65–70%", min: 65, max: 70 },
  { label: "70–75%", min: 70, max: 75 },
  { label: "75–80%", min: 75, max: 80 },
  { label: "80–85%", min: 80, max: 85 },
  { label: "85%+",   min: 85, max: 100 },
];

export async function GET() {
  const allTips: SquiggleTip[] = [];

  for (const year of YEARS) {
    try {
      const res = await fetch(
        `${SQUIGGLE}/?q=tips&year=${year}&complete=100&source=${SOURCE}`,
        { headers: { "User-Agent": "afl-multi-builder/1.0" }, next: { revalidate: 86400 } }
      );
      const data = await res.json();
      if (data.tips) allTips.push(...data.tips);
    } catch {
      // skip failed year
    }
  }

  const bandResults = BANDS.map((band) => {
    const tips = allTips.filter(
      (t) => t.confidence >= band.min && t.confidence < band.max
    );
    const correct = tips.filter((t) => t.correct === 1).length;
    const winRate = tips.length > 0 ? (correct / tips.length) * 100 : 0;

    // implied bookmaker probability mid-band
    const midConfidence = (band.min + band.max) / 2;
    // edge = actual win rate minus model confidence
    const edge = winRate - midConfidence;

    return {
      label: band.label,
      total: tips.length,
      correct,
      winRate: Math.round(winRate * 10) / 10,
      midConfidence,
      edge: Math.round(edge * 10) / 10,
    };
  });

  // overall stats for 70%+ tips (our target zone)
  const targetTips = allTips.filter((t) => t.confidence >= 70);
  const targetCorrect = targetTips.filter((t) => t.correct === 1).length;
  const targetWinRate = targetTips.length > 0 ? (targetCorrect / targetTips.length) * 100 : 0;

  // multi EV calc: 4 legs at average win rate
  const legWinRate = targetWinRate / 100;
  const multiStrikeRate4 = Math.pow(legWinRate, 4) * 100;
  const multiStrikeRate5 = Math.pow(legWinRate, 5) * 100;

  return NextResponse.json({
    bandResults,
    summary: {
      totalGames: allTips.length,
      targetGames: targetTips.length,
      targetWinRate: Math.round(targetWinRate * 10) / 10,
      multiStrikeRate4: Math.round(multiStrikeRate4 * 10) / 10,
      multiStrikeRate5: Math.round(multiStrikeRate5 * 10) / 10,
      yearsAnalysed: YEARS.length,
    },
  });
}
