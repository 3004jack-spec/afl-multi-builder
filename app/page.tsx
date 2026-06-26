"use client";

import { useEffect, useState, useMemo } from "react";

// ─── Interfaces ───────────────────────────────────────────────────────────────

interface PlayerProp {
  playerName: string;
  matchup: string;
  commenceTime: string;
  statType: string;
  bestOdds: number;
  bestBookie: string;
  bookmakerOdds: Record<string, number>;
  marketLine: number;
  bayesianRate: number;
  bayesianEdge: number;
  hitRate: number;
  hitRate10: number;
  hitRate5: number;
  coldForm: boolean;
  bookmakerImplied: number;
  edge: number;
  recentEdge: number;
  seasonAvg: number;
  recentForm: number[];
  isAlternateLine: boolean;
  gamesAnalysed: number;
  injuryFlag: { team: string; injury: string; returning: string } | null;
  selectionFlag: { status: "out" | "emergency" } | null;
  weatherFlag: { venue: string; precipProbability: number | null; precipMm: number | null; windKph: number | null; wetWeatherFlag: boolean } | null;
}

interface OddsGame {
  homeTeam: string;
  awayTeam: string;
  commenceTime: string;
  bestHome: { bookie: string; odds: number };
  bestAway: { bookie: string; odds: number };
  squiggleConfidence?: number;
  squiggleTip?: string;
}

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

interface BandResult {
  label: string;
  total: number;
  correct: number;
  winRate: number;
  midConfidence: number;
  edge: number;
}

interface Summary {
  totalGames: number;
  targetGames: number;
  targetWinRate: number;
  multiStrikeRate4: number;
  multiStrikeRate5: number;
  yearsAnalysed: number;
}

interface GameLeg {
  playerName: string;
  statType: string;
  suggestedLine: string;
  threshold: number;
  bayesianRate: number;
  hitRate10: number;
  hitRate5: number;
  seasonAvg: number;
  recentForm: number[];
  odds: number;
  bookie: string;
  bookmakerOdds: Record<string, number>;
  matchup: string;
  injuryFlag: { team: string; injury: string; returning: string } | null;
  selectionFlag: { status: "out" | "emergency" } | null;
  weatherFlag: { venue: string; precipProbability: number | null; precipMm: number | null; windKph: number | null; wetWeatherFlag: boolean } | null;
}

interface ComboOption {
  legs: GameLeg[];
  tag: string;
  sr: number;
  odds: number;
  kelly: number;
  halfKelly: number;
  ev: number;
  bookie: string; // every leg in a combo must be priced by this single bookmaker — see bestCombos()
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(iso: string) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-AU", {
    weekday: "short", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function getCombinations<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [first, ...rest] = arr;
  return [
    ...getCombinations(rest, k - 1).map(c => [first, ...c]),
    ...getCombinations(rest, k),
  ];
}

function legsOdds(legs: GameLeg[], boostPct = 0) {
  const raw = legs.reduce((a, l) => a * l.odds, 1);
  return Math.round((boostPct > 0 ? raw * (1 + boostPct / 100) : raw) * 100) / 100;
}

// Validated overconfidence correction (see SESSION_NOTES.md) — model runs ~6% hot,
// applied consistently here and in the line-selection Kelly in /api/player-props.
const CALIBRATION_SHRINK = 0.94;

function legsSR(legs: GameLeg[]) {
  return Math.round(legs.reduce((a, l) => a * (l.bayesianRate / 100) * CALIBRATION_SHRINK, 1) * 1000) / 10;
}

function legsKelly(legs: GameLeg[], boostPct = 0) {
  const odds = legsOdds(legs, boostPct);
  const sr = legsSR(legs) / 100;
  if (odds <= 1) return 0;
  return Math.max(0, Math.round(((sr * odds - 1) / (odds - 1)) * 1000) / 10);
}

// Full Kelly assumes the probability estimate is exactly right — any model error
// blows out bust risk. Half-Kelly trades some growth rate for much more error
// tolerance, which is the standard practical recommendation over full Kelly.
function legsHalfKelly(legs: GameLeg[], boostPct = 0) {
  return Math.round((legsKelly(legs, boostPct) / 2) * 10) / 10;
}

function legsEV(legs: GameLeg[], boostPct = 0, isBonusBet = false) {
  const odds = legsOdds(legs, boostPct);
  const sr = legsSR(legs) / 100;
  return Math.round((isBonusBet ? sr * (odds - 1) * 100 - 100 : sr * odds * 100 - 100) * 10) / 10;
}

// A multi can only be placed on a single bookmaker — you can't combine Leg A's best price from
// Sportsbet with Leg B's best price from Betr into one bet slip. So every combo search below runs
// separately per-bookie (using that bookie's own price for each leg, not the cross-bookie "best
// odds" field), and only the winning bookie's version of a category is surfaced, tagged with which.
function legsForBookie(legs: GameLeg[], bookie: string): GameLeg[] {
  return legs
    .filter(l => l.bookmakerOdds?.[bookie] != null)
    .map(l => ({ ...l, odds: l.bookmakerOdds[bookie], bookie }));
}

function bestCombos(legs: GameLeg[], promoMinOdds: number, boostPct: number, isBonusBet: boolean): ComboOption[] {
  if (legs.length === 0) return [];

  const bookies = [...new Set(legs.flatMap(l => Object.keys(l.bookmakerOdds ?? {})))];
  if (bookies.length === 0) return [];

  const make = (combo: GameLeg[], tag: string, bookie: string): ComboOption => ({
    legs: combo, tag, bookie,
    sr: legsSR(combo),
    odds: legsOdds(combo, boostPct),
    kelly: legsKelly(combo, boostPct),
    halfKelly: legsHalfKelly(combo, boostPct),
    ev: legsEV(combo, boostPct, isBonusBet),
  });

  // Run one category's search against a single bookie's pool, return the winning combo (or null)
  function bestForCategory(pool: GameLeg[], n: number, minSR: number, minOdds: number): GameLeg[] | null {
    if (pool.length < n) return null;
    let best: GameLeg[] | null = null, bestK = -Infinity;
    for (const c of getCombinations(pool.slice(0, n <= 2 ? 12 : n <= 3 ? 10 : 8), n)) {
      const k = legsKelly(c, boostPct);
      if (k > bestK && legsSR(c) >= minSR && legsOdds(c, boostPct) >= minOdds) { bestK = k; best = c; }
    }
    return bestK > 0 ? best : null;
  }

  const options: ComboOption[] = [];

  // For each category, search every bookie's pool independently and keep whichever bookie
  // produced the highest-Kelly result — but that result stays single-bookie internally.
  function addBestAcrossBookies(n: number, tag: string, minSR: number, minOdds = 0) {
    let winner: GameLeg[] | null = null, winnerKelly = -Infinity, winnerBookie = "";
    for (const bookie of bookies) {
      const pool = legsForBookie(legs, bookie).sort((a, b) => b.bayesianRate - a.bayesianRate);
      const combo = bestForCategory(pool, n, minSR, minOdds);
      if (combo) {
        const k = legsKelly(combo, boostPct);
        if (k > winnerKelly) { winnerKelly = k; winner = combo; winnerBookie = bookie; }
      }
    }
    if (winner) options.push(make(winner, tag, winnerBookie));
  }

  // Best single leg — only show if Kelly is positive (genuine edge, not just high confidence)
  {
    let winner: GameLeg | null = null, winnerKelly = -Infinity, winnerBookie = "";
    for (const bookie of bookies) {
      const pool = legsForBookie(legs, bookie).sort((a, b) => b.bayesianRate - a.bayesianRate);
      const top = pool[0];
      if (top?.bayesianRate >= 85) {
        const k = legsKelly([top], boostPct);
        if (k > 0 && k > winnerKelly) { winnerKelly = k; winner = top; winnerBookie = bookie; }
      }
    }
    if (winner) options.push(make([winner], "Top single", winnerBookie));
  }

  addBestAcrossBookies(2, "Best 2-leg", 0);
  addBestAcrossBookies(3, "Best 3-leg", 65);
  addBestAcrossBookies(4, "Best 4-leg", 55);

  // Long shot 5-7 leg: SR ≥ 50%, odds ≥ $3.00, Kelly must be positive — only one bookie's pool, no per-n loop needed
  {
    let winner: GameLeg[] | null = null, winnerKelly = -Infinity, winnerBookie = "";
    for (const bookie of bookies) {
      const pool = legsForBookie(legs, bookie).sort((a, b) => b.bayesianRate - a.bayesianRate);
      for (let n = 5; n <= Math.min(7, pool.length); n++) {
        for (const c of getCombinations(pool.slice(0, 10), n)) {
          const k = legsKelly(c, boostPct);
          if (k > winnerKelly && legsOdds(c, boostPct) >= 3.0) { winnerKelly = k; winner = c; winnerBookie = bookie; }
        }
      }
    }
    if (winner && winnerKelly > 0) options.push(make(winner, `Long shot ${winner.length}-leg`, winnerBookie));
  }

  // Promo option: fewest legs to hit target odds, highest SR — still single-bookie
  if (promoMinOdds > 0) {
    outer: for (let n = 2; n <= 5; n++) {
      for (const bookie of bookies) {
        const pool = legsForBookie(legs, bookie).sort((a, b) => b.bayesianRate - a.bayesianRate);
        if (pool.length < n) continue;
        const src = pool.slice(0, Math.min(pool.length, n + 6));
        const hits = getCombinations(src, n).filter(c => legsOdds(c, boostPct) >= promoMinOdds);
        if (hits.length) {
          const best = hits.sort((a, b) => legsSR(b) - legsSR(a))[0];
          const alreadyShown = options.some(o => o.legs.length === n && legsOdds(o.legs, boostPct) >= promoMinOdds);
          if (!alreadyShown) options.push(make(best, `Promo ${n}-leg (≥$${promoMinOdds})`, bookie));
          break outer;
        }
      }
    }
  }

  return options;
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function Home() {
  const [tab, setTab] = useState<"today" | "multi" | "stats" | "history">("today");
  const [selectedGame, setSelectedGame] = useState<string | null>(null);
  const [gameLegsExpanded, setGameLegsExpanded] = useState(false);
  const [selectedLegs, setSelectedLegs] = useState<GameLeg[]>([]);

  // Promo state
  const [promoMinOdds, setPromoMinOdds] = useState(0);
  const [promoBoostPct, setPromoBoostPct] = useState(0);
  const [isBonusBet, setIsBonusBet] = useState(false);

  // My Multi legs
  const [myLegs, setMyLegs] = useState<GameLeg[]>([]);
  const [myOddsBoostPct, setMyOddsBoostPct] = useState(0);
  const [myIsBonusBet, setMyIsBonusBet] = useState(false);

  // Bankroll
  const [bankroll, setBankroll] = useState<number>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("bankroll");
      return saved ? parseFloat(saved) : 50.33;
    }
    return 50.33;
  });
  const [editingBankroll, setEditingBankroll] = useState(false);
  const [bankrollInput, setBankrollInput] = useState("");

  // Filters
  const [minBayesian, setMinBayesian] = useState(75);

  // Data
  const [games, setGames] = useState<OddsGame[]>([]);
  const [props, setProps] = useState<PlayerProp[]>([]);
  const [bands, setBands] = useState<BandResult[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [namedPlayers, setNamedPlayers] = useState<Set<string>>(new Set());
  const [bets, setBets] = useState<Bet[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch("/api/odds").then(r => r.json()).then(d => setGames(d.games ?? [])),
      fetch("/api/player-props").then(r => r.json()).then(d => setProps(d.props ?? [])),
      fetch("/api/backtest").then(r => r.json()).then(d => { setBands(d.bandResults ?? []); setSummary(d.summary); }),
      fetch("/api/lineups").then(r => r.json()).then(d => setNamedPlayers(new Set(d.named ?? []))).catch(() => {}),
      fetch("/api/bet-log").then(r => r.json()).then(d => setBets(d.bets ?? [])).catch(() => {}),
    ]).finally(() => setLoading(false));
  }, []);

  // Game list — source of truth is the Odds API (correct team names + times)
  const gameList = useMemo(() => {
    const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
    const endOfTomorrow = new Date();
    endOfTomorrow.setDate(endOfTomorrow.getDate() + 2);
    endOfTomorrow.setHours(0, 0, 0, 0);

    return games
      .filter(g => {
        const t = new Date(g.commenceTime).getTime();
        return t > threeHoursAgo && t < endOfTomorrow.getTime();
      })
      .sort((a, b) => new Date(a.commenceTime).getTime() - new Date(b.commenceTime).getTime())
      .map(g => ({
        matchup: `${g.homeTeam} v ${g.awayTeam}`,
        commenceTime: g.commenceTime,
        game: g,
      }));
  }, [games]);

  // Build legs for a game — exact matchup match against player-props (same format, no fuzzy)
  function legsForGame(matchup: string): GameLeg[] {
    const gamePlayers = props.filter(p => p.matchup === matchup).map(p => p.playerName);
    // Only apply lineup filter if Footywire data includes at least one player from THIS game.
    // Prevents weekend selections from blocking a Friday night game where no lineup data exists yet.
    const lineupApplies = namedPlayers.size > 0 && gamePlayers.some(n => namedPlayers.has(n));
    return props
      .filter(p => p.matchup === matchup && !p.coldForm && p.bayesianRate >= minBayesian)
      .filter(p => !lineupApplies || namedPlayers.has(p.playerName))
      .map(p => ({
        playerName: p.playerName,
        statType: p.statType,
        suggestedLine: `${Math.ceil(p.marketLine)}+ ${p.statType}`,
        threshold: Math.ceil(p.marketLine),
        bayesianRate: p.bayesianRate,
        hitRate10: p.hitRate10,
        hitRate5: p.hitRate5,
        seasonAvg: p.seasonAvg,
        recentForm: p.recentForm,
        odds: p.bestOdds,
        bookie: p.bestBookie,
        bookmakerOdds: p.bookmakerOdds,
        matchup,
        injuryFlag: p.injuryFlag,
        selectionFlag: p.selectionFlag,
        weatherFlag: p.weatherFlag,
      }))
      .sort((a, b) => b.bayesianRate - a.bayesianRate);
  }

  function openGame(matchup: string) {
    setSelectedGame(matchup);
    setGameLegsExpanded(false);
    setSelectedLegs([]);
  }

  function selectCombo(legs: GameLeg[]) {
    setSelectedLegs(legs);
  }

  function toggleLeg(leg: GameLeg) {
    const key = (l: GameLeg) => `${l.playerName}::${l.statType}`;
    setSelectedLegs(prev =>
      prev.some(l => key(l) === key(leg))
        ? prev.filter(l => key(l) !== key(leg))
        : [...prev, leg]
    );
  }

  function isSelected(leg: GameLeg) {
    return selectedLegs.some(l => l.playerName === leg.playerName && l.statType === leg.statType);
  }

  // My Multi helpers
  const inMyMulti = (l: GameLeg) => myLegs.some(m => m.playerName === l.playerName && m.statType === l.statType);
  function addToMyMulti(leg: GameLeg) { if (!inMyMulti(leg)) setMyLegs(prev => [...prev, leg]); }
  function removeFromMyMulti(leg: GameLeg) {
    setMyLegs(prev => prev.filter(l => !(l.playerName === leg.playerName && l.statType === leg.statType)));
  }

  // My Multi stats
  const myRawOdds = myLegs.reduce((a, l) => a * l.odds, 1);
  const myOdds = Math.round(myRawOdds * (1 + myOddsBoostPct / 100) * 100) / 100;
  const mySR = myLegs.length ? legsSR(myLegs) : 0;
  const myKelly = myOdds > 1 && mySR > 0 ? legsKelly(myLegs, myOddsBoostPct) : 0;
  const myHalfKelly = myOdds > 1 && mySR > 0 ? legsHalfKelly(myLegs, myOddsBoostPct) : 0;
  const myEV = myLegs.length ? legsEV(myLegs, myOddsBoostPct, myIsBonusBet) : 0;
  const myCorrelated = myLegs.map(l => l.playerName).filter((p, i, a) => a.indexOf(p) !== i);
  // Manually-built multis pick each leg's individually-best-bookie price (see "All legs" list),
  // so two legs can silently come from different bookmakers — not placeable as one bet slip.
  const myBookies = [...new Set(myLegs.map(l => l.bookie))];

  // Selected legs stats
  const selOdds = selectedLegs.length ? legsOdds(selectedLegs, promoBoostPct) : 0;
  const selSR = selectedLegs.length ? legsSR(selectedLegs) : 0;
  const selKelly = legsKelly(selectedLegs, promoBoostPct);
  const selHalfKelly = legsHalfKelly(selectedLegs, promoBoostPct);
  const selEV = selectedLegs.length ? legsEV(selectedLegs, promoBoostPct, isBonusBet) : 0;
  const selCorrelated = selectedLegs.map(l => l.playerName).filter((p, i, a) => a.indexOf(p) !== i);
  const selBookies = [...new Set(selectedLegs.map(l => l.bookie))];

  const promoOptions = [0, 1.5, 2.0, 2.5, 3.0];
  const boostOptions = [0, 5, 10, 15, 20, 25];

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-black text-white">
      {/* Header */}
      <div className="sticky top-0 z-50 bg-black border-b border-gray-800">
        <div className="flex items-center justify-between px-4 py-3">
          <span className="font-bold text-lg">AFL Multi Builder</span>
          <div className="flex items-center gap-2">
            {editingBankroll ? (
              <form onSubmit={e => {
                e.preventDefault();
                const v = parseFloat(bankrollInput);
                if (!isNaN(v) && v > 0) { setBankroll(v); localStorage.setItem("bankroll", String(v)); }
                setEditingBankroll(false);
              }} className="flex gap-1">
                <input autoFocus value={bankrollInput} onChange={e => setBankrollInput(e.target.value)}
                  className="w-20 bg-gray-800 text-white text-sm rounded px-2 py-1 border border-gray-600" placeholder={String(bankroll)} />
                <button type="submit" className="text-xs bg-green-600 px-2 py-1 rounded text-black font-bold">✓</button>
              </form>
            ) : (
              <button onClick={() => { setBankrollInput(String(bankroll)); setEditingBankroll(true); }}
                className="text-sm text-gray-400 hover:text-white">
                Bankroll: <span className="text-green-400 font-bold">${bankroll.toFixed(2)}</span>
              </button>
            )}
          </div>
        </div>
        <div className="flex border-t border-gray-800">
          {(["today", "multi", "history", "stats"] as const).map(t => (
            <button key={t} onClick={() => { setTab(t); setSelectedGame(null); }}
              className={`flex-1 py-3 text-sm font-medium transition-colors ${tab === t ? "text-green-400 border-b-2 border-green-400" : "text-gray-500 hover:text-white"}`}>
              {t === "today" ? "Today / Tomorrow" : t === "multi" ? `My Multi${myLegs.length ? ` (${myLegs.length})` : ""}` : t === "history" ? "History" : "Stats"}
            </button>
          ))}
        </div>
      </div>

      <div className="max-w-lg mx-auto px-4 pb-16 pt-4">

        {/* ── TODAY / TOMORROW ── */}
        {tab === "today" && (
          <div className="space-y-4">
            {loading ? (
              <div className="text-center py-16 text-gray-500">Loading…</div>
            ) : selectedGame ? (
              // ── Game Detail ──
              (() => {
                const gInfo = gameList.find(g => g.matchup === selectedGame);
                const allLegs = legsForGame(selectedGame);
                const combos = bestCombos(allLegs, promoMinOdds, promoBoostPct, isBonusBet);
                const promoHit = promoMinOdds > 0 && selOdds >= promoMinOdds;
                const promoMiss = promoMinOdds > 0 && selectedLegs.length > 0 && selOdds < promoMinOdds;

                return (
                  <div className="space-y-4">
                    {/* Back + title */}
                    <div>
                      <button onClick={() => setSelectedGame(null)} className="text-gray-500 text-sm hover:text-white mb-2">← All games</button>
                      <h2 className="text-xl font-bold">{selectedGame}</h2>
                      {gInfo?.commenceTime && <p className="text-gray-400 text-sm">{formatTime(gInfo.commenceTime)}</p>}
                      {gInfo?.game?.squiggleTip && (
                        <p className="text-xs text-gray-500 mt-1">
                          {gInfo.game.squiggleTip} favoured{gInfo.game.squiggleConfidence ? ` · ${gInfo.game.squiggleConfidence}% confidence` : ""}
                        </p>
                      )}
                    </div>

                    {/* Confidence filter */}
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-500">Min confidence:</span>
                      {[70, 75, 80, 85].map(v => (
                        <button key={v} onClick={() => setMinBayesian(v)}
                          className={`px-2.5 py-1 rounded-lg text-xs font-semibold ${minBayesian === v ? "bg-green-500 text-black" : "bg-gray-800 text-gray-400 hover:bg-gray-700"}`}>
                          {v}%
                        </button>
                      ))}
                    </div>

                    {/* Promo bar */}
                    <div className="bg-gray-900 rounded-xl p-4 space-y-3">
                      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Promotions</p>
                      <div>
                        <p className="text-xs text-gray-500 mb-2">Money-back / bonus if combined odds ≥</p>
                        <div className="flex gap-2 flex-wrap">
                          {promoOptions.map(v => (
                            <button key={v} onClick={() => setPromoMinOdds(v)}
                              className={`px-3 py-1.5 rounded-lg text-sm font-semibold ${promoMinOdds === v ? "bg-green-500 text-black" : "bg-gray-800 text-gray-300 hover:bg-gray-700"}`}>
                              {v === 0 ? "None" : `$${v}`}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500 mb-2">Odds boost</p>
                        <div className="flex gap-2 flex-wrap">
                          {boostOptions.map(v => (
                            <button key={v} onClick={() => setPromoBoostPct(v)}
                              className={`px-3 py-1.5 rounded-lg text-sm font-semibold ${promoBoostPct === v ? "bg-blue-500 text-white" : "bg-gray-800 text-gray-300 hover:bg-gray-700"}`}>
                              {v === 0 ? "None" : `+${v}%`}
                            </button>
                          ))}
                        </div>
                      </div>
                      <label className="flex items-center gap-3 cursor-pointer" onClick={() => setIsBonusBet(v => !v)}>
                        <div className={`w-10 h-5 rounded-full transition-colors ${isBonusBet ? "bg-purple-500" : "bg-gray-700"} relative`}>
                          <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform ${isBonusBet ? "translate-x-5" : "translate-x-0.5"}`} />
                        </div>
                        <span className="text-sm text-gray-300">Bonus bet (stake not returned)</span>
                      </label>
                    </div>

                    {/* Recommended combos */}
                    {allLegs.length === 0 ? (
                      <div className="text-center py-8 text-gray-500">
                        <p>No legs available at {minBayesian}% confidence.</p>
                        <p className="text-sm mt-1">Try lowering the min confidence filter.</p>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Recommended bets</p>
                        {combos.map((opt, i) => (
                          <button key={i} onClick={() => selectCombo(opt.legs)}
                            className={`w-full text-left rounded-xl p-4 border transition-all ${
                              selectedLegs.length === opt.legs.length && opt.legs.every(l => isSelected(l))
                                ? "bg-green-950 border-green-600"
                                : "bg-gray-900 border-gray-800 hover:border-gray-600"
                            }`}>
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-bold text-gray-400 uppercase tracking-wide">{opt.tag}</span>
                                {opt.legs.length > 1 && (
                                  <span className="text-xs px-1.5 py-0.5 rounded border border-gray-700 text-gray-400">{opt.bookie}</span>
                                )}
                              </div>
                              <div className="flex gap-3 text-xs">
                                <span className="text-green-400 font-bold">${opt.odds.toFixed(2)}</span>
                                <span className={opt.sr >= 70 ? "text-green-400" : opt.sr >= 55 ? "text-yellow-400" : "text-orange-400"}>{opt.sr}% SR</span>
                                <span className={opt.ev > 0 ? "text-green-400" : "text-gray-500"}>{opt.ev > 0 ? "+" : ""}{opt.ev}% EV</span>
                              </div>
                            </div>
                            <div className="space-y-1">
                              {opt.legs.map(leg => (
                                <div key={`${leg.playerName}::${leg.statType}`} className="flex justify-between text-sm">
                                  <span className="text-white">{leg.playerName} · <span className="text-gray-400">{leg.suggestedLine}</span></span>
                                  <span className="text-green-400 font-semibold">${leg.odds.toFixed(2)}</span>
                                </div>
                              ))}
                            </div>
                            <div className="mt-2 text-xs text-gray-500">
                              Half-Kelly stake: <span className="text-blue-400 font-bold">${Math.round(bankroll * opt.halfKelly / 100)}</span>
                              {opt.halfKelly > 0 && <span className="ml-2">({opt.halfKelly}% of bankroll)</span>}
                              {opt.kelly > 0 && <span className="ml-2 text-gray-600">· full Kelly {opt.kelly}%</span>}
                            </div>
                          </button>
                        ))}
                      </div>
                    )}

                    {/* Selected legs summary */}
                    {selectedLegs.length > 0 && (
                      <div className={`rounded-xl p-4 space-y-3 ${promoHit ? "bg-green-950 border border-green-700" : promoMiss ? "bg-red-950 border border-red-800" : "bg-gray-900 border border-gray-700"}`}>
                        <div className="flex items-center justify-between">
                          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                            Selected ({selectedLegs.length} leg{selectedLegs.length !== 1 ? "s" : ""})
                          </p>
                          {promoHit && <span className="text-xs bg-green-500 text-black px-2 py-0.5 rounded-full font-bold">✓ Promo qualifies</span>}
                          {promoMiss && <span className="text-xs bg-red-500 text-white px-2 py-0.5 rounded-full font-bold">⚠ Below ${promoMinOdds}</span>}
                        </div>
                        <div className="space-y-1">
                          {selectedLegs.map(leg => (
                            <div key={`${leg.playerName}::${leg.statType}`} className="flex flex-col gap-1">
                            <div className="flex items-center justify-between">
                              <div><span className="text-white text-sm font-medium">{leg.playerName}</span><span className="text-gray-400 text-sm"> · {leg.suggestedLine}</span></div>
                              <div className="flex items-center gap-2">
                                <span className="text-green-400 text-sm font-bold">${leg.odds.toFixed(2)}</span>
                                <span className="text-gray-500 text-xs">{leg.bayesianRate}%</span>
                                <button onClick={() => toggleLeg(leg)} className="text-gray-600 hover:text-red-400 text-xs ml-1">✕</button>
                              </div>
                            </div>
                            {(leg.injuryFlag || leg.selectionFlag || leg.weatherFlag?.wetWeatherFlag) && (
                              <div className="flex gap-1.5 flex-wrap">
                                {leg.selectionFlag && (
                                  <span className={`text-xs px-2 py-0.5 rounded-full border font-semibold ${leg.selectionFlag.status === "out" ? "border-red-600 text-red-400 bg-red-950" : "border-yellow-600 text-yellow-400 bg-yellow-950"}`}>
                                    ⚠ {leg.selectionFlag.status === "out" ? "OUT of side" : "Emergency"}
                                  </span>
                                )}
                                {leg.injuryFlag && (
                                  <span className="text-xs px-2 py-0.5 rounded-full border border-orange-600 text-orange-400 bg-orange-950 font-semibold">
                                    ⚠ {leg.injuryFlag.injury} ({leg.injuryFlag.returning})
                                  </span>
                                )}
                                {leg.weatherFlag?.wetWeatherFlag && (
                                  <span className="text-xs px-2 py-0.5 rounded-full border border-blue-600 text-blue-400 bg-blue-950 font-semibold">
                                    ⚠ Wet weather
                                  </span>
                                )}
                              </div>
                            )}
                            </div>
                          ))}
                        </div>
                        {selCorrelated.length > 0 && (
                          <p className="text-xs text-yellow-400">⚠ {selCorrelated.join(", ")} in multiple legs</p>
                        )}
                        {selBookies.length > 1 && (
                          <p className="text-xs text-red-400 font-semibold">⚠ Mixed bookies ({selBookies.join(" + ")}) — not placeable as one multi, pick legs from a single bookie</p>
                        )}
                        <div className="grid grid-cols-4 gap-2 pt-2 border-t border-gray-800">
                          <div className="text-center">
                            <div className="text-lg font-bold text-white">${selOdds.toFixed(2)}</div>
                            <div className="text-xs text-gray-500">Odds</div>
                          </div>
                          <div className="text-center">
                            <div className={`text-lg font-bold ${selSR >= 60 ? "text-green-400" : selSR >= 40 ? "text-yellow-400" : "text-red-400"}`}>{selSR}%</div>
                            <div className="text-xs text-gray-500">Strike rate</div>
                          </div>
                          <div className="text-center">
                            <div className={`text-lg font-bold ${selEV > 0 ? "text-green-400" : "text-red-400"}`}>{selEV > 0 ? "+" : ""}{selEV}%</div>
                            <div className="text-xs text-gray-500">EV</div>
                          </div>
                          <div className="text-center">
                            <div className="text-lg font-bold text-blue-400">${Math.round(bankroll * selHalfKelly / 100)}</div>
                            <div className="text-xs text-gray-500">Half-Kelly stake</div>
                            <div className="text-[10px] text-gray-600">full Kelly {selKelly}%</div>
                          </div>
                        </div>
                        <div className="flex gap-2 pt-1">
                          <button onClick={() => { selectedLegs.forEach(l => addToMyMulti(l)); setTab("multi"); }}
                            className="flex-1 py-2.5 rounded-lg bg-green-500 text-black text-sm font-bold hover:bg-green-400">
                            Add to My Multi →
                          </button>
                          <button onClick={() => setSelectedLegs([])}
                            className="px-3 py-2.5 rounded-lg bg-gray-800 text-gray-300 text-sm hover:bg-gray-700">
                            Clear
                          </button>
                        </div>
                      </div>
                    )}

                    {/* All legs */}
                    <div>
                      <button onClick={() => setGameLegsExpanded(v => !v)}
                        className="w-full flex items-center justify-between py-2 text-sm text-gray-400 hover:text-white">
                        <span>All legs ({allLegs.length} available · tap to toggle)</span>
                        <span>{gameLegsExpanded ? "▲" : "▼"}</span>
                      </button>
                      <div className="space-y-2 mt-2">
                        {(gameLegsExpanded ? allLegs : allLegs.slice(0, 6)).map(leg => {
                          const sel = isSelected(leg);
                          return (
                            <button key={`${leg.playerName}::${leg.statType}`} onClick={() => toggleLeg(leg)}
                              className={`w-full text-left rounded-xl p-3 border transition-all ${sel ? "bg-green-950 border-green-600" : "bg-gray-900 border-gray-800 hover:border-gray-600"}`}>
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  <div className={`w-4 h-4 rounded border flex items-center justify-center text-xs ${sel ? "bg-green-500 border-green-500 text-black" : "border-gray-600"}`}>
                                    {sel ? "✓" : ""}
                                  </div>
                                  <div>
                                    <span className="text-white text-sm font-medium">{leg.playerName}</span>
                                    <span className="text-gray-400 text-sm"> · {leg.suggestedLine}</span>
                                  </div>
                                </div>
                                <div className="text-right">
                                  <div className="text-green-400 font-bold text-sm">${leg.odds.toFixed(2)}</div>
                                  <div className="text-xs text-gray-500">{leg.bookie}</div>
                                </div>
                              </div>
                              {(leg.injuryFlag || leg.selectionFlag || leg.weatherFlag?.wetWeatherFlag) && (
                                <div className="flex gap-2 mt-2 flex-wrap">
                                  {leg.selectionFlag && (
                                    <span className={`text-xs px-2 py-0.5 rounded-full border font-semibold ${leg.selectionFlag.status === "out" ? "border-red-600 text-red-400 bg-red-950" : "border-yellow-600 text-yellow-400 bg-yellow-950"}`}>
                                      ⚠ {leg.selectionFlag.status === "out" ? "OUT of side" : "Emergency"}
                                    </span>
                                  )}
                                  {leg.injuryFlag && (
                                    <span className="text-xs px-2 py-0.5 rounded-full border border-orange-600 text-orange-400 bg-orange-950 font-semibold">
                                      ⚠ {leg.injuryFlag.injury} ({leg.injuryFlag.returning})
                                    </span>
                                  )}
                                  {leg.weatherFlag?.wetWeatherFlag && (
                                    <span className="text-xs px-2 py-0.5 rounded-full border border-blue-600 text-blue-400 bg-blue-950 font-semibold">
                                      ⚠ Wet weather ({leg.weatherFlag.precipProbability}% rain)
                                    </span>
                                  )}
                                </div>
                              )}
                              {Object.keys(leg.bookmakerOdds ?? {}).length > 1 && (
                                <div className="flex gap-2 mt-2 flex-wrap">
                                  {Object.entries(leg.bookmakerOdds)
                                    .sort((a, b) => b[1] - a[1])
                                    .map(([bookie, price]) => (
                                      <span key={bookie}
                                        className={`text-xs px-2 py-0.5 rounded-full border ${bookie === leg.bookie ? "border-green-600 text-green-400 bg-green-950" : "border-gray-700 text-gray-500"}`}>
                                        {bookie} ${price.toFixed(2)}
                                      </span>
                                    ))}
                                </div>
                              )}
                              <div className="flex gap-3 mt-2 text-xs text-gray-500">
                                <span>Bayesian <span className="text-white font-semibold">{leg.bayesianRate}%</span></span>
                                <span>L10 <span className="text-white">{leg.hitRate10}%</span></span>
                                <span>L5 <span className="text-white">{leg.hitRate5}%</span></span>
                                <span>Avg <span className="text-white">{leg.seasonAvg}</span></span>
                                <span className="text-blue-400 font-semibold">{leg.bayesianRate}% SR</span>
                                {(() => { const ev = Math.round((leg.bayesianRate - (1 / leg.odds) * 100) * 10) / 10; return <span className={ev >= 0 ? "text-green-400 font-semibold" : "text-red-400"}>{ev >= 0 ? "+" : ""}{ev}% EV</span>; })()}
                              </div>
                              <div className="flex gap-1 mt-2">
                                {leg.recentForm.map((v, i) => (
                                  <div key={i} className="flex-1 flex flex-col items-center gap-0.5">
                                    <span className="text-xs text-gray-400">{v}</span>
                                    <div className={`w-full h-1.5 rounded-full ${v >= leg.threshold ? "bg-green-500" : "bg-red-500"}`} />
                                  </div>
                                ))}
                              </div>
                            </button>
                          );
                        })}
                        {!gameLegsExpanded && allLegs.length > 6 && (
                          <button onClick={() => setGameLegsExpanded(true)}
                            className="w-full py-2 text-xs text-gray-500 hover:text-white">
                            Show {allLegs.length - 6} more legs ↓
                          </button>
                        )}
                      </div>
                    </div>

                    <p className="text-xs text-gray-600 text-center">
                      Odds from {[...new Set(allLegs.map(l => l.bookie))].join(", ")} · verify live before placing
                    </p>
                  </div>
                );
              })()
            ) : (
              // ── Game List ──
              <>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">Min confidence:</span>
                  {[70, 75, 80, 85].map(v => (
                    <button key={v} onClick={() => setMinBayesian(v)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-semibold ${minBayesian === v ? "bg-green-500 text-black" : "bg-gray-800 text-gray-400 hover:bg-gray-700"}`}>
                      {v}%
                    </button>
                  ))}
                </div>

                {gameList.length === 0 ? (
                  <div className="text-center py-12 text-gray-500">
                    <p className="text-lg mb-2">No games today or tomorrow</p>
                    <p className="text-sm">Check back closer to the next round</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {gameList.map(({ matchup, commenceTime, game }) => {
                      const legs = legsForGame(matchup);
                      const combos = bestCombos(legs, 0, 0, false);
                      const topCombo = combos.find(c => c.legs.length >= 2) ?? combos[0];
                      const topSingle = legs[0];
                      return (
                        <button key={matchup} onClick={() => openGame(matchup)}
                          className="w-full text-left bg-gray-900 border border-gray-800 rounded-xl p-4 hover:border-green-700 transition-colors">
                          <div className="flex items-start justify-between gap-2 mb-3">
                            <div className="flex-1">
                              <p className="font-semibold text-white">{matchup}</p>
                              <p className="text-xs text-gray-500 mt-0.5">{formatTime(commenceTime)}</p>
                              {game.squiggleTip && (
                                <p className="text-xs text-gray-600 mt-0.5">{game.squiggleTip} favoured{game.squiggleConfidence ? ` · ${game.squiggleConfidence}%` : ""}</p>
                              )}
                              {legs[0]?.weatherFlag?.wetWeatherFlag && (
                                <span className="inline-block text-xs px-2 py-0.5 rounded-full border border-blue-600 text-blue-400 bg-blue-950 font-semibold mt-1">
                                  ⚠ Wet weather ({legs[0].weatherFlag.precipProbability}% rain)
                                </span>
                              )}
                            </div>
                            <div className="text-right shrink-0">
                              <p className="text-xs text-gray-500">{legs.length} legs available</p>
                              {legs.some(l => l.injuryFlag || l.selectionFlag) && (
                                <p className="text-xs text-orange-400 font-semibold mt-0.5">⚠ flags present</p>
                              )}
                            </div>
                          </div>

                          {legs.length === 0 ? (
                            <p className="text-xs text-gray-600">No legs at {minBayesian}% confidence — tap to lower threshold</p>
                          ) : (
                            <div className="space-y-2">
                              {/* Top single if ≥85% */}
                              {topSingle?.bayesianRate >= 85 && (
                                <div className="bg-black bg-opacity-40 rounded-lg p-2.5">
                                  <p className="text-xs text-gray-500 mb-1">Top single</p>
                                  <div className="flex justify-between text-sm">
                                    <span className="text-white">{topSingle.playerName} · <span className="text-gray-400">{topSingle.suggestedLine}</span></span>
                                    <span className="text-green-400 font-bold">${topSingle.odds.toFixed(2)} · {topSingle.bayesianRate}%</span>
                                  </div>
                                </div>
                              )}
                              {/* Best multi */}
                              {topCombo && (
                                <div className="bg-black bg-opacity-40 rounded-lg p-2.5">
                                  <div className="flex justify-between mb-1">
                                    <p className="text-xs text-gray-500">{topCombo.tag} <span className="text-gray-600">({topCombo.bookie})</span></p>
                                    <p className="text-xs">
                                      <span className="text-green-400 font-bold">${topCombo.odds.toFixed(2)}</span>
                                      <span className="text-gray-500"> · {topCombo.sr}% SR</span>
                                    </p>
                                  </div>
                                  {topCombo.legs.map(leg => (
                                    <div key={`${leg.playerName}::${leg.statType}`} className="text-xs text-gray-300">
                                      {leg.playerName} · {leg.suggestedLine}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                          <div className="mt-2 text-right text-xs text-green-600 font-medium">View all bets →</div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ── MY MULTI ── */}
        {tab === "multi" && (
          <div className="space-y-4">
            <p className="text-gray-400 text-sm">Legs added from game views. Tap ✕ to remove.</p>
            <div className="bg-gray-900 rounded-xl p-4 space-y-3">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Promotions</p>
              <div>
                <p className="text-xs text-gray-500 mb-2">Odds boost</p>
                <div className="flex gap-2 flex-wrap">
                  {boostOptions.map(v => (
                    <button key={v} onClick={() => setMyOddsBoostPct(v)}
                      className={`px-3 py-1.5 rounded-lg text-sm font-semibold ${myOddsBoostPct === v ? "bg-blue-500 text-white" : "bg-gray-800 text-gray-300 hover:bg-gray-700"}`}>
                      {v === 0 ? "None" : `+${v}%`}
                    </button>
                  ))}
                </div>
              </div>
              <label className="flex items-center gap-3 cursor-pointer" onClick={() => setMyIsBonusBet(v => !v)}>
                <div className={`w-10 h-5 rounded-full transition-colors ${myIsBonusBet ? "bg-purple-500" : "bg-gray-700"} relative`}>
                  <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform ${myIsBonusBet ? "translate-x-5" : "translate-x-0.5"}`} />
                </div>
                <span className="text-sm text-gray-300">Bonus bet (stake not returned)</span>
              </label>
            </div>

            {myLegs.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
                <p className="text-lg mb-2">No legs added yet</p>
                <p className="text-sm">Go to Today/Tomorrow → pick a game → select a bet → Add to My Multi</p>
                <button onClick={() => setTab("today")} className="mt-4 px-4 py-2 bg-green-600 text-black rounded-lg text-sm font-bold">
                  Browse today's games →
                </button>
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  {myLegs.map(leg => (
                    <div key={`${leg.playerName}::${leg.statType}`} className="bg-gray-900 border border-gray-800 rounded-xl p-3 flex items-center justify-between">
                      <div>
                        <p className="text-white text-sm font-medium">{leg.playerName}</p>
                        <p className="text-green-400 text-sm font-bold">{leg.suggestedLine}</p>
                        <p className="text-xs text-gray-500">{leg.matchup} · {leg.bayesianRate}% · L10 {leg.hitRate10}%</p>
                      </div>
                      <div className="text-right flex items-center gap-3">
                        <div>
                          <p className="text-green-400 font-bold">${leg.odds.toFixed(2)}</p>
                          <p className="text-xs text-gray-500">{leg.bookie}</p>
                        </div>
                        <button onClick={() => removeFromMyMulti(leg)} className="text-gray-600 hover:text-red-400 text-lg">✕</button>
                      </div>
                    </div>
                  ))}
                </div>
                {myCorrelated.length > 0 && (
                  <p className="text-xs text-yellow-400">⚠ {myCorrelated.join(", ")} in multiple legs — true strike rate lower than shown</p>
                )}
                {myBookies.length > 1 && (
                  <p className="text-xs text-red-400 font-semibold">⚠ Mixed bookies ({myBookies.join(" + ")}) — not placeable as one multi, pick legs from a single bookie</p>
                )}
                <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 space-y-3">
                  <div className="grid grid-cols-4 gap-2">
                    <div className="text-center">
                      <div className="text-2xl font-bold text-white">${myOdds.toFixed(2)}</div>
                      {myOddsBoostPct > 0 && <div className="text-xs text-gray-500 line-through">${Math.round(myRawOdds * 100) / 100}</div>}
                      <div className="text-xs text-gray-500">Odds</div>
                    </div>
                    <div className="text-center">
                      <div className={`text-2xl font-bold ${mySR >= 60 ? "text-green-400" : mySR >= 40 ? "text-yellow-400" : "text-red-400"}`}>{mySR}%</div>
                      <div className="text-xs text-gray-500">Strike rate</div>
                    </div>
                    <div className="text-center">
                      <div className={`text-2xl font-bold ${myEV > 0 ? "text-green-400" : "text-red-400"}`}>{myEV > 0 ? "+" : ""}{myEV}%</div>
                      <div className="text-xs text-gray-500">EV</div>
                    </div>
                    <div className="text-center">
                      <div className="text-2xl font-bold text-blue-400">${Math.round(bankroll * myHalfKelly / 100)}</div>
                      <div className="text-xs text-gray-500">Half-Kelly stake</div>
                      <div className="text-[10px] text-gray-600">full Kelly {myKelly}%</div>
                    </div>
                  </div>
                  {myIsBonusBet && <p className="text-xs text-purple-400 text-center">Bonus bet — stake not returned on win</p>}
                  {myOddsBoostPct > 0 && <p className="text-xs text-blue-400 text-center">+{myOddsBoostPct}% odds boost applied</p>}
                </div>
                <button onClick={() => setMyLegs([])} className="w-full py-2 rounded-lg border border-red-900 text-red-400 text-sm hover:bg-red-950">
                  Clear all legs
                </button>
              </>
            )}
          </div>
        )}

        {/* ── HISTORY ── */}
        {tab === "history" && (
          <div className="space-y-4">
            {bets.length === 0 ? (
              <p className="text-gray-500 text-sm text-center py-8">No bets logged yet.</p>
            ) : (
              <>
                {(() => {
                  const settled = bets.filter(b => b.result === "won" || b.result === "lost");
                  const totalStaked = settled.reduce((a, b) => a + (b.stake ?? 0), 0);
                  const totalPnl = settled.reduce((a, b) => a + b.pnl, 0);
                  const pending = bets.filter(b => b.result === "pending");
                  const pendingStaked = pending.reduce((a, b) => a + (b.stake ?? 0), 0);
                  return (
                    <div className="bg-gray-900 rounded-xl p-4 grid grid-cols-3 gap-2 text-center">
                      <div>
                        <p className={`text-lg font-bold ${totalPnl > 0 ? "text-green-400" : totalPnl < 0 ? "text-red-400" : "text-gray-400"}`}>
                          {totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}
                        </p>
                        <p className="text-xs text-gray-500">Net P&L ({settled.length} settled)</p>
                      </div>
                      <div>
                        <p className="text-lg font-bold text-white">${totalStaked.toFixed(0)}</p>
                        <p className="text-xs text-gray-500">Staked (settled)</p>
                      </div>
                      <div>
                        <p className="text-lg font-bold text-yellow-400">${pendingStaked.toFixed(0)}</p>
                        <p className="text-xs text-gray-500">Pending ({pending.length})</p>
                      </div>
                    </div>
                  );
                })()}

                {[...bets].reverse().map(bet => (
                  <div key={bet.id} className="bg-gray-900 rounded-xl p-4 space-y-2">
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="text-white text-sm font-medium">{bet.game}</p>
                        <p className="text-gray-500 text-xs">{bet.date} · {bet.type}</p>
                      </div>
                      <span className={`text-xs font-bold px-2 py-1 rounded-full ${
                        bet.result === "won" ? "bg-green-900 text-green-400" :
                        bet.result === "lost" ? "bg-red-900 text-red-400" :
                        bet.result === "pending" ? "bg-yellow-900 text-yellow-400" :
                        "bg-gray-800 text-gray-500"
                      }`}>
                        {bet.result === "not_placed" ? "not placed" : bet.result}
                      </span>
                    </div>

                    <div className="space-y-1">
                      {bet.legs.map((leg, i) => (
                        <div key={i} className="flex items-center gap-2 text-sm">
                          <span className={
                            leg.hit === true ? "text-green-400" :
                            leg.hit === false ? "text-red-400" :
                            "text-gray-600"
                          }>
                            {leg.hit === true ? "✓" : leg.hit === false ? "✗" : "•"}
                          </span>
                          <span className="text-gray-300">{leg.name}</span>
                        </div>
                      ))}
                    </div>

                    <div className="flex items-center justify-between text-sm pt-1 border-t border-gray-800">
                      <span className="text-gray-400">${bet.odds.toFixed(2)} odds · ${bet.stake ?? 0} stake</span>
                      <span className={`font-bold ${bet.pnl > 0 ? "text-green-400" : bet.pnl < 0 ? "text-red-400" : "text-gray-500"}`}>
                        {bet.pnl !== 0 ? `${bet.pnl > 0 ? "+" : ""}$${bet.pnl.toFixed(2)}` : "—"}
                      </span>
                    </div>

                    {bet.notes && <p className="text-xs text-gray-500 pt-1">{bet.notes}</p>}
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {/* ── STATS ── */}
        {tab === "stats" && (
          <div className="space-y-4">
            {summary && (
              <div className="bg-gray-900 rounded-xl p-4 space-y-1 text-sm">
                <p className="font-semibold text-white mb-2">Model backtest summary</p>
                <p className="text-gray-400">{summary.totalGames} games analysed · {summary.yearsAnalysed} seasons</p>
                <p className="text-gray-400">When model is confident: <span className="text-green-400 font-bold">{summary.targetWinRate}% win rate</span></p>
                <p className="text-gray-400">4-leg multi strike rate: <span className="text-white font-bold">{summary.multiStrikeRate4}%</span></p>
                <p className="text-gray-400">5-leg multi strike rate: <span className="text-white font-bold">{summary.multiStrikeRate5}%</span></p>
              </div>
            )}
            <div className="space-y-2">
              {bands.map(band => (
                <div key={band.label} className="bg-gray-900 rounded-xl p-3 flex items-center justify-between">
                  <div>
                    <p className="text-white text-sm font-medium">{band.label}</p>
                    <p className="text-gray-500 text-xs">{band.total} games</p>
                  </div>
                  <div className="text-right">
                    <p className={`font-bold ${band.winRate >= 70 ? "text-green-400" : band.winRate >= 55 ? "text-yellow-400" : "text-gray-400"}`}>{band.winRate}%</p>
                    <p className={`text-xs ${band.edge > 0 ? "text-green-500" : "text-red-500"}`}>{band.edge > 0 ? "+" : ""}{band.edge}% edge</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
