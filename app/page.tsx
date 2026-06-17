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
  const [tab, setTab] = useState<"backtest" | "builder" | "live" | "props">("live");
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
          { key: "builder", label: "My Multi" },
          { key: "backtest", label: "Backtest" },
        ].map(({ key, label }) => (
          <button
            key={key}
            onClick={() => {
              setTab(key as "backtest" | "builder" | "live" | "props");
              if (key === "props" && !propsLoaded && !propsLoading) {
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
