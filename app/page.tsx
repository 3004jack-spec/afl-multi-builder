"use client";

import { useEffect, useState } from "react";

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

interface OddsGame {
  id: string;
  sport: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: string;
  bookmakers: { key: string; name: string; homeOdds: number; awayOdds: number }[];
  bestHome: { bookie: string; odds: number };
  bestAway: { bookie: string; odds: number };
  favourite: string;
  favouriteOdds: number;
  favouriteBookie: string;
  impliedWinPct: number;
  squiggleConfidence?: number;
  squiggleTip?: string;
  confidenceSource: "squiggle" | "odds";
}

interface MultiLeg {
  id: string;
  tip: string;
  confidence: number;
  match: string;
  sport: string;
  odds: number;
  bookie: string;
  confidenceSource: "squiggle" | "odds" | "stats";
}

interface ThresholdPoint {
  threshold: number;
  line: number;
  hitRate: number;
}

interface PlayerProp {
  playerName: string;
  matchup: string;
  statType: string;
  statLabel: string;
  marketLine: number;
  bestOdds: number;
  bestBookie: string;
  gamesAnalysed: number;
  hitRate: number;
  bookmakerImplied: number;
  edge: number;
  recentForm: number[];
  seasonAvg: number;
  thresholds: ThresholdPoint[];
}

function formatTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-AU", { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function Home() {
  const [tab, setTab] = useState<"backtest" | "builder" | "live" | "props" | "auto">("live");
  const [bands, setBands] = useState<BandResult[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [backtestLoading, setBacktestLoading] = useState(true);
  const [games, setGames] = useState<OddsGame[]>([]);
  const [gamesLoading, setGamesLoading] = useState(true);
  const [multi, setMulti] = useState<MultiLeg[]>([]);
  const [props, setProps] = useState<PlayerProp[]>([]);
  const [expandedProp, setExpandedProp] = useState<string | null>(null);
  const [statFilter, setStatFilter] = useState<"all" | "disposals" | "goals" | "marks" | "kicks" | "tackles">("all");
  const [propsLoading, setPropsLoading] = useState(false);
  const [propsLoaded, setPropsLoaded] = useState(false);
  const [edgeFilter, setEdgeFilter] = useState<number>(10);
  const [sportFilter, setSportFilter] = useState<"ALL" | "AFL" | "NRL">("ALL");
  const [confFilter, setConfFilter] = useState<number>(70);

  useEffect(() => {
    fetch("/api/backtest")
      .then((r) => r.json())
      .then((d) => { setBands(d.bandResults); setSummary(d.summary); setBacktestLoading(false); });

    fetch("/api/odds")
      .then((r) => r.json())
      .then((d) => { setGames(d.games ?? []); setGamesLoading(false); });
  }, []);

  function toggleLeg(game: OddsGame) {
    const exists = multi.find((l) => l.id === game.id);
    if (exists) {
      setMulti(multi.filter((l) => l.id !== game.id));
    } else {
      if (multi.length >= 8) return;
      const tip = game.squiggleTip ?? game.favourite;
      const confidence = game.squiggleConfidence ?? game.impliedWinPct;
      setMulti([...multi, {
        id: game.id,
        tip,
        confidence,
        match: `${game.homeTeam} v ${game.awayTeam}`,
        sport: game.sport,
        odds: game.favouriteOdds,
        bookie: game.favouriteBookie,
        confidenceSource: game.confidenceSource,
      }]);
    }
  }

  const combinedOdds = multi.length > 0
    ? Math.round(multi.reduce((acc, l) => acc * l.odds, 1) * 100) / 100
    : 0;

  const strikeRate = multi.length > 0
    ? Math.round(multi.reduce((acc, l) => acc * (l.confidence / 100), 1) * 1000) / 10
    : 0;

  const ev100 = multi.length > 0
    ? Math.round(((strikeRate / 100) * combinedOdds * 100 - 100) * 100) / 100
    : 0;

  // Best Bets: all combinations 1–6 legs, unified list sorted by EV
  interface AutoMultiCombo {
    legs: PlayerProp[];
    combinedOdds: number;
    strikeRate: number;
    ev100: number;
    evPct: number; // ev100 / 100 as a percentage
  }

  function buildAllCombos(pool: PlayerProp[], maxLegs = 6, topN = 20): AutoMultiCombo[] {
    const allResults: AutoMultiCombo[] = [];

    for (let legCount = 1; legCount <= Math.min(maxLegs, pool.length); legCount++) {
      const results: AutoMultiCombo[] = [];

      function combine(start: number, current: PlayerProp[]) {
        if (current.length === legCount) {
          const combinedOdds = Math.round(current.reduce((a, p) => a * p.bestOdds, 1) * 100) / 100;
          const strikeRate = Math.round(current.reduce((a, p) => a * (p.hitRate / 100), 1) * 1000) / 10;
          const ev100 = Math.round(((strikeRate / 100) * combinedOdds * 100 - 100) * 10) / 10;
          const evPct = Math.round(ev100) ; // EV as % of stake
          results.push({ legs: [...current], combinedOdds, strikeRate, ev100, evPct });
          return;
        }
        for (let i = start; i < pool.length; i++) {
          if (current.some((p) => p.playerName === pool[i].playerName)) continue;
          current.push(pool[i]);
          combine(i + 1, current);
          current.pop();
        }
      }

      combine(0, []);
      // Keep top 3 per leg count to avoid flooding the list
      results.sort((a, b) => b.ev100 - a.ev100);
      allResults.push(...results.slice(0, 3));
    }

    return allResults.sort((a, b) => b.ev100 - a.ev100).slice(0, topN);
  }

  // Pool: all props with any positive edge, capped at 12 for perf
  const autoPool = props.filter((p) => p.edge > 0).slice(0, 12);
  const allCombos = buildAllCombos(autoPool);

  const filteredGames = games.filter((g) => {
    const conf = g.squiggleConfidence ?? g.impliedWinPct;
    const sportOk = sportFilter === "ALL" || g.sport === sportFilter;
    return sportOk && conf >= confFilter;
  });

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      {/* Header */}
      <div className="bg-gray-900 border-b border-gray-800 px-4 py-4">
        <h1 className="text-xl font-bold text-white">Multi Builder</h1>
        <p className="text-gray-400 text-sm mt-0.5">AFL · NRL — real odds from 11 bookmakers</p>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-800 bg-gray-900">
        {[
          { key: "live", label: "Match Odds" },
          { key: "props", label: "Player Props" },
          { key: "auto", label: "Auto Multi" },
          { key: "builder", label: "My Multi" },
          { key: "backtest", label: "Backtest" },
        ].map(({ key, label }) => (
          <button
            key={key}
            onClick={() => {
              setTab(key as "backtest" | "builder" | "live" | "props" | "auto");
              if ((key === "props" || key === "auto") && !propsLoaded && !propsLoading) {
                setPropsLoading(true);
                fetch("/api/player-props")
                  .then((r) => r.json())
                  .then((d) => { setProps(d.props ?? []); setPropsLoading(false); setPropsLoaded(true); });
              }
            }}
            className={`px-5 py-3 text-sm font-medium border-b-2 transition-colors ${
              tab === key
                ? "border-green-400 text-green-400"
                : "border-transparent text-gray-400 hover:text-gray-200"
            }`}
          >
            {label}
            {key === "builder" && multi.length > 0 && (
              <span className="ml-2 bg-green-500 text-black text-xs rounded-full px-1.5 py-0.5 font-bold">
                {multi.length}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="p-4 max-w-2xl mx-auto">

        {/* LIVE ODDS TAB */}
        {tab === "live" && (
          <div className="space-y-3">
            {/* Filters */}
            <div className="flex gap-2 flex-wrap">
              <div className="flex gap-1">
                {(["ALL", "AFL", "NRL"] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setSportFilter(s)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                      sportFilter === s
                        ? "bg-green-500 text-black"
                        : "bg-gray-800 text-gray-300 hover:bg-gray-700"
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
              <div className="flex gap-1">
                {[70, 75, 80, 85].map((c) => (
                  <button
                    key={c}
                    onClick={() => setConfFilter(c)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                      confFilter === c
                        ? "bg-blue-500 text-white"
                        : "bg-gray-800 text-gray-300 hover:bg-gray-700"
                    }`}
                  >
                    {c}%+
                  </button>
                ))}
              </div>
            </div>

            {gamesLoading ? (
              <div className="text-center py-16 text-gray-400">
                <div className="text-4xl mb-3">📡</div>
                <p>Fetching live odds from 11 bookmakers…</p>
              </div>
            ) : filteredGames.length === 0 ? (
              <div className="text-center py-12 text-gray-400">
                <div className="text-3xl mb-2">🔍</div>
                <p className="font-medium text-white">No games match this filter</p>
                <p className="text-sm mt-1">Try lowering the confidence threshold.</p>
              </div>
            ) : (
              <>
                <p className="text-gray-500 text-xs">
                  {filteredGames.length} game{filteredGames.length !== 1 ? "s" : ""} · Tap to add to multi
                </p>
                {filteredGames.map((game) => {
                  const inMulti = !!multi.find((l) => l.id === game.id);
                  const confidence = game.squiggleConfidence ?? game.impliedWinPct;
                  const tip = game.squiggleTip ?? game.favourite;

                  return (
                    <button
                      key={game.id}
                      onClick={() => toggleLeg(game)}
                      className={`w-full text-left rounded-xl border p-4 transition-all ${
                        inMulti
                          ? "bg-green-950 border-green-600"
                          : "bg-gray-900 border-gray-800 hover:border-gray-600"
                      }`}
                    >
                      {/* Top row */}
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <span className={`text-xs px-1.5 py-0.5 rounded font-semibold ${
                              game.sport === "AFL" ? "bg-yellow-900 text-yellow-300" : "bg-blue-900 text-blue-300"
                            }`}>
                              {game.sport}
                            </span>
                            {game.confidenceSource === "squiggle" && (
                              <span className="text-xs bg-purple-900 text-purple-300 px-1.5 py-0.5 rounded">
                                Squiggle backed
                              </span>
                            )}
                            {inMulti && (
                              <span className="text-xs bg-green-500 text-black px-1.5 py-0.5 rounded font-bold">
                                IN MULTI ✓
                              </span>
                            )}
                          </div>
                          <div className="font-semibold text-white text-sm">⭐ {tip} to win</div>
                          <div className="text-gray-400 text-xs mt-0.5">
                            {game.homeTeam} v {game.awayTeam}
                          </div>
                          <div className="text-gray-500 text-xs mt-0.5">{formatTime(game.commenceTime)}</div>
                        </div>
                        <div className="text-right ml-4 shrink-0">
                          <div className={`text-2xl font-bold ${
                            confidence >= 85 ? "text-green-400"
                            : confidence >= 80 ? "text-green-400"
                            : confidence >= 75 ? "text-yellow-400"
                            : "text-gray-400"
                          }`}>
                            {confidence}%
                          </div>
                          <div className="text-gray-500 text-xs">
                            {game.confidenceSource === "squiggle" ? "model conf" : "implied"}
                          </div>
                        </div>
                      </div>

                      {/* Best odds row */}
                      <div className="bg-gray-800 rounded-lg p-3">
                        <div className="text-xs text-gray-400 mb-2 font-medium">Best odds per bookie</div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <div className="text-xs text-gray-500 mb-1">{game.homeTeam}</div>
                            <div className="flex items-center gap-2">
                              <span className="text-green-400 font-bold text-sm">${game.bestHome.odds}</span>
                              <span className="text-gray-500 text-xs">@ {game.bestHome.bookie}</span>
                            </div>
                          </div>
                          <div>
                            <div className="text-xs text-gray-500 mb-1">{game.awayTeam}</div>
                            <div className="flex items-center gap-2">
                              <span className="text-green-400 font-bold text-sm">${game.bestAway.odds}</span>
                              <span className="text-gray-500 text-xs">@ {game.bestAway.bookie}</span>
                            </div>
                          </div>
                        </div>
                        {/* All bookmakers */}
                        <div className="mt-2 pt-2 border-t border-gray-700">
                          <div className="flex flex-wrap gap-1">
                            {game.bookmakers.map((bm) => {
                              const favOdds = game.favourite === game.homeTeam ? bm.homeOdds : bm.awayOdds;
                              const isBest = bm.name === game.favouriteBookie;
                              return (
                                <span
                                  key={bm.key}
                                  className={`text-xs px-2 py-1 rounded ${
                                    isBest
                                      ? "bg-green-800 text-green-200 font-semibold"
                                      : "bg-gray-700 text-gray-400"
                                  }`}
                                >
                                  {bm.name} ${favOdds}
                                </span>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </>
            )}
          </div>
        )}

        {/* AUTO MULTI TAB */}
        {tab === "auto" && (
          <div className="space-y-4">
            {!propsLoaded && propsLoading ? (
              <div className="text-center py-16 text-gray-400">
                <div className="text-4xl mb-3">🤖</div>
                <p className="font-medium text-white">Generating best multis…</p>
                <p className="text-sm mt-1 text-gray-500">Fetching player stats and crunching combinations.</p>
              </div>
            ) : !propsLoaded ? (
              <div className="text-center py-16 text-gray-400">
                <div className="text-4xl mb-3">🤖</div>
                <p className="font-medium text-white">Auto Multi</p>
                <p className="text-sm mt-1 mb-4">Generates the highest EV combinations from all current player props.</p>
              </div>
            ) : autoPool.length < 3 ? (
              <div className="text-center py-12 text-gray-400">
                <p className="font-medium text-white">Not enough qualifying props</p>
                <p className="text-sm mt-1">Need at least 3 players with 10%+ edge. Try again closer to game day.</p>
              </div>
            ) : (
              <>
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 text-sm text-gray-400">
                  <p>All bets ranked purely by Expected Value — singles, doubles, multis. The math decides the structure. Pool: {autoPool.length} qualifying props.</p>
                </div>

                <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
                  <div className="px-4 py-3 border-b border-gray-800 grid grid-cols-4 text-xs text-gray-500 font-medium">
                    <span>Bet</span>
                    <span className="text-center">Strike rate</span>
                    <span className="text-center">Odds</span>
                    <span className="text-right">EV / $100</span>
                  </div>
                  <div className="divide-y divide-gray-800">
                    {allCombos.map((combo, idx) => {
                      const legCount = combo.legs.length;
                      const label = legCount === 1 ? "Single" : `${legCount}-leg multi`;
                      return (
                        <div key={idx} className="p-4">
                          {/* Header row */}
                          <div className="grid grid-cols-4 items-center mb-3">
                            <div>
                              <span className={`text-xs font-bold px-2 py-0.5 rounded ${
                                legCount === 1 ? "bg-green-900 text-green-300" :
                                legCount <= 3 ? "bg-blue-900 text-blue-300" :
                                "bg-purple-900 text-purple-300"
                              }`}>
                                {label}
                              </span>
                            </div>
                            <div className="text-center">
                              <span className={`font-bold text-sm ${combo.strikeRate >= 60 ? "text-green-400" : combo.strikeRate >= 35 ? "text-yellow-400" : "text-orange-400"}`}>
                                {combo.strikeRate}%
                              </span>
                            </div>
                            <div className="text-center">
                              <span className="font-bold text-sm text-white">${combo.combinedOdds}</span>
                            </div>
                            <div className="text-right">
                              <span className={`font-bold text-sm ${combo.ev100 >= 0 ? "text-green-400" : "text-red-400"}`}>
                                {combo.ev100 >= 0 ? "+" : ""}${combo.ev100}
                              </span>
                            </div>
                          </div>

                          {/* Legs */}
                          <div className="space-y-1 mb-3">
                            {combo.legs.map((prop) => (
                              <div key={`${prop.playerName}-${prop.statType}`} className="flex items-center justify-between bg-gray-800 rounded px-3 py-1.5 text-xs">
                                <div className="flex-1 min-w-0">
                                  <span className="text-white font-medium">{prop.playerName}</span>
                                  <span className="text-gray-400 ml-1.5">{Math.ceil(prop.marketLine)}+ {prop.statLabel}</span>
                                </div>
                                <div className="flex items-center gap-2 shrink-0 ml-2">
                                  <span className={`font-semibold ${prop.hitRate >= 75 ? "text-green-400" : "text-yellow-400"}`}>{prop.hitRate}%</span>
                                  <span className="text-gray-500">${prop.bestOdds}</span>
                                  <span className="text-gray-500 text-xs">{prop.bestBookie}</span>
                                </div>
                              </div>
                            ))}
                          </div>

                          <button
                            onClick={() => {
                              setMulti([]);
                              combo.legs.forEach((prop) => {
                                const propId = `prop-${prop.playerName}-${prop.statType}`;
                                setMulti((prev) => [...prev, {
                                  id: propId,
                                  tip: `${prop.playerName} ${Math.ceil(prop.marketLine)}+ ${prop.statLabel}`,
                                  confidence: prop.hitRate,
                                  match: prop.matchup,
                                  sport: "AFL",
                                  odds: prop.bestOdds,
                                  bookie: prop.bestBookie,
                                  confidenceSource: "stats",
                                }]);
                              });
                              setTab("builder");
                            }}
                            className="w-full py-1.5 bg-green-700 hover:bg-green-600 text-white text-xs font-semibold rounded-lg transition-colors"
                          >
                            Use this bet →
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 text-sm text-gray-400 space-y-1.5">
                  <p><span className="text-white">EV / $100</span> = expected profit per $100 staked, long run. +$56 on a single means you profit $56 for every $100 bet on average.</p>
                  <p><span className="text-white">Strike rate</span> = how often this bet wins. A single at 83% wins 5 of every 6. A 6-leg at 17% wins roughly 1 in 6.</p>
                  <p>Higher EV multi ≠ better — higher variance means longer losing runs. Size stakes accordingly.</p>
                </div>
              </>
            )}
          </div>
        )}

        {/* MULTI BUILDER TAB */}
        {tab === "builder" && (
          <div className="space-y-4">
            {multi.length === 0 ? (
              <div className="text-center py-16 text-gray-400">
                <div className="text-4xl mb-3">🏈</div>
                <p className="font-medium text-white">No legs added yet</p>
                <p className="text-sm mt-1">Go to <strong>Live Odds</strong> and tap games to add them.</p>
                <button
                  onClick={() => setTab("live")}
                  className="mt-4 bg-green-500 text-black font-semibold px-5 py-2 rounded-lg text-sm"
                >
                  Browse Live Odds →
                </button>
              </div>
            ) : (
              <>
                {/* Summary */}
                <div className="bg-green-950 border border-green-800 rounded-xl p-4">
                  <div className="grid grid-cols-3 gap-3 text-center">
                    <div>
                      <div className="text-2xl font-bold text-white">${combinedOdds}</div>
                      <div className="text-green-300 text-xs mt-0.5">Combined odds</div>
                    </div>
                    <div>
                      <div className="text-2xl font-bold text-white">{strikeRate}%</div>
                      <div className="text-green-300 text-xs mt-0.5">Est. strike rate</div>
                    </div>
                    <div>
                      <div className={`text-2xl font-bold ${ev100 >= 0 ? "text-green-400" : "text-red-400"}`}>
                        {ev100 >= 0 ? "+" : ""}${ev100}
                      </div>
                      <div className="text-green-300 text-xs mt-0.5">EV per $100</div>
                    </div>
                  </div>
                </div>

                {/* Legs */}
                <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
                  <div className="px-4 py-3 border-b border-gray-800 flex justify-between items-center">
                    <h2 className="font-semibold">Your multi ({multi.length} legs)</h2>
                    <button onClick={() => setMulti([])} className="text-red-400 text-xs hover:text-red-300">
                      Clear all
                    </button>
                  </div>
                  <div className="divide-y divide-gray-800">
                    {multi.map((leg) => (
                      <div key={leg.id} className="px-4 py-3 flex items-center justify-between">
                        <div>
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className={`text-xs px-1.5 py-0.5 rounded font-semibold ${
                              leg.sport === "AFL" ? "bg-yellow-900 text-yellow-300" : "bg-blue-900 text-blue-300"
                            }`}>
                              {leg.sport}
                            </span>
                          </div>
                          <div className="font-medium text-sm">{leg.tip}</div>
                          <div className="text-gray-400 text-xs">{leg.match}</div>
                          <div className="text-gray-500 text-xs mt-0.5">Best odds @ {leg.bookie}</div>
                        </div>
                        <div className="flex items-center gap-3">
                          <div className="text-right">
                            <div className="text-green-400 font-bold text-lg">${leg.odds}</div>
                            <div className="text-gray-500 text-xs">{leg.confidence}% conf</div>
                          </div>
                          <button
                            onClick={() => setMulti(multi.filter((l) => l.id !== leg.id))}
                            className="text-gray-600 hover:text-red-400 text-xl leading-none"
                          >
                            ×
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 text-sm text-gray-400 space-y-1">
                  <p>💡 Place each leg at the bookmaker shown for best odds.</p>
                  <p>💡 Check for multi insurance promos before placing.</p>
                </div>
              </>
            )}
          </div>
        )}

        {/* PLAYER PROPS TAB */}
        {tab === "props" && (
          <div className="space-y-3">
            {propsLoading ? (
              <div className="text-center py-16 text-gray-400">
                <div className="text-4xl mb-3">🔬</div>
                <p className="font-medium text-white">Analysing player stats…</p>
                <p className="text-sm mt-1 text-gray-500">Fetching 3 seasons of game-by-game data. Takes ~20 seconds.</p>
              </div>
            ) : props.length === 0 && propsLoaded ? (
              <div className="text-center py-16 text-gray-400">
                <div className="text-3xl mb-2">😴</div>
                <p className="font-medium text-white">No player prop data found</p>
                <p className="text-sm mt-1">Markets may not be open yet for this round.</p>
              </div>
            ) : propsLoaded ? (
              <>
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 text-sm text-gray-400">
                  <p>📊 Real hit rates vs bookmaker lines — backed by 3+ seasons of AFL Tables data. Only showing players with genuine edge.</p>
                </div>

                {/* Stat type filter */}
                <div className="flex gap-1 flex-wrap">
                  {(["all", "disposals", "goals", "marks", "kicks", "tackles"] as const).map((s) => (
                    <button
                      key={s}
                      onClick={() => setStatFilter(s)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold capitalize transition-colors ${
                        statFilter === s ? "bg-blue-500 text-white" : "bg-gray-800 text-gray-300 hover:bg-gray-700"
                      }`}
                    >
                      {s === "all" ? "All markets" : s}
                    </button>
                  ))}
                </div>

                {/* Edge filter */}
                <div className="flex gap-2 items-center">
                  <span className="text-xs text-gray-500">Min edge:</span>
                  {[5, 10, 15, 20].map((e) => (
                    <button
                      key={e}
                      onClick={() => setEdgeFilter(e)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                        edgeFilter === e ? "bg-green-500 text-black" : "bg-gray-800 text-gray-300 hover:bg-gray-700"
                      }`}
                    >
                      +{e}%
                    </button>
                  ))}
                </div>

                <p className="text-gray-500 text-xs">
                  {props.filter((p) => p.edge >= edgeFilter && (statFilter === "all" || p.statType === statFilter)).length} bets · {edgeFilter}%+ edge · Tap to add to multi
                </p>

                {props.filter((p) => p.edge >= edgeFilter && (statFilter === "all" || p.statType === statFilter)).map((prop) => {
                  const propId = `prop-${prop.playerName}-${prop.statType}`;
                  const inMulti = !!multi.find((l) => l.id === propId);
                  const isExpanded = expandedProp === propId;
                  const marketThreshold = Math.ceil(prop.marketLine);

                  // 9 thresholds centred on the market line
                  const displayThresholds = prop.thresholds.filter(
                    (t) => t.threshold >= marketThreshold - 4 && t.threshold <= marketThreshold + 4
                  );

                  return (
                    <div
                      key={prop.playerName}
                      className={`rounded-xl border transition-all ${
                        inMulti ? "bg-green-950 border-green-600" : "bg-gray-900 border-gray-800"
                      }`}
                    >
                      <div className="p-4">
                        <div className="flex items-start justify-between mb-3">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1 flex-wrap">
                              <span className="text-xs bg-yellow-900 text-yellow-300 px-1.5 py-0.5 rounded font-semibold">AFL</span>
                              <span className={`text-xs px-1.5 py-0.5 rounded font-semibold capitalize ${
                                prop.statType === "disposals" ? "bg-purple-900 text-purple-300" :
                                prop.statType === "goals" ? "bg-orange-900 text-orange-300" :
                                prop.statType === "marks" ? "bg-cyan-900 text-cyan-300" :
                                "bg-gray-700 text-gray-300"
                              }`}>
                                {prop.statLabel}
                              </span>
                              {inMulti && <span className="text-xs bg-green-500 text-black px-1.5 py-0.5 rounded font-bold">IN MULTI ✓</span>}
                            </div>
                            <div className="font-semibold text-white text-sm">{prop.playerName}</div>
                            <div className="text-gray-400 text-xs mt-0.5">{prop.matchup}</div>

                            {/* Market line */}
                            <div className="mt-2 bg-gray-800 rounded-lg px-3 py-2">
                              <div className="font-bold text-white text-sm">
                                {marketThreshold}+ {prop.statLabel}
                                <span className="ml-2 font-normal text-xs text-gray-400">
                                  (line {prop.marketLine})
                                </span>
                              </div>
                              <div className="text-gray-500 text-xs mt-0.5">
                                ${prop.bestOdds} @ {prop.bestBookie} · {prop.bookmakerImplied}% implied
                              </div>
                            </div>

                            {/* Recent form */}
                            <div className="flex items-center gap-1 mt-2">
                              <span className="text-gray-500 text-xs mr-1">Last 5 {prop.statLabel}:</span>
                              {prop.recentForm.map((d, i) => (
                                <span
                                  key={i}
                                  className={`text-xs font-bold px-1.5 py-0.5 rounded ${
                                    d >= marketThreshold ? "bg-green-800 text-green-300" : "bg-red-900 text-red-400"
                                  }`}
                                >
                                  {d}
                                </span>
                              ))}
                              <span className="text-gray-600 text-xs ml-2">avg {prop.seasonAvg}</span>
                            </div>
                          </div>

                          <div className="text-right ml-4 shrink-0">
                            <div className={`text-2xl font-bold ${prop.hitRate >= 75 ? "text-green-400" : prop.hitRate >= 65 ? "text-yellow-400" : "text-gray-400"}`}>
                              {prop.hitRate}%
                            </div>
                            <div className="text-gray-500 text-xs">hit rate</div>
                            <div className="text-green-400 text-sm font-semibold mt-1">+{prop.edge}% edge</div>
                            <div className="text-gray-400 text-xs">{prop.gamesAnalysed} games</div>
                          </div>
                        </div>

                        <div className="flex gap-2">
                          <button
                            onClick={() => {
                              if (inMulti) {
                                setMulti(multi.filter((l) => l.id !== propId));
                              } else {
                                if (multi.length >= 8) return;
                                setMulti([...multi, {
                                  id: propId,
                                  tip: `${prop.playerName} ${marketThreshold}+ ${prop.statLabel}`,
                                  confidence: prop.hitRate,
                                  match: prop.matchup,
                                  sport: "AFL",
                                  odds: prop.bestOdds,
                                  bookie: prop.bestBookie,
                                  confidenceSource: "stats",
                                }]);
                              }
                            }}
                            className={`flex-1 py-2 rounded-lg text-xs font-semibold transition-colors ${
                              inMulti ? "bg-red-900 text-red-300 hover:bg-red-800" : "bg-green-600 text-white hover:bg-green-500"
                            }`}
                          >
                            {inMulti ? "Remove from multi" : "+ Add to multi"}
                          </button>
                          <button
                            onClick={() => setExpandedProp(isExpanded ? null : propId)}
                            className="px-4 py-2 rounded-lg text-xs font-semibold bg-gray-800 text-gray-300 hover:bg-gray-700 transition-colors"
                          >
                            {isExpanded ? "Hide ▲" : "Thresholds ▼"}
                          </button>
                        </div>
                      </div>

                      {/* Threshold table */}
                      {isExpanded && displayThresholds.length > 0 && (
                        <div className="border-t border-gray-800 px-4 pb-4 pt-3">
                          <div className="text-xs text-gray-500 mb-2">
                            Hit rate at each threshold — check Sportsbet alternate lines for matching odds
                          </div>
                          <div className="space-y-1">
                            {displayThresholds.map((t) => {
                              const isMarket = t.threshold === marketThreshold;
                              return (
                                <div
                                  key={t.threshold}
                                  className={`flex justify-between items-center text-xs rounded px-3 py-1.5 ${
                                    isMarket ? "bg-green-900 border border-green-700 font-bold" : "bg-gray-800"
                                  }`}
                                >
                                  <span className="text-white">
                                    {t.threshold}+ {prop.statLabel}
                                    {isMarket && <span className="text-green-400 ml-2 text-xs font-normal">← market line (priced)</span>}
                                  </span>
                                  <span className={`font-semibold ${t.hitRate >= 75 ? "text-green-400" : t.hitRate >= 65 ? "text-yellow-400" : "text-gray-400"}`}>
                                    {t.hitRate}%
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                          <div className="text-gray-600 text-xs mt-2">
                            Edge calculated at market line only. Use hit rates above to find value on alternate lines.
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </>
            ) : (
              <div className="text-center py-16 text-gray-400">
                <div className="text-4xl mb-3">🔬</div>
                <p className="font-medium text-white">Player disposal analysis</p>
                <p className="text-sm mt-1 mb-4">Compares real hit rates vs bookmaker lines across 3 seasons of data.</p>
              </div>
            )}
          </div>
        )}

        {/* BACKTEST TAB */}
        {tab === "backtest" && (
          <div className="space-y-4">
            {backtestLoading ? (
              <div className="text-center py-16 text-gray-400">
                <div className="text-4xl mb-3">📊</div>
                <p>Crunching 7 seasons of AFL data…</p>
                <p className="text-sm mt-1 text-gray-500">Usually takes 10–15 seconds</p>
              </div>
            ) : (
              <>
                {summary && (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
                      <div className="text-2xl font-bold text-green-400">{summary.targetWinRate}%</div>
                      <div className="text-gray-400 text-sm mt-1">Win rate — 70%+ confidence</div>
                    </div>
                    <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
                      <div className="text-2xl font-bold text-blue-400">{summary.targetGames.toLocaleString()}</div>
                      <div className="text-gray-400 text-sm mt-1">Games analysed (70%+)</div>
                    </div>
                    <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
                      <div className="text-2xl font-bold text-yellow-400">{summary.multiStrikeRate4}%</div>
                      <div className="text-gray-400 text-sm mt-1">4-leg multi strike rate</div>
                    </div>
                    <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
                      <div className="text-2xl font-bold text-yellow-400">{summary.multiStrikeRate5}%</div>
                      <div className="text-gray-400 text-sm mt-1">5-leg multi strike rate</div>
                    </div>
                  </div>
                )}
                <div className="text-xs text-gray-500 text-center">
                  {summary?.yearsAnalysed} seasons (2018–2024) · {summary?.totalGames.toLocaleString()} games · Squiggle Aggregate
                </div>

                <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
                  <div className="px-4 py-3 border-b border-gray-800">
                    <h2 className="font-semibold text-white">Win rate by confidence band</h2>
                    <p className="text-gray-400 text-xs mt-0.5">AFL only — 2018–2024 historical data</p>
                  </div>
                  <div className="divide-y divide-gray-800">
                    {bands.map((b) => (
                      <div key={b.label} className="px-4 py-3">
                        <div className="flex justify-between items-center mb-2">
                          <span className="font-medium text-sm">{b.label} model conf</span>
                          <span className={`font-bold text-sm ${b.winRate >= b.midConfidence ? "text-green-400" : "text-red-400"}`}>
                            {b.winRate}% actual
                          </span>
                        </div>
                        <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${b.winRate >= b.midConfidence ? "bg-green-500" : "bg-red-500"}`}
                            style={{ width: `${Math.min(100, b.winRate)}%` }}
                          />
                        </div>
                        <div className="flex justify-between text-xs text-gray-500 mt-1.5">
                          <span>{b.total.toLocaleString()} games</span>
                          <span>
                            Edge: <span className={b.edge >= 0 ? "text-green-400" : "text-red-400"}>
                              {b.edge >= 0 ? "+" : ""}{b.edge}%
                            </span>
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
                  <h3 className="font-semibold text-white mb-2">Strategy rules</h3>
                  <ul className="text-sm text-gray-400 space-y-2">
                    <li>🎯 <span className="text-white">80%+ confidence only</span> — sweet spot is 90.8% actual win rate</li>
                    <li>🧮 4-leg multi at that rate hits <span className="text-yellow-400">{summary?.multiStrikeRate4}%</span> of the time</li>
                    <li>📉 Never add a weak leg just to hit 4 — 3 clean legs beats 4 diluted ones</li>
                    <li>💰 24% expected return on capital per multi at $100 stake</li>
                  </ul>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
