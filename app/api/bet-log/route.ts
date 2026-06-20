import { NextResponse } from "next/server";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

interface BetLeg {
  name: string;
  hit: boolean | null;
}

interface Bet {
  id: string;
  date: string;
  game: string;
  type: string;
  legs: BetLeg[];
  odds: number;
  stake: number | null;
  result: "won" | "lost" | "pending" | "not_placed";
  pnl: number;
  notes: string;
}

export async function GET() {
  const filePath = join(process.cwd(), "data", "bet-log.json");
  if (!existsSync(filePath)) {
    return NextResponse.json({ bets: [] });
  }
  try {
    const data = JSON.parse(readFileSync(filePath, "utf8")) as { bets: Bet[] };
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ bets: [] });
  }
}
