"use client";

import { useEffect, useState, useMemo } from "react";

// ─── Interfaces ───────────────────────────────────────────────────────────────

interface HistoricalPick {
  playerName: string;
  statType: string;
  suggestedThreshold: number;
  bayesianRate: number;
  hitRate10: number;
  hitRate5: number;
  allTimeRate: number;
  seasonAvg: number;
  recentForm: number[];
  gamesAnalysed: number;
  suggestedLine: string;
  matchup?: string;
}

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
  matchup: string;
  hasLiveOdds: boolean;
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

function legsSR(legs: GameLeg[]) {
  return Math.round(legs.reduce((a, l) => a * (l.bayesianRate / 100), 1) * 1000) / 10;
}

function legsKelly(legs: GameLeg[], boostPct = 0) {
  const odds = legsOdds(legs, boostPct);
  const sr = legsSR(legs) / 100;
  if (odds <= 1) return 0;
  return Math.max(0, Math.round(((sr * odds - 1) / (odds - 1)) * 1000) / 10);
}

function legsEV(legs: GameLeg[], boostPct = 0, isBonusBet = false) {
  const odds = legsOdds(legs, boostPct);
  const sr = legsSR(legs) / 100;
  return Math.round((isBonusBet ? sr * (odds - 1) * 100 - 100 : sr * odds * 100 - 100) * 10) / 10;
}

// Find best combo: if promoMinOdds set, find fewest legs that hit it (maximising strike rate)
// Otherwise: Kelly-optimal across 2–5 legs
function bestCombo(legs: GameLeg[], promoMinOdds: number, boostPct: number): GameLeg[] {
  const pool = legs.slice(0, 18);
  if (pool.length < 2) return pool;

  if (promoMinOdds > 0) {
    for (let n = 2; n <= Math.min(5, pool.length); n++) {
      const combos = getCombinations(pool.slice(0, Math.min(pool.length, n + 6)), n);
      const q = combos.filter(c => legsOdds(c, boostPct) >= promoMinOdds);
      if (q.length) return q.sort((a, b) => legsSR(b) - legsSR(a))[0];
    }
    // Can't hit target — return highest-odds 2-leg combo closest to target
    return getCombinations(pool.slice(0, 8), 2)
      .sort((a, b) => legsOdds(b, boostPct) - legsOdds(a, boostPct))[0] ?? pool.slice(0, 2);
  }

  // No promo: Kelly-optimal
  let bestK = -Infinity, bestLegs = pool.slice(0, 3);
  for (let n = 2; n <= Math.min(5, pool.length); n++) {
    const src = pool.slice(0, n <= 3 ? 14 : 10);
    for (const combo of getCombinations(src, n)) {
      const k = legsKelly(combo, boostPct);
      if (k > bestK) { bestK = k; bestLegs = combo; }
    }
  }
  return bestLegs;
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function Home() {
  const [tab, setTab] = useState<"tonight" | "multi" | "stats">("tonight");
  const [selectedGame, setSelectedGame] = useState<string | null>(null);
  const [gameLegsExpanded, setGameLegsExpanded] = useState(false);
  const [selectedLegs, setSelectedLegs] = useState<GameLeg[]>([]);

  // Promo state
  const [promoMinOdds, setPromoMinOdds] = useState(0);
  const [promoBoostPct, setPromoBoostPct] = useState(0);
  const [isBonusBet, setIsBonusBet] = useState(false);

  // My Multi legs (cross-game manual)
  const [myLegs, setMyLegs] = useState<GameLeg[]>([]);
  const [myOddsBoostPct, setMyOddsBoostPct] = useState(0);
  const [myIsBonusBet, setMyIsBonusBet] = useState(false);

  // Bankroll
  const [bankroll, setBankroll] = useState<number>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("bankroll");
      return saved ? parseInt(saved, 10) : 200;
    }
    return 200;
  });
  const [editingBankroll, setEditingBankroll] = useState(false);
  const [bankrollInput, setBankrollInput] = useState("");

  // Filters
  const [minBayesian, setMinBayesian] = useState(75);

  // Data
  const [games, setGames] = useState<OddsGame[]>([]);
  const [picks, setPicks] = useState<HistoricalPick[]>([]);
  const [props, setProps] = useState<PlayerProp[]>([]);
  const [bands, setBands] = useState<BandResult[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [namedPlayers, setNamedPlayers] = useState<Set<string>>(new Set());
  const [lineupsLoaded, setLineupsLoaded] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch("/api/odds").then(r => r.json()).then(d => setGames(d.games ?? [])),
      fetch(`/api/player-picks?minBayesian=${minBayesian}`).then(r => r.json()).then(d => setPicks(d.picks ?? [])),
      fetch("/api/player-props").then(r => r.json()).then(d => setProps(d.props ?? [])),
      fetch("/api/backtest").then(r => r.json()).then(d => { setBands(d.bandResults ?? []); setSummary(d.summary); }),
      fetch("/api/lineups").then(r => r.json()).then(d => {
        setNamedPlayers(new Set(d.named ?? []));
        setLineupsLoaded(true);
      }).catch(() => setLineupsLoaded(true)),
    ]).finally(() => setLoading(false));
  }, [minBayesian]);

  function lineupOk(name: string) {
    if (!lineupsLoaded || namedPlayers.size === 0) return true;
    return namedPlayers.has(name);
  }

  // Unique game matchups from picks, enriched with odds-API timing
  const gameList = useMemo(() => {
    const matchups = [...new Set(picks.map(p => p.matchup).filter(Boolean))] as string[];
    return matchups.map(matchup => {
      const parts = matchup.toLowerCase().split(" v ");
      const game = games.find(g => {
        const s = `${g.homeTeam} ${g.awayTeam}`.toLowerCase();
        return parts.length === 2 && (s.includes(parts[0].split(" ")[0]) || s.includes(parts[1].split(" ")[0]));
      });
      return { matchup, commenceTime: game?.commenceTime ?? "", game };
    }).sort((a, b) => {
      if (!a.commenceTime) return 1;
      if (!b.commenceTime) return -1;
      return new Date(a.commenceTime).getTime() - new Date(b.commenceTime).getTime();
    });
  }, [picks, games]);

  // Build legs for a given game
  function legsForGame(matchup: string): GameLeg[] {
    return picks
      .filter(p => p.matchup === matchup && lineupOk(p.playerName))
      .map(p => {
        const live = props.find(lp => lp.playerName === p.playerName && lp.statType === p.statType);
        const estOdds = Math.round((100 / p.bayesianRate) * 100) / 100;
        return {
          playerName: p.playerName,
          statType: p.statType,
          suggestedLine: p.suggestedLine,
          threshold: p.suggestedThreshold,
          bayesianRate: p.bayesianRate,
          hitRate10: p.hitRate10,
          hitRate5: p.hitRate5,
          seasonAvg: p.seasonAvg,
          recentForm: p.recentForm,
          odds: live?.bestOdds ?? estOdds,
          bookie: live?.bestBookie ?? "est.",
          matchup,
          hasLiveOdds: !!live,
        };
      })
      .filter(l => l.odds >= 1.04)
      .sort((a, b) => b.bayesianRate - a.bayesianRate);
  }

  function openGame(matchup: string) {
    const legs = legsForGame(matchup);
    setSelectedGame(matchup);
    setGameLegsExpanded(false);
    setSelectedLegs(bestCombo(legs, promoMinOdds, promoBoostPct));
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
  function addToMyMulti(leg: GameLeg) {
    if (!inMyMulti(leg)) setMyLegs(prev => [...prev, leg]);
  }
  function removeFromMyMulti(leg: GameLeg) {
    setMyLegs(prev => prev.filter(l => !(l.playerName === leg.playerName && l.statType === leg.statType)));
  }

  // My Multi stats
  const myRawOdds = myLegs.reduce((a, l) => a * l.odds, 1);
  const myOdds = Math.round(myRawOdds * (1 + myOddsBoostPct / 100) * 100) / 100;
  const mySR = myLegs.length ? Math.round(myLegs.reduce((a, l) => a * (l.bayesianRate / 100), 1) * 1000) / 10 : 0;
  const myKelly = myOdds > 1 && mySR > 0 ? Math.max(0, Math.round(((mySR / 100 * myOdds - 1) / (myOdds - 1)) * 1000) / 10) : 0;
  const myEV = myLegs.length ? Math.round((myIsBonusBet ? mySR / 100 * (myOdds - 1) * 100 - 100 : mySR / 100 * myOdds * 100 - 100) * 10) / 10 : 0;
  const myCorrelated = myLegs.map(l => l.playerName).filter((p, i, a) => a.indexOf(p) !== i);

  // Game detail stats
  const selOdds = selectedLegs.length ? legsOdds(selectedLegs, promoBoostPct) : 0;
  const selSR = selectedLegs.length ? legsSR(selectedLegs) : 0;
  const selKelly = legsKelly(selectedLegs, promoBoostPct);
  const selEV = selectedLegs.length ? legsEV(selectedLegs, promoBoostPct, isBonusBet) : 0;
  const selCorrelated = selectedLegs.map(l => l.playerName).filter((p, i, a) => a.indexOf(p) !== i);

  const promoOptions = [0, 1.5, 2.0, 2.5, 3.0];
  const boostOptions = [0, 5, 10, 15, 20, 25];

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-black text-white">
      {/* Header */}
      <div className="sticky top-0 z-50 bg-black border-b border-gray-800">
        <div className="flex items-center justify-between px-4 py-3">
          <span className="font-bold text-lg">AFL Multi Builder</span>
          {/* Bankroll */}
          <div className="flex items-center gap-2">
            {editingBankroll ? (
              <form onSubmit={e => {
                e.preventDefault();
                const v = parseInt(bankrollInput);
                if (!isNaN(v) && v > 0) {
                  setBankroll(v);
                  localStorage.setItem("bankroll", String(v));
                }
                setEditingBankroll(false);
              }} className="flex gap-1">
                <input autoFocus value={bankrollInput} onChange={e => setBankrollInput(e.target.value)}
                  className="w-20 bg-gray-800 text-white text-sm rounded px-2 py-1 border border-gray-600" placeholder={String(bankroll)} />
                <button type="submit" className="text-xs bg-green-600 px-2 py-1 rounded text-black font-bold">✓</button>
              </form>
            ) : (
              <button onClick={() => { setBankrollInput(String(bankroll)); setEditingBankroll(true); }}
                className="text-sm text-gray-400 hover:text-white">
                Bankroll: <span className="text-green-400 font-bold">${bankroll}</span>
              </button>
            )}
          </div>
        </div>
        {/* Tab bar */}
        <div className="flex border-t border-gray-800">
          {(["tonight", "multi", "stats"] as const).map(t => (
            <button key={t} onClick={() => { setTab(t); setSelectedGame(null); }}
              className={`flex-1 py-3 text-sm font-medium capitalize transition-colors ${tab === t ? "text-green-400 border-b-2 border-green-400" : "text-gray-500 hover:text-white"}`}>
              {t === "tonight" ? "Tonight" : t === "multi" ? `My Multi${myLegs.length ? ` (${myLegs.length})` : ""}` : "Stats"}
            </button>
          ))}
        </div>
      </div>

      <div className="max-w-lg mx-auto px-4 pb-16 pt-4">

        {/* ── TONIGHT ── */}
        {tab === "tonight" && (
          <div className="space-y-4">
            {loading ? (
              <div className="text-center py-16 text-gray-500">Loading games…</div>
            ) : selectedGame ? (
              // ── Game Detail ──
              (() => {
                const gInfo = gameList.find(g => g.matchup === selectedGame);
                const allLegs = legsForGame(selectedGame);
                const promoHit = promoMinOdds > 0 && selOdds >= promoMinOdds;
                const promoMiss = promoMinOdds > 0 && selOdds < promoMinOdds;

                return (
                  <div className="space-y-4">
                    {/* Back + title */}
                    <div>
                      <button onClick={() => setSelectedGame(null)} className="text-gray-500 text-sm hover:text-white mb-2">← All games</button>
                      <h2 className="text-xl font-bold">{selectedGame}</h2>
                      {gInfo?.commenceTime && <p className="text-gray-400 text-sm">{formatTime(gInfo.commenceTime)}</p>}
                      {gInfo?.game && (
                        <p className="text-xs text-gray-500 mt-1">
                          {gInfo.game.squiggleTip ?? gInfo.game.homeTeam} favoured
                          {gInfo.game.squiggleConfidence ? ` · ${gInfo.game.squiggleConfidence}% model confidence` : ""}
                        </p>
                      )}
                    </div>

                    {/* Promo bar */}
                    <div className="bg-gray-900 rounded-xl p-4 space-y-3">
                      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Promotions</p>

                      <div>
                        <p className="text-xs text-gray-500 mb-2">Money-back / bonus if combined odds ≥</p>
                        <div className="flex gap-2 flex-wrap">
                          {promoOptions.map(v => (
                            <button key={v} onClick={() => {
                              setPromoMinOdds(v);
                              const legs = legsForGame(selectedGame);
                              setSelectedLegs(bestCombo(legs, v, promoBoostPct));
                            }}
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

                      <label className="flex items-center gap-3 cursor-pointer">
                        <div className={`w-10 h-5 rounded-full transition-colors ${isBonusBet ? "bg-purple-500" : "bg-gray-700"} relative`}>
                          <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform ${isBonusBet ? "translate-x-5" : "translate-x-0.5"}`} />
                        </div>
                        <span className="text-sm text-gray-300">Bonus bet (stake not returned)</span>
                      </label>
                    </div>

                    {/* Selected legs summary */}
                    {selectedLegs.length > 0 && (
                      <div className={`rounded-xl p-4 space-y-3 ${promoHit ? "bg-green-950 border border-green-700" : promoMiss ? "bg-red-950 border border-red-800" : "bg-gray-900"}`}>
                        <div className="flex items-center justify-between">
                          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                            Your Multi ({selectedLegs.length} leg{selectedLegs.length !== 1 ? "s" : ""})
                          </p>
                          {promoHit && <span className="text-xs bg-green-500 text-black px-2 py-0.5 rounded-full font-bold">✓ Promo qualifies</span>}
                          {promoMiss && <span className="text-xs bg-red-500 text-white px-2 py-0.5 rounded-full font-bold">⚠ Below ${promoMinOdds} target</span>}
                        </div>

                        {/* Legs list */}
                        <div className="space-y-1.5">
                          {selectedLegs.map(leg => (
                            <div key={`${leg.playerName}::${leg.statType}`} className="flex items-center justify-between">
                              <div>
                                <span className="text-white text-sm font-medium">{leg.playerName}</span>
                                <span className="text-gray-400 text-sm"> · {leg.suggestedLine}</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="text-green-400 text-sm font-bold">${leg.odds.toFixed(2)}</span>
                                <span className="text-gray-500 text-xs">{leg.bayesianRate}%</span>
                                <button onClick={() => toggleLeg(leg)} className="text-gray-600 hover:text-red-400 text-xs ml-1">✕</button>
                              </div>
                            </div>
                          ))}
                          {promoBoostPct > 0 && (
                            <div className="flex justify-between text-xs text-blue-400 pt-1 border-t border-gray-800">
                              <span>After +{promoBoostPct}% boost</span>
                              <span>${legsOdds(selectedLegs, promoBoostPct).toFixed(2)}</span>
                            </div>
                          )}
                        </div>

                        {selCorrelated.length > 0 && (
                          <p className="text-xs text-yellow-400">⚠ {selCorrelated.join(", ")} in multiple legs — true strike rate lower than shown</p>
                        )}

                        {/* Stats row */}
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
                            <div className="text-lg font-bold text-blue-400">${Math.round(bankroll * selKelly / 100)}</div>
                            <div className="text-xs text-gray-500">Kelly stake</div>
                          </div>
                        </div>

                        {/* Actions */}
                        <div className="flex gap-2 pt-1">
                          <button
                            onClick={() => {
                              selectedLegs.forEach(l => addToMyMulti(l));
                              setTab("multi");
                            }}
                            className="flex-1 py-2.5 rounded-lg bg-green-500 text-black text-sm font-bold hover:bg-green-400">
                            Add to My Multi →
                          </button>
                          <button
                            onClick={() => {
                              const legs = legsForGame(selectedGame!);
                              setSelectedLegs(bestCombo(legs, promoMinOdds, promoBoostPct));
                            }}
                            className="px-3 py-2.5 rounded-lg bg-gray-800 text-gray-300 text-sm hover:bg-gray-700">
                            ↺ Auto
                          </button>
                        </div>
                      </div>
                    )}

                    {/* All legs */}
                    <div>
                      <button onClick={() => setGameLegsExpanded(v => !v)}
                        className="w-full flex items-center justify-between py-2 text-sm text-gray-400 hover:text-white">
                        <span>All legs for this game ({allLegs.length} available · tap to toggle)</span>
                        <span>{gameLegsExpanded ? "▲" : "▼"}</span>
                      </button>

                      {/* Always show top 5, expand for rest */}
                      <div className="space-y-2 mt-2">
                        {(gameLegsExpanded ? allLegs : allLegs.slice(0, 8)).map(leg => {
                          const sel = isSelected(leg);
                          return (
                            <button key={`${leg.playerName}::${leg.statType}`}
                              onClick={() => toggleLeg(leg)}
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
                                  <div className="text-xs text-gray-500">{leg.hasLiveOdds ? leg.bookie : "est."}</div>
                                </div>
                              </div>
                              <div className="flex gap-3 mt-2 text-xs text-gray-500">
                                <span>Bayesian <span className="text-white font-semibold">{leg.bayesianRate}%</span></span>
                                <span>L10 <span className="text-white">{leg.hitRate10}%</span></span>
                                <span>L5 <span className="text-white">{leg.hitRate5}%</span></span>
                                <span>Avg <span className="text-white">{leg.seasonAvg}</span></span>
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
                        {!gameLegsExpanded && allLegs.length > 8 && (
                          <button onClick={() => setGameLegsExpanded(true)}
                            className="w-full py-2 text-xs text-gray-500 hover:text-white">
                            Show {allLegs.length - 8} more legs ↓
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Odds freshness note */}
                    <p className="text-xs text-gray-600 text-center">
                      Sportsbet odds scraped daily — verify live prices before placing.
                    </p>
                  </div>
                );
              })()
            ) : (
              // ── Game List ──
              <>
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

                {gameList.length === 0 ? (
                  <div className="text-center py-12 text-gray-500">
                    <p className="text-lg mb-2">No games found</p>
                    <p className="text-sm">Run <code className="text-gray-300">node scripts/fetch-player-stats.mjs</code> to update player data</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {gameList.map(({ matchup, commenceTime, game }) => {
                      const legs = legsForGame(matchup);
                      const auto = legs.length >= 2 ? bestCombo(legs, 0, 0) : legs.slice(0, 2);
                      const odds = auto.length ? legsOdds(auto) : 0;
                      const sr = auto.length ? legsSR(auto) : 0;
                      return (
                        <button key={matchup} onClick={() => openGame(matchup)}
                          className="w-full text-left bg-gray-900 border border-gray-800 rounded-xl p-4 hover:border-green-700 transition-colors">
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex-1">
                              <p className="font-semibold text-white">{matchup}</p>
                              {commenceTime && <p className="text-xs text-gray-500 mt-0.5">{formatTime(commenceTime)}</p>}
                              {game?.squiggleTip && (
                                <p className="text-xs text-gray-600 mt-0.5">
                                  {game.squiggleTip} favoured {game.squiggleConfidence ? `· ${game.squiggleConfidence}%` : ""}
                                </p>
                              )}
                            </div>
                            <div className="text-right shrink-0">
                              <p className="text-xs text-gray-500">{legs.length} legs</p>
                              <p className="text-green-400 font-bold">${odds.toFixed(2)}</p>
                              <p className="text-xs text-gray-500">{sr}% strike</p>
                            </div>
                          </div>
                          {auto.length > 0 && (
                            <div className="mt-3 pt-3 border-t border-gray-800">
                              <p className="text-xs text-gray-500 mb-1.5">Best auto-multi ({auto.length} legs)</p>
                              <div className="space-y-1">
                                {auto.map(leg => (
                                  <div key={`${leg.playerName}::${leg.statType}`} className="flex justify-between text-xs">
                                    <span className="text-gray-300">{leg.playerName} · {leg.suggestedLine}</span>
                                    <span className="text-green-400">${leg.odds.toFixed(2)} · {leg.bayesianRate}%</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          <div className="mt-2 text-right text-xs text-green-600 font-medium">View & build →</div>
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

            {/* Promotions */}
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
                <p className="text-sm">Go to Tonight → pick a game → tap legs → Add to My Multi</p>
                <button onClick={() => setTab("tonight")} className="mt-4 px-4 py-2 bg-green-600 text-black rounded-lg text-sm font-bold">
                  Browse tonight's games →
                </button>
              </div>
            ) : (
              <>
                {/* Legs */}
                <div className="space-y-2">
                  {myLegs.map(leg => (
                    <div key={`${leg.playerName}::${leg.statType}`} className="bg-gray-900 border border-gray-800 rounded-xl p-3 flex items-center justify-between">
                      <div>
                        <p className="text-white text-sm font-medium">{leg.playerName}</p>
                        <p className="text-green-400 text-sm font-bold">{leg.suggestedLine}</p>
                        <p className="text-xs text-gray-500">{leg.matchup} · {leg.bayesianRate}% Bayesian · L10 {leg.hitRate10}%</p>
                      </div>
                      <div className="text-right flex items-center gap-3">
                        <div>
                          <p className="text-green-400 font-bold">${leg.odds.toFixed(2)}</p>
                          <p className="text-xs text-gray-500">{leg.hasLiveOdds ? leg.bookie : "est."}</p>
                        </div>
                        <button onClick={() => removeFromMyMulti(leg)} className="text-gray-600 hover:text-red-400 text-lg">✕</button>
                      </div>
                    </div>
                  ))}
                </div>

                {myCorrelated.length > 0 && (
                  <p className="text-xs text-yellow-400">⚠ {myCorrelated.join(", ")} in multiple legs — true strike rate lower than shown</p>
                )}

                {/* Summary */}
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
                      <div className="text-2xl font-bold text-blue-400">${Math.round(bankroll * myKelly / 100)}</div>
                      <div className="text-xs text-gray-500">Kelly stake</div>
                    </div>
                  </div>
                  {myIsBonusBet && <p className="text-xs text-purple-400 text-center">Bonus bet — stake not returned on win</p>}
                  {myOddsBoostPct > 0 && <p className="text-xs text-blue-400 text-center">+{myOddsBoostPct}% odds boost applied</p>}
                </div>

                <button onClick={() => setMyLegs([])}
                  className="w-full py-2 rounded-lg border border-red-900 text-red-400 text-sm hover:bg-red-950">
                  Clear all legs
                </button>
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
