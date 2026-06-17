import { NextResponse } from "next/server";

const SQUIGGLE = "https://api.squiggle.com.au";
const SOURCE = 8;

export async function GET() {
  const currentYear = new Date().getFullYear();

  try {
    // Fetch tips for current year without complete filter to get upcoming games
    const res = await fetch(
      `${SQUIGGLE}/?q=tips&year=${currentYear}&source=${SOURCE}`,
      { headers: { "User-Agent": "afl-multi-builder/1.0" }, next: { revalidate: 3600 } }
    );
    const data = await res.json();
    const tips = data.tips ?? [];

    // Keep only upcoming/incomplete games (correct is null or not yet played)
    // Squiggle sets correct=null for upcoming games
    const upcoming = tips
      .filter((t: { correct: number | null }) => t.correct === null || t.correct === undefined)
      .sort((a: { confidence: number }, b: { confidence: number }) => b.confidence - a.confidence);

    return NextResponse.json({ tips: upcoming });
  } catch {
    return NextResponse.json({ tips: [], error: "Failed to fetch tips" });
  }
}
