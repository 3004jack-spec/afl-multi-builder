"use client";

import { useEffect, useState } from "react";

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

interface PricedLine {
  line: number;
  bookmakerOdds: Record<string, number>;
  bestOdds: number;
  bestBookie: string;
  hitRate: number;
  bookmakerImplied: number;
  edge: number;
}

interface PlayerProp {
  playerName: string;
  matchup: string;
  commenceTime: string;
  statType: string;
  statLabel: string;
  marketLine: number;
  bestOdds: number;
  bestBookie: string;
  bookmakerOdds: Record<string, number>;
  isAlternateLine: boolean;
  allPricedLines: PricedLine[];
  gamesAnalysed: number;
  hitRate: number;
  hitRate5: number;
  hitRate10: number;
  bayesianRate: number;
  coldForm: boolean;
  bookmakerImplied: number;
  edge: number;
  recentEdge: number;
  bayesianEdge: number;
  recentForm: number[];
  seasonAvg: number;
  thresholds: ThresholdPoint[];
}

interface AutoMultiCombo {
  legs: PlayerProp[];
  combinedOdds: number;
  strikeRate: number;
  ev100: number;
  kelly: number; // Kelly fraction × 100 — optimal bankroll % to bet for long-term growth
  bookie: string;
}

function formatTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-AU", { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function Home() {
  const [tab, setTab] = useState<"backtest" | "builder" | "live" | "props" | "auto" | "picks">("live");
  const [bands, setBands] = useState<BandResult[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [backtestLoading, setBacktestLoading] = useState(true);
  const [games, setGames] = useState<OddsGame[]>([]);
  const [gamesLoading, setGamesLoading] = useState(true);
  const [multi, setMulti] = useState<MultiLeg[]>([]);
  const [props, setProps] = useState<PlayerProp[]>([]);
  const [expandedProp, setExpandedProp] = useState<string | null>(null);
  const [statFilter, setStatFilter] = useState<"all" | "disposals" | "goals" | "marks" | "kicks" | "handballs" | "tackles" | "clearances">("all");
  const [propsLoading, setPropsLoading] = useState(false);
  const [propsLoaded, setPropsLoaded] = useState(false);
  const [edgeFilter, setEdgeFilter] = useState<number>(5);
  const [hitRateFilter, setHitRateFilter] = useState<number>(75);
  const [sportFilter, setSportFilter] = useState<"ALL" | "AFL">("ALL");
  const [confFilter, setConfFilter] = useState<number>(70);
  const [bookieFilter, setBookieFilter] = useState<string>("Best odds");
  const [namedPlayers, setNamedPlayers] = useState<Set<string>>(new Set());
  const [emergencyPlayers, setEmergencyPlayers] = useState<Set<string>>(new Set());
  const [lineupsLoaded, setLineupsLoaded] = useState(false);

  // Historical picks state
  const [historicalPicks, setHistoricalPicks] = useState<HistoricalPick[]>([]);
  const [picksLoading, setPicksLoading] = useState(false);
  const [picksLoaded, setPicksLoaded] = useState(false);
  const [picksStatFilter, setPicksStatFilter] = useState<"all" | "disposals" | "kicks" | "marks" | "handballs" | "tackles" | "goals">("all");
  const [picksMinBayesian, setPicksMinBayesian] = useState<number>(75);

  // Manual multi evaluator state
  const [manualSearch, setManualSearch] = useState("");
  const [manualSuggestions, setManualSuggestions] = useState<string[]>([]);
  const [manualPlayer, setManualPlayer] = useState("");
  const [manualStat, setManualStat] = useState<"disposals"|"kicks"|"marks"|"handballs"|"tackles"|"clearances"|"goals">("disposals");
  const [manualThreshold, setManualThreshold] = useState("");
  const [manualOdds, setManualOdds] = useState("");
  const [manualLookup, setManualLookup] = useState<null | { found: boolean; hitRate5: number; hitRate10: number; allTime: number; recentForm: number[]; seasonAvg: number; stale: boolean }>(null);
  const [manualLooking, setManualLooking] = useState(false);
  const [bankroll, setBankroll] = useState<number>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("bankroll");
      return saved ? parseInt(saved, 10) : 200;
    }
    return 200;
  });
  const [editingBankroll, setEditingBankroll] = useState(false);
  const [bankrollInput, setBankrollInput] = useState("");
  const [oddsBoostPct, setOddsBoostPct] = useState<number>(0);       // e.g. 10 = 10% boost
  const [isBonusBet, setIsBonusBet] = useState(false);               // stake not returned on win

  useEffect(() => {
    fetch("/api/backtest")
      .then((r) => r.json())
      .then((d) => { setBands(d.bandResults); setSummary(d.summary); setBacktestLoading(false); });

    fetch("/api/odds")
      .then((r) => r.json())
      .then((d) => { setGames(d.games ?? []); setGamesLoading(false); });

    fetch("/api/lineups")
      .then((r) => r.json())
      .then((d) => {
        setNamedPlayers(new Set(d.named ?? []));
        setEmergencyPlayers(new Set(d.emergencies ?? []));
        setLineupsLoaded(true);
      })
      .catch(() => setLineupsLoaded(true));

    // Pre-load Top Picks so Model Multi is available on Auto Multi tab without visiting Top Picks first
    fetch(`/api/player-picks?minBayesian=75`)
      .then((r) => r.json())
      .then((d) => { setHistoricalPicks(d.picks ?? []); setPicksLoaded(true); });
  }, []);

  function lineupStatus(playerName: string): "named" | "emergency" | "not-named" | "unknown" {
    if (!lineupsLoaded) return "unknown";
    if (namedPlayers.has(playerName)) return "named";
    if (emergencyPlayers.has(playerName)) return "emergency";
    // Only flag as not-named if we have data for that round (some games announced later)
    if (namedPlayers.size > 0) return "not-named";
    return "unknown";
  }

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

  // Derive sorted list of bookmakers from props
  function getAvailableBookies(propList: PlayerProp[]): string[] {
    const counts: Record<string, number> = {};
    for (const p of propList) {
      for (const bk of Object.keys(p.bookmakerOdds)) {
        counts[bk] = (counts[bk] ?? 0) + 1;
      }
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);
  }

  // Build combos for a specific bookmaker (or best single bookie across all legs)
  function buildAllCombos(pool: PlayerProp[], selectedBookie: string, maxLegs = 6, topN = 50): AutoMultiCombo[] {
    const eligible = selectedBookie === "Best odds"
      ? pool
      : pool.filter((p) => p.bookmakerOdds[selectedBookie] !== undefined);

    // All bookies available across the pool (for best-bookie-per-combo selection)
    const allBookies = [...new Set(eligible.flatMap((p) => Object.keys(p.bookmakerOdds)))];

    const allResults: AutoMultiCombo[] = [];

    for (let legCount = 1; legCount <= Math.min(maxLegs, eligible.length); legCount++) {
      const results: AutoMultiCombo[] = [];

      function combine(start: number, current: PlayerProp[]) {
        // All legs must be from the same game (same-game multi only)
        const gameMatchup = current[0]?.matchup;
        if (current.length === legCount) {
          let bestCombinedOdds = 0;
          let bestBookie = selectedBookie;

          if (selectedBookie === "Best odds") {
            // Find the single bookie with best combined odds where ALL legs are priced
            for (const bk of allBookies) {
              if (!current.every((p) => p.bookmakerOdds[bk] !== undefined)) continue;
              const combined = current.reduce((a, p) => a * p.bookmakerOdds[bk], 1);
              if (combined > bestCombinedOdds) {
                bestCombinedOdds = combined;
                bestBookie = bk;
              }
            }
            if (bestCombinedOdds === 0) return; // no single bookie covers all legs
          } else {
            bestBookie = selectedBookie;
            bestCombinedOdds = current.reduce((a, p) => a * (p.bookmakerOdds[selectedBookie] ?? p.bestOdds), 1);
          }

          const combinedOdds = Math.round(bestCombinedOdds * 100) / 100;
          const strikeRate = Math.round(current.reduce((a, p) => a * (p.bayesianRate / 100), 1) * 1000) / 10;
          const ev100 = Math.round(((strikeRate / 100) * combinedOdds * 100 - 100) * 10) / 10;
          const kelly = combinedOdds > 1
            ? Math.round(((strikeRate / 100) * combinedOdds - 1) / (combinedOdds - 1) * 1000) / 10
            : 0;
          results.push({ legs: [...current], combinedOdds, strikeRate, ev100, kelly, bookie: bestBookie });
          return;
        }
        for (let i = start; i < eligible.length; i++) {
          if (current.some((p) => p.playerName === eligible[i].playerName)) continue;
          if (gameMatchup && eligible[i].matchup !== gameMatchup) continue;
          current.push(eligible[i]);
          combine(i + 1, current);
          current.pop();
        }
      }

      combine(0, []);
      results.sort((a, b) => b.kelly - a.kelly);
      allResults.push(...results.slice(0, 10));
    }

    // Sort by soonest game first, then by kelly within same date
    return allResults.sort((a, b) => {
      const aTime = Math.min(...a.legs.map((l) => new Date(l.commenceTime).getTime()));
      const bTime = Math.min(...b.legs.map((l) => new Date(l.commenceTime).getTime()));
      if (aTime !== bTime) return aTime - bTime;
      return b.kelly - a.kelly;
    }).slice(0, topN);
  }

  // Use API-computed bayesianRate and bayesianEdge directly — already uses (10×L10 + 25×shrunkPrior)/35
  const bayesianRate = (p: PlayerProp) => p.bayesianRate;
  const bayesianEdge = (p: PlayerProp) => p.bayesianEdge;

  // Auto Multi pool: same Bayesian rate filter as Player Props and Top Picks
  // Min odds $1.15 — legs below this barely move combined odds
  // Exclude cold form — last-10 hit rate 25+ points below all-time signals role/injury change
  const autoPool = props.filter((p) => bayesianRate(p) >= hitRateFilter && bayesianEdge(p) > 0 && p.bestOdds >= 1.15 && !p.coldForm && lineupStatus(p.playerName) !== "not-named");
  const availableBookies = ["Best odds", ...getAvailableBookies(autoPool)];
  const allCombos = buildAllCombos(autoPool, bookieFilter);

  // Model Multi: Top Picks converted to synthetic PlayerProps with estimated odds (no Odds API needed)
  // Estimated odds = 1 / bayesianRate — conservative fair-value estimate before bookie margin
  // Only include legs with estimated odds >= $1.08 (below this adds nothing meaningful to a multi)
  const topPicksAsProps: PlayerProp[] = historicalPicks
    .filter((p) => p.bayesianRate >= hitRateFilter)
    .filter((p) => {
      const ls = lineupStatus(p.playerName);
      // When lineups are loaded, only include confirmed named starters
      // When lineups aren't loaded yet, allow unknown through
      return lineupsLoaded && namedPlayers.size > 0 ? ls === "named" : ls === "named" || ls === "unknown";
    })
    .map((p) => {
      // Look up live match data for this player from props (has real matchup, odds, commenceTime)
      const liveProp = props.find((lp) => lp.playerName === p.playerName && lp.statType === p.statType);
      const estOdds = Math.round((1 / (p.bayesianRate / 100)) * 100) / 100;
      const bestOdds = liveProp?.bestOdds ?? estOdds;
      const implied = Math.round((1 / bestOdds) * 1000) / 10;
      return {
        playerName: p.playerName,
        matchup: liveProp?.matchup ?? "",
        commenceTime: liveProp?.commenceTime ?? new Date().toISOString(),
        statType: p.statType,
        statLabel: p.statType,
        marketLine: liveProp?.marketLine ?? (p.suggestedThreshold - 0.5),
        bestOdds,
        bestBookie: liveProp?.bestBookie ?? "Sportsbet (est.)",
        bookmakerOdds: liveProp?.bookmakerOdds ?? { "Sportsbet (est.)": estOdds },
        isAlternateLine: liveProp?.isAlternateLine ?? false,
        allPricedLines: liveProp?.allPricedLines ?? [],
        gamesAnalysed: p.gamesAnalysed,
        hitRate: p.allTimeRate,
        hitRate5: p.hitRate5,
        hitRate10: p.hitRate10,
        bayesianRate: p.bayesianRate,
        coldForm: false,
        bookmakerImplied: implied,
        edge: liveProp?.edge ?? 0,
        recentEdge: liveProp?.recentEdge ?? 0,
        bayesianEdge: Math.round((p.bayesianRate - implied) * 10) / 10,
        seasonAvg: p.seasonAvg,
        recentForm: p.recentForm,
        thresholds: liveProp?.thresholds ?? [],
      } as PlayerProp;
    })
    .filter((p) => p.bestOdds >= 1.08);
  // Cap to top 25 after lineup filter — buildAllCombos is O(n^legCount), too many entries hangs the browser
  const modelMultiCombos = buildAllCombos(topPicksAsProps.slice(0, 25), "Best odds", 5, 10);

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
        <p className="text-gray-400 text-sm mt-0.5">AFL — real odds from 11 bookmakers</p>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-800 bg-gray-900">
        {[
          { key: "live", label: "Match Odds" },
          { key: "picks", label: "Top Picks" },
          { key: "props", label: "Player Props" },
          { key: "auto", label: "Auto Multi" },
          { key: "builder", label: "My Multi" },
          { key: "backtest", label: "Backtest" },
        ].map(({ key, label }) => (
          <button
            key={key}
            onClick={() => {
              setTab(key as "backtest" | "builder" | "live" | "props" | "auto" | "picks");
              if ((key === "props" || key === "auto") && !propsLoaded && !propsLoading) {
                setPropsLoading(true);
                fetch("/api/player-props")
                  .then((r) => r.json())
                  .then((d) => { setProps(d.props ?? []); setPropsLoading(false); setPropsLoaded(true); });
              }
              if (key === "picks" && !picksLoaded && !picksLoading) {
                setPicksLoading(true);
                fetch(`/api/player-picks?minBayesian=${picksMinBayesian}`)
                  .then((r) => r.json())
                  .then((d) => { setHistoricalPicks(d.picks ?? []); setPicksLoading(false); setPicksLoaded(true); });
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
                {(["ALL", "AFL"] as const).map((s) => (
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
            ) : (
              <>
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 text-sm text-gray-400">
                  <p className="text-white font-medium mb-1">Grinder strategy — high strike rate, low variance</p>
                  <p>Only legs where Bayesian reliability clears the threshold. Lower odds, but wins consistently. 4 legs at 80% = 41% strike rate. No AFL knowledge needed — pure numbers.</p>
                </div>

                {/* Hit rate threshold selector */}
                <div>
                  <div className="text-xs text-gray-500 mb-2">Minimum Bayesian reliability per leg:</div>
                  <div className="flex gap-1.5">
                    {[75, 80, 85, 90].map((hr) => (
                      <button
                        key={hr}
                        onClick={() => setHitRateFilter(hr)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                          hitRateFilter === hr ? "bg-green-500 text-black" : "bg-gray-800 text-gray-300 hover:bg-gray-700"
                        }`}
                      >
                        {hr}%+
                      </button>
                    ))}
                  </div>
                  {autoPool.length > 0 && (
                    <p className="text-xs text-gray-500 mt-1.5">
                      {autoPool.length} qualifying leg{autoPool.length !== 1 ? "s" : ""} at {hitRateFilter}%+ Bayesian reliability
                      {hitRateFilter === 90 && autoPool.length >= 4 && (
                        <span className="text-green-400 ml-2">· 4-leg strike rate: {Math.round(Math.pow(0.9, Math.min(autoPool.length, 4)) * 1000) / 10}%</span>
                      )}
                    </p>
                  )}
                </div>

                {autoPool.length < 2 ? (
                  <div className="text-center py-8 text-gray-400 bg-gray-900 border border-gray-800 rounded-xl">
                    <p className="font-medium text-white">No legs qualify at {hitRateFilter}%+</p>
                    <p className="text-sm mt-1">Try lowering the hit rate filter, or check back closer to game day when more markets open.</p>
                  </div>
                ) : (
                  <>
                {/* Bookmaker filter */}
                <div>
                  <div className="text-xs text-gray-500 mb-2">Place multi at:</div>
                  <div className="flex gap-1.5 flex-wrap">
                    {availableBookies.map((bk) => (
                      <button
                        key={bk}
                        onClick={() => setBookieFilter(bk)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                          bookieFilter === bk
                            ? "bg-green-500 text-black"
                            : "bg-gray-800 text-gray-300 hover:bg-gray-700"
                        }`}
                      >
                        {bk}
                      </button>
                    ))}
                  </div>
                  {bookieFilter !== "Best odds" && (
                    <p className="text-xs text-yellow-400 mt-2">
                      Showing only legs available at {bookieFilter} — all legs placeable as one multi.
                    </p>
                  )}
                </div>

                {allCombos.length === 0 ? (
                  <div className="text-center py-8 text-gray-400">
                    <p className="font-medium text-white">No qualifying legs at {bookieFilter}</p>
                    <p className="text-sm mt-1">Try a different bookmaker or switch to Best odds.</p>
                  </div>
                ) : (
                  <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
                    <div className="px-4 py-3 border-b border-gray-800 grid grid-cols-4 text-xs text-gray-500 font-medium">
                      <span>Bet</span>
                      <span className="text-center">Strike rate</span>
                      <span className="text-center">Odds</span>
                      <span className="text-right">Edge score</span>
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
                                <span className={`font-bold text-sm ${combo.kelly >= 0 ? "text-green-400" : "text-red-400"}`}>
                                  {combo.kelly >= 0 ? "+" : ""}{combo.kelly}%
                                </span>
                                <div className="text-gray-600 text-xs">{combo.ev100 >= 0 ? "+" : ""}${combo.ev100} EV</div>
                              </div>
                            </div>

                            {/* Legs */}
                            <div className="space-y-1 mb-3">
                              {combo.legs.map((prop) => {
                                const legOdds = prop.bookmakerOdds[combo.bookie] ?? prop.bestOdds;
                                const legBookie = combo.bookie;
                                return (
                                  <div key={`${prop.playerName}-${prop.statType}`} className="flex items-center justify-between bg-gray-800 rounded px-3 py-1.5 text-xs">
                                    <div className="flex-1 min-w-0 flex items-center gap-1.5">
                                      <span className="text-white font-medium">{prop.playerName}</span>
                                      {(() => {
                                        const ls = lineupStatus(prop.playerName);
                                        if (ls === "named") return <span className="text-green-400 font-bold">✓</span>;
                                        if (ls === "emergency") return <span className="text-yellow-400 font-bold">⚠</span>;
                                        if (ls === "not-named") return <span className="text-red-400 font-bold">✗</span>;
                                        return null;
                                      })()}
                                      <span className="text-gray-400">{Math.ceil(prop.marketLine)}+ {prop.statLabel}</span>
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0 ml-2">
                                      <span className={`font-semibold ${prop.hitRate >= 75 ? "text-green-400" : "text-yellow-400"}`}>{prop.hitRate}%</span>
                                      <span className="text-gray-500">${legOdds}</span>
                                      <span className="text-gray-500 text-xs">{legBookie}</span>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>

                            <button
                              onClick={() => {
                                const newLegs = combo.legs.map((prop) => {
                                  const legOdds = bookieFilter === "Best odds"
                                    ? prop.bestOdds
                                    : (prop.bookmakerOdds[bookieFilter] ?? prop.bestOdds);
                                  const legBookie = bookieFilter === "Best odds" ? prop.bestBookie : bookieFilter;
                                  return {
                                    id: `prop-${prop.playerName}-${prop.statType}`,
                                    tip: `${prop.playerName} ${Math.ceil(prop.marketLine)}+ ${prop.statLabel}`,
                                    confidence: prop.hitRate,
                                    match: prop.matchup,
                                    sport: "AFL" as const,
                                    odds: legOdds,
                                    bookie: legBookie,
                                    confidenceSource: "stats" as const,
                                  };
                                });
                                setMulti(newLegs);
                                setTab("builder");
                              }}
                              className="w-full py-1.5 bg-green-700 hover:bg-green-600 text-white text-xs font-semibold rounded-lg transition-colors"
                            >
                              {bookieFilter === "Best odds" ? "Use this bet →" : `Place at ${bookieFilter} →`}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Model Multi — Top Picks with estimated odds */}
                {picksLoaded && modelMultiCombos.length > 0 && (
                  <div className="space-y-3">
                    <div className="bg-gray-900 border border-yellow-800 rounded-xl p-3">
                      <div className="text-sm font-semibold text-yellow-400 mb-1">Model Multi — historical signal</div>
                      <p className="text-xs text-gray-400">Built from Top Picks data. Odds are estimated from Bayesian hit rate — verify each leg price on Sportsbet pick-your-own before placing.</p>
                    </div>
                    <div className="space-y-3">
                      {modelMultiCombos.slice(0, 5).map((combo, idx) => (
                        <div key={idx} className="bg-gray-900 border border-yellow-900 rounded-xl p-4">
                          <div className="flex items-center justify-between mb-3">
                            <div>
                              <span className="text-white font-bold text-lg">{combo.legs.length}-leg</span>
                              <span className="text-gray-400 text-sm ml-2">est. ~${combo.combinedOdds}</span>
                            </div>
                            <div className="text-right">
                              <div className="text-green-400 font-bold">{combo.strikeRate}%</div>
                              <div className="text-xs text-gray-500">strike rate</div>
                            </div>
                          </div>
                          <div className="space-y-1 mb-3">
                            {combo.legs.map((prop) => (
                              <div key={`${prop.playerName}-${prop.statType}`} className="flex items-center justify-between bg-gray-800 rounded px-3 py-1.5 text-xs">
                                <div className="flex-1 min-w-0">
                                  <span className="text-white font-medium">{prop.playerName}</span>
                                  <span className="text-gray-400 ml-1.5">{Math.ceil(prop.marketLine)}+ {prop.statLabel}</span>
                                </div>
                                <div className="flex items-center gap-2 shrink-0 ml-2">
                                  <span className="text-green-400 font-semibold">{Math.round(((10 * prop.hitRate10 + 15 * prop.hitRate) / 25) * 10) / 10}%</span>
                                  <span className="text-yellow-500 font-mono">~${prop.bestOdds}</span>
                                  <span className="text-gray-600">est.</span>
                                </div>
                              </div>
                            ))}
                          </div>
                          <p className="text-xs text-yellow-700 text-center">Check each price on Sportsbet → build in My Multi with real odds</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 text-sm text-gray-400 space-y-1.5">
                  <p><span className="text-white">Edge score</span> = Kelly fraction — how hard you&apos;re beating the bookmaker relative to the risk taken. Higher = better long-term growth regardless of leg count.</p>
                  <p><span className="text-white">EV / $100</span> = raw profit per $100, shown as context only. Not used for ranking — a big EV on a low-probability multi is misleading.</p>
                  <p><span className="text-white">Same-bookmaker rule:</span> select one bookmaker above — all legs in a multi must be placed at the same provider.</p>
                </div>
                  </>
                )}
              </>
            )}
          </div>
        )}

        {/* MULTI BUILDER TAB */}
        {tab === "builder" && (
          <div className="space-y-4">

            {/* Bankroll setting */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3 flex items-center justify-between">
              <div>
                <div className="text-xs text-gray-500">Betting bankroll</div>
                {editingBankroll ? (
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-gray-400 text-sm">$</span>
                    <input
                      type="number"
                      value={bankrollInput}
                      onChange={(e) => setBankrollInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          const v = parseInt(bankrollInput, 10);
                          if (v > 0) { setBankroll(v); localStorage.setItem("bankroll", String(v)); }
                          setEditingBankroll(false);
                        }
                        if (e.key === "Escape") setEditingBankroll(false);
                      }}
                      className="bg-gray-800 border border-green-500 rounded px-2 py-1 text-white text-sm w-24 focus:outline-none"
                      autoFocus
                    />
                    <button onClick={() => {
                      const v = parseInt(bankrollInput, 10);
                      if (v > 0) { setBankroll(v); localStorage.setItem("bankroll", String(v)); }
                      setEditingBankroll(false);
                    }} className="text-green-400 text-xs font-semibold">Save</button>
                  </div>
                ) : (
                  <div className="text-white font-bold text-lg">${bankroll.toLocaleString()}</div>
                )}
              </div>
              <button
                onClick={() => { setBankrollInput(String(bankroll)); setEditingBankroll(true); }}
                className="text-xs text-gray-500 hover:text-green-400 border border-gray-700 rounded-lg px-3 py-1.5"
              >
                {editingBankroll ? "Editing…" : "Change"}
              </button>
            </div>

            {/* Hero: Leg Evaluator */}
            <div className="bg-gray-900 rounded-xl border border-green-800 p-4 space-y-3">
              <div>
                <h3 className="font-bold text-white text-base">Check a bet</h3>
                <p className="text-gray-500 text-xs mt-0.5">Find a leg on Sportsbet — enter the details below to see if it&apos;s backed by the data.</p>
              </div>

              {/* Player search */}
              <div className="relative">
                <input
                  type="text"
                  placeholder="Search player name…"
                  value={manualSearch}
                  onChange={(e) => {
                    const v = e.target.value;
                    setManualSearch(v);
                    setManualPlayer("");
                    setManualLookup(null);
                    if (v.length >= 2) {
                      fetch(`/api/player-lookup?q=${encodeURIComponent(v)}`)
                        .then((r) => r.json())
                        .then((d) => setManualSuggestions(d.players ?? []));
                    } else {
                      setManualSuggestions([]);
                    }
                  }}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-green-500"
                />
                {manualSuggestions.length > 0 && !manualPlayer && (
                  <div className="absolute z-10 w-full bg-gray-800 border border-gray-700 rounded-lg mt-1 overflow-hidden shadow-xl">
                    {manualSuggestions.map((name) => (
                      <button
                        key={name}
                        onClick={() => {
                          setManualPlayer(name); setManualSearch(name); setManualSuggestions([]); setManualLookup(null);
                        }}
                        className="w-full text-left px-3 py-2.5 text-sm text-white hover:bg-gray-700 border-b border-gray-700 last:border-0"
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Stat + threshold + odds row */}
              <div className="grid grid-cols-3 gap-2">
                <select
                  value={manualStat}
                  onChange={(e) => { setManualStat(e.target.value as typeof manualStat); setManualLookup(null); }}
                  className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-2.5 text-sm text-white focus:outline-none focus:border-green-500"
                >
                  {["disposals","kicks","marks","handballs","tackles","clearances","goals"].map((s) => (
                    <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
                  ))}
                </select>
                <input
                  type="number"
                  placeholder="19+ threshold"
                  value={manualThreshold}
                  onChange={(e) => { setManualThreshold(e.target.value); setManualLookup(null); }}
                  className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-green-500"
                />
                <input
                  type="number"
                  step="0.01"
                  placeholder="Odds e.g. 1.85"
                  value={manualOdds}
                  onChange={(e) => setManualOdds(e.target.value)}
                  className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-green-500"
                />
              </div>

              <button
                disabled={!manualPlayer || !manualThreshold || manualLooking}
                onClick={() => {
                  if (!manualPlayer || !manualThreshold) return;
                  setManualLooking(true);
                  setManualLookup(null);
                  fetch(`/api/player-lookup?player=${encodeURIComponent(manualPlayer)}&stat=${manualStat}&threshold=${manualThreshold}`)
                    .then((r) => r.json())
                    .then((d) => { setManualLookup(d); setManualLooking(false); })
                    .catch(() => setManualLooking(false));
                }}
                className="w-full bg-green-500 disabled:bg-gray-700 disabled:text-gray-500 text-black font-bold py-2.5 rounded-lg text-sm"
              >
                {manualLooking ? "Checking…" : "Check this bet"}
              </button>

              {/* Results */}
              {manualLookup && (
                manualLookup.found === false ? (
                  <p className="text-red-400 text-sm">Player not found — we may not have their stats yet.</p>
                ) : (() => {
                  const odds = parseFloat(manualOdds);
                  const implied = odds > 1 ? Math.round((1 / odds) * 1000) / 10 : null;
                  const edge = implied !== null ? Math.round((manualLookup.hitRate10 - implied) * 10) / 10 : null;
                  const adjRate = (10 * manualLookup.hitRate10 + 15 * manualLookup.allTime) / 25;
                  const kelly = (implied !== null && odds > 1)
                    ? Math.max(0, Math.round(((adjRate / 100) * odds - 1) / (odds - 1) * 1000) / 10)
                    : null;
                  const halfKellyStake = kelly !== null ? Math.round((kelly / 100) * 0.5 * bankroll) : null;
                  const verdict = edge === null ? null : edge >= 10 ? "BACK IT" : edge >= 0 ? "MARGINAL" : "AVOID";
                  const verdictColor = verdict === "BACK IT" ? "bg-green-500 text-black" : verdict === "MARGINAL" ? "bg-yellow-500 text-black" : "bg-red-600 text-white";
                  return (
                    <div className="space-y-3">
                      {manualLookup.stale && (
                        <p className="text-yellow-400 text-xs">⚠️ Data is from before 2025 — treat with caution.</p>
                      )}

                      {/* Verdict banner */}
                      {verdict && (
                        <div className={`rounded-xl px-4 py-3 flex items-center justify-between ${verdictColor}`}>
                          <div>
                            <div className="text-xl font-black">{verdict}</div>
                            <div className="text-xs opacity-80 mt-0.5">
                              {verdict === "BACK IT" ? `+${edge}% edge over bookmaker` : verdict === "MARGINAL" ? `Slight edge — only in a multi` : `Bookmaker has the edge by ${Math.abs(edge!)}%`}
                            </div>
                          </div>
                          {halfKellyStake !== null && halfKellyStake > 0 && verdict !== "AVOID" && (
                            <div className="text-right">
                              <div className="text-2xl font-black">${halfKellyStake}</div>
                              <div className="text-xs opacity-80">recommended stake</div>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Hit rate stats */}
                      <div className="grid grid-cols-3 gap-2 text-center">
                        <div className="bg-gray-800 rounded-lg py-2">
                          <div className={`text-xl font-bold ${manualLookup.hitRate10 >= 70 ? "text-green-400" : manualLookup.hitRate10 >= 50 ? "text-yellow-400" : "text-red-400"}`}>
                            {manualLookup.hitRate10}%
                          </div>
                          <div className="text-gray-500 text-xs">L10 hit rate</div>
                        </div>
                        <div className="bg-gray-800 rounded-lg py-2">
                          <div className={`text-xl font-bold ${manualLookup.hitRate5 >= 70 ? "text-green-400" : manualLookup.hitRate5 >= 50 ? "text-yellow-400" : "text-red-400"}`}>
                            {manualLookup.hitRate5}%
                          </div>
                          <div className="text-gray-500 text-xs">L5 hit rate</div>
                        </div>
                        <div className="bg-gray-800 rounded-lg py-2">
                          <div className="text-xl font-bold text-gray-400">{manualLookup.allTime}%</div>
                          <div className="text-gray-500 text-xs">All-time</div>
                        </div>
                      </div>

                      {/* Visual form dots */}
                      <div className="bg-gray-800 rounded-lg px-3 py-2.5">
                        <div className="text-xs text-gray-500 mb-2">Last 5 games — {manualStat}</div>
                        <div className="flex items-end gap-2">
                          {manualLookup.recentForm.map((val, i) => {
                            const hit = val >= parseInt(manualThreshold, 10);
                            return (
                              <div key={i} className="flex-1 flex flex-col items-center gap-1">
                                <div className="text-xs text-gray-400 font-mono">{val}</div>
                                <div className={`w-full h-2 rounded-full ${hit ? "bg-green-500" : "bg-red-500"}`} />
                              </div>
                            );
                          })}
                        </div>
                        <div className="text-xs text-gray-600 mt-2">Season avg: {manualLookup.seasonAvg} {manualStat}</div>
                      </div>

                      {/* Kelly explanation */}
                      {kelly !== null && kelly > 0 && (
                        <div className="text-xs text-gray-600 leading-relaxed">
                          Half-Kelly stake on ${bankroll.toLocaleString()} bankroll. Full Kelly would be ${Math.round(kelly / 100 * bankroll)} — halved to reduce variance.
                        </div>
                      )}

                      {/* Add to multi */}
                      {manualPlayer && manualThreshold && odds > 1 && manualLookup.found && (
                        <button
                          onClick={() => {
                            setMulti([...multi, {
                              id: `manual-${manualPlayer}-${manualStat}-${manualThreshold}-${Date.now()}`,
                              tip: `${manualPlayer} ${manualThreshold}+ ${manualStat}`,
                              confidence: manualLookup!.hitRate10,
                              match: "Manual entry",
                              sport: "AFL",
                              odds,
                              bookie: "Manual",
                              confidenceSource: "stats",
                            }]);
                            setManualSearch(""); setManualPlayer(""); setManualThreshold(""); setManualOdds(""); setManualLookup(null);
                          }}
                          className="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-2.5 rounded-lg text-sm"
                        >
                          + Add to multi ({manualLookup.hitRate10}% L10)
                        </button>
                      )}
                    </div>
                  );
                })()
              )}
            </div>

            {/* Multi legs + summary */}
            {multi.length > 0 && (
              <>
                {/* Bookmaker consistency warning */}
                {(() => {
                  const bookies = [...new Set(multi.map((l) => l.bookie))];
                  return bookies.length > 1 ? (
                    <div className="bg-yellow-950 border border-yellow-700 rounded-xl p-3 text-sm text-yellow-300">
                      ⚠️ Legs from multiple bookmakers ({bookies.join(", ")}). For a same-game multi all legs must be at one provider.
                    </div>
                  ) : (
                    <div className="bg-green-950 border border-green-800 rounded-xl p-3 text-xs text-green-400">
                      ✓ All legs at {bookies[0]} — placeable as a single multi.
                    </div>
                  );
                })()}

                {/* Boost / bonus bet controls */}
                <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-white">Promotions</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-gray-400 w-24 shrink-0">Odds boost</span>
                    <div className="flex gap-1.5 flex-wrap">
                      {[0, 5, 10, 15, 20, 25].map((pct) => (
                        <button
                          key={pct}
                          onClick={() => setOddsBoostPct(pct)}
                          className={`px-2.5 py-1 rounded text-xs font-bold transition-colors ${oddsBoostPct === pct ? "bg-blue-500 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"}`}
                        >
                          {pct === 0 ? "None" : `+${pct}%`}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-gray-400 w-24 shrink-0">Bonus bet</span>
                    <button
                      onClick={() => setIsBonusBet(!isBonusBet)}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${isBonusBet ? "bg-blue-500" : "bg-gray-700"}`}
                    >
                      <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${isBonusBet ? "translate-x-4" : "translate-x-1"}`} />
                    </button>
                    <span className="text-xs text-gray-500">{isBonusBet ? "Stake not returned on win" : "Normal bet"}</span>
                  </div>
                </div>

                {/* Combined multi summary */}
                {(() => {
                  const boostedOdds = oddsBoostPct > 0
                    ? Math.round(combinedOdds * (1 + oddsBoostPct / 100) * 100) / 100
                    : combinedOdds;
                  // For a bonus bet, winnings = stake × (odds − 1) since stake isn't returned
                  const effectiveEv = isBonusBet
                    ? Math.round(((strikeRate / 100) * (boostedOdds - 1) * 100 - 100) * 100) / 100
                    : Math.round(((strikeRate / 100) * boostedOdds * 100 - 100) * 100) / 100;
                  const multiKelly = boostedOdds > 1
                    ? Math.max(0, Math.round(((strikeRate / 100) * boostedOdds - 1) / (boostedOdds - 1) * 1000) / 10)
                    : 0;
                  const multiStake = Math.round((multiKelly / 100) * 0.5 * bankroll);
                  const multiVerdict = effectiveEv >= 10 ? "BACK IT" : effectiveEv >= 0 ? "MARGINAL" : "AVOID";
                  const multiColor = multiVerdict === "BACK IT" ? "border-green-700 bg-green-950" : multiVerdict === "MARGINAL" ? "border-yellow-700 bg-yellow-950" : "border-red-800 bg-red-950";
                  return (
                    <div className={`rounded-xl border p-4 ${multiColor}`}>
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <span className={`text-xs font-bold px-2 py-0.5 rounded ${multiVerdict === "BACK IT" ? "bg-green-500 text-black" : multiVerdict === "MARGINAL" ? "bg-yellow-500 text-black" : "bg-red-600 text-white"}`}>
                            {multiVerdict}
                          </span>
                          <span className="text-gray-400 text-xs ml-2">{multi.length}-leg multi</span>
                          {isBonusBet && <span className="text-blue-400 text-xs ml-2">· bonus bet</span>}
                        </div>
                        {multiStake > 0 && multiVerdict !== "AVOID" && (
                          <div className="text-right">
                            <div className="text-white font-black text-xl">${multiStake}</div>
                            <div className="text-gray-500 text-xs">recommended stake</div>
                          </div>
                        )}
                      </div>
                      <div className="grid grid-cols-3 gap-3 text-center">
                        <div>
                          <div className="text-xl font-bold text-white">${boostedOdds}</div>
                          {oddsBoostPct > 0 && (
                            <div className="text-gray-500 text-xs line-through">${combinedOdds}</div>
                          )}
                          <div className="text-gray-400 text-xs mt-0.5">Combined odds</div>
                        </div>
                        <div>
                          <div className="text-xl font-bold text-white">{strikeRate}%</div>
                          <div className="text-gray-400 text-xs mt-0.5">Strike rate</div>
                        </div>
                        <div>
                          <div className={`text-xl font-bold ${effectiveEv >= 0 ? "text-green-400" : "text-red-400"}`}>
                            {effectiveEv >= 0 ? "+" : ""}${effectiveEv}
                          </div>
                          <div className="text-gray-400 text-xs mt-0.5">EV per $100</div>
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {/* Legs */}
                <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
                  <div className="px-4 py-3 border-b border-gray-800 flex justify-between items-center">
                    <h2 className="font-semibold text-sm">Your legs ({multi.length})</h2>
                    <button onClick={() => setMulti([])} className="text-red-400 text-xs hover:text-red-300">
                      Clear all
                    </button>
                  </div>
                  <div className="divide-y divide-gray-800">
                    {multi.map((leg) => (
                      <div key={leg.id} className="px-4 py-3 flex items-center justify-between">
                        <div>
                          <div className="font-medium text-sm">{leg.tip}</div>
                          <div className="text-gray-500 text-xs mt-0.5">@ {leg.bookie} · {leg.confidence}% L10</div>
                        </div>
                        <div className="flex items-center gap-3">
                          <div className="text-right">
                            <div className="text-green-400 font-bold">${leg.odds}</div>
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

                <div className="bg-gray-900 rounded-xl border border-gray-800 p-3 text-xs text-gray-500">
                  💡 All legs must be at the same bookmaker for a same-game multi. Check for multi insurance promos before placing.
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
                  {(["all", "disposals", "kicks", "marks", "handballs", "tackles", "clearances", "goals"] as const).map((s) => (
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

                {/* Bayesian edge filter — same metric as Auto Multi and Top Picks */}
                <div className="flex gap-2 items-center">
                  <span className="text-xs text-gray-500">Min Bayesian edge:</span>
                  {[0, 5, 10, 15].map((e) => (
                    <button
                      key={e}
                      onClick={() => setEdgeFilter(e)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                        edgeFilter === e ? "bg-green-500 text-black" : "bg-gray-800 text-gray-300 hover:bg-gray-700"
                      }`}
                    >
                      {e === 0 ? "Any" : `+${e}%`}
                    </button>
                  ))}
                </div>

                <p className="text-gray-500 text-xs">
                  {props.filter((p) => bayesianEdge(p) >= edgeFilter && (statFilter === "all" || p.statType === statFilter)).length} bets · Bayesian edge {edgeFilter > 0 ? `+${edgeFilter}%+` : "any"} · Tap to add to multi
                </p>

                {props.filter((p) => bayesianEdge(p) >= edgeFilter && (statFilter === "all" || p.statType === statFilter)).sort((a, b) => {
                  // Named players first, then by game time (soonest first), then by Bayesian edge
                  const namedRank = (p: PlayerProp) => {
                    const ls = lineupStatus(p.playerName);
                    if (ls === "named") return 0;
                    if (ls === "unknown") return 1;
                    if (ls === "emergency") return 2;
                    return 3;
                  };
                  const nDiff = namedRank(a) - namedRank(b);
                  if (nDiff !== 0) return nDiff;
                  const tDiff = new Date(a.commenceTime).getTime() - new Date(b.commenceTime).getTime();
                  if (tDiff !== 0) return tDiff;
                  return bayesianEdge(b) - bayesianEdge(a);
                }).map((prop) => {
                  const propId = `prop-${prop.playerName}-${prop.statType}`;
                  const inMulti = !!multi.find((l) => l.id === propId);
                  const isExpanded = expandedProp === propId;
                  const marketThreshold = Math.ceil(prop.marketLine);

                  // 9 thresholds centred on the market line
                  const displayThresholds = prop.thresholds.filter(
                    (t) => t.threshold >= marketThreshold - 4 && t.threshold <= marketThreshold + 4
                  );

                  // Bookmaker odds summary
                  const bookieEntries = Object.entries(prop.bookmakerOdds).sort((a, b) => b[1] - a[1]);

                  return (
                    <div
                      key={`${prop.playerName}-${prop.statType}`}
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
                                prop.statType === "disposals"  ? "bg-purple-900 text-purple-300" :
                                prop.statType === "goals"      ? "bg-orange-900 text-orange-300" :
                                prop.statType === "marks"      ? "bg-cyan-900 text-cyan-300" :
                                prop.statType === "kicks"      ? "bg-blue-900 text-blue-300" :
                                prop.statType === "handballs"  ? "bg-pink-900 text-pink-300" :
                                prop.statType === "tackles"    ? "bg-red-900 text-red-300" :
                                prop.statType === "clearances" ? "bg-teal-900 text-teal-300" :
                                "bg-gray-700 text-gray-300"
                              }`}>
                                {prop.statLabel}
                              </span>
                              {prop.isAlternateLine && (
                                <span className="text-xs bg-orange-900 text-orange-300 px-1.5 py-0.5 rounded font-semibold">
                                  ALT LINE ★
                                </span>
                              )}
                              {prop.coldForm && (
                                <span className="text-xs bg-yellow-900 text-yellow-300 px-1.5 py-0.5 rounded font-semibold">
                                  COLD FORM ⚠️
                                </span>
                              )}
                              {(() => {
                                const ls = lineupStatus(prop.playerName);
                                if (ls === "named") return <span className="text-xs bg-green-900 text-green-300 px-1.5 py-0.5 rounded font-semibold">NAMED ✓</span>;
                                if (ls === "emergency") return <span className="text-xs bg-yellow-900 text-yellow-300 px-1.5 py-0.5 rounded font-semibold">EMERGENCY</span>;
                                if (ls === "not-named") return <span className="text-xs bg-red-900 text-red-300 px-1.5 py-0.5 rounded font-semibold">NOT NAMED ✗</span>;
                                return null;
                              })()}
                              {inMulti && <span className="text-xs bg-green-500 text-black px-1.5 py-0.5 rounded font-bold">IN MULTI ✓</span>}
                            </div>
                            <div className="font-semibold text-white text-sm">{prop.playerName}</div>
                            <div className="text-gray-400 text-xs mt-0.5">{prop.matchup}</div>

                            {/* Best line (selected for edge) */}
                            <div className="mt-2 bg-gray-800 rounded-lg px-3 py-2">
                              <div className="flex items-center justify-between">
                                <div className="font-bold text-white text-sm">
                                  {marketThreshold}+ {prop.statLabel}
                                  <span className="ml-2 font-normal text-xs text-gray-400">(line {prop.marketLine})</span>
                                </div>
                                <span className="text-green-400 text-xs font-semibold">+{prop.recentEdge}% L10 edge</span>
                              </div>
                              <div className="text-gray-500 text-xs mt-0.5">
                                Best: ${prop.bestOdds} @ {prop.bestBookie} · {prop.bookmakerImplied}% implied
                              </div>
                              {/* Per-bookie odds */}
                              {bookieEntries.length > 1 && (
                                <div className="flex flex-wrap gap-1 mt-1.5">
                                  {bookieEntries.map(([bk, odds]) => (
                                    <span key={bk} className={`text-xs px-1.5 py-0.5 rounded ${bk === prop.bestBookie ? "bg-green-800 text-green-200 font-semibold" : "bg-gray-700 text-gray-400"}`}>
                                      {bk} ${odds}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>

                            {/* All priced lines (if alternate lines exist) */}
                            {prop.allPricedLines.length > 1 && (
                              <div className="mt-1.5 space-y-1">
                                {prop.allPricedLines.map((pl) => {
                                  const isBest = pl.line === prop.marketLine;
                                  return (
                                    <div key={pl.line} className={`flex items-center justify-between text-xs rounded px-2.5 py-1 ${isBest ? "bg-orange-950 border border-orange-800" : "bg-gray-850 border border-gray-800"}`}>
                                      <span className={isBest ? "text-orange-300 font-semibold" : "text-gray-400"}>
                                        {Math.ceil(pl.line)}+ {prop.statLabel} @ ${pl.bestOdds} ({pl.bestBookie})
                                        {isBest && <span className="ml-1 text-orange-400">← best edge</span>}
                                      </span>
                                      <div className="flex items-center gap-2 shrink-0 ml-2">
                                        <span className={pl.hitRate >= 75 ? "text-green-400" : pl.hitRate >= 65 ? "text-yellow-400" : "text-gray-400"}>{pl.hitRate}%</span>
                                        <span className={`font-semibold ${pl.edge >= 10 ? "text-green-400" : pl.edge >= 0 ? "text-yellow-400" : "text-red-400"}`}>{pl.edge >= 0 ? "+" : ""}{pl.edge}%</span>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}

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
                            <div className={`text-2xl font-bold ${prop.hitRate10 >= 75 ? "text-green-400" : prop.hitRate10 >= 65 ? "text-yellow-400" : "text-gray-400"}`}>
                              {prop.hitRate10}%
                            </div>
                            <div className="text-gray-500 text-xs">L10 hit rate</div>
                            <div className="text-green-400 text-sm font-semibold mt-0.5">+{prop.recentEdge}% edge</div>
                            <div className="text-gray-600 text-xs mt-1">{prop.hitRate}% all-time</div>
                            <div className={`text-xs ${prop.hitRate5 >= prop.hitRate - 10 ? "text-green-400" : prop.hitRate5 >= prop.hitRate - 25 ? "text-yellow-400" : "text-red-400"}`}>
                              {prop.hitRate5}% L5
                            </div>
                            <div className="text-gray-400 text-xs mt-1">{prop.gamesAnalysed} games</div>
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
                            Recency-weighted hit rate — recent games count more than 2023/24 data
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
                            Hit rates are recency-weighted (half-life 20 games). Edge shown where real bookmaker prices exist.
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
                <p className="font-medium text-white">Player prop analysis</p>
                <p className="text-sm mt-1 mb-4">Compares real hit rates vs bookmaker lines across 3 seasons of data.</p>
              </div>
            )}
          </div>
        )}

        {/* TOP PICKS TAB — historical signal layer, independent of Odds API */}
        {tab === "picks" && (
          <div className="space-y-3">
            {picksLoading ? (
              <div className="text-center py-16 text-gray-400">
                <div className="text-4xl mb-3">🔍</div>
                <p className="font-medium text-white">Scanning all players…</p>
                <p className="text-sm mt-1 text-gray-500">Finding optimal threshold per player across every stat.</p>
              </div>
            ) : (
              <>
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 text-sm text-gray-400">
                  <p className="font-medium text-white mb-1">Model-identified value picks</p>
                  <p>These players have strong historical data at the suggested line — regardless of what the Odds API has priced. Check Sportsbet pick-your-own for current odds, then add to My Multi.</p>
                </div>

                {/* Stat filter */}
                <div className="flex gap-1 flex-wrap">
                  {(["all", "disposals", "kicks", "marks", "handballs", "tackles", "goals"] as const).map((s) => (
                    <button key={s} onClick={() => setPicksStatFilter(s)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold capitalize transition-colors ${
                        picksStatFilter === s ? "bg-blue-500 text-white" : "bg-gray-800 text-gray-300 hover:bg-gray-700"
                      }`}>
                      {s === "all" ? "All stats" : s}
                    </button>
                  ))}
                </div>

                {/* Bayesian threshold filter */}
                <div className="flex gap-2 items-center">
                  <span className="text-xs text-gray-500">Min Bayesian:</span>
                  {[70, 75, 80, 85].map((b) => (
                    <button key={b} onClick={() => {
                      setPicksMinBayesian(b);
                      setPicksLoading(true);
                      fetch(`/api/player-picks?minBayesian=${b}`)
                        .then((r) => r.json())
                        .then((d) => { setHistoricalPicks(d.picks ?? []); setPicksLoading(false); });
                    }}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                        picksMinBayesian === b ? "bg-green-500 text-black" : "bg-gray-800 text-gray-300 hover:bg-gray-700"
                      }`}>
                      {b}%+
                    </button>
                  ))}
                </div>

                {(() => {
                  const filtered = historicalPicks.filter(
                    (p) => picksStatFilter === "all" || p.statType === picksStatFilter
                  );
                  return (
                    <>
                      <p className="text-gray-500 text-xs">{filtered.length} picks · Bayesian {picksMinBayesian}%+ · Tap line to add to My Multi</p>
                      <div className="space-y-2">
                        {filtered.map((pick) => {
                          const formColor = (val: number) => val >= pick.suggestedThreshold ? "bg-green-500" : "bg-red-500";
                          const liveProp = props.find((lp) => lp.playerName === pick.playerName && lp.statType === pick.statType);
                          return (
                            <div key={`${pick.playerName}-${pick.statType}`}
                              className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                              <div className="flex items-start justify-between gap-2">
                                <div>
                                  <div className="font-semibold text-white">{pick.playerName}</div>
                                  {liveProp?.matchup && (
                                    <div className="text-xs text-blue-400 mt-0.5">{liveProp.matchup}</div>
                                  )}
                                  <div className="text-green-400 font-bold text-sm mt-0.5">{pick.suggestedLine}</div>
                                  <div className="text-xs text-gray-500 mt-0.5">Season avg: {pick.seasonAvg} · {pick.gamesAnalysed} games</div>
                                </div>
                                <div className="text-right">
                                  <div className="text-2xl font-bold text-white">{pick.bayesianRate}%</div>
                                  <div className="text-xs text-gray-400">Bayesian</div>
                                </div>
                              </div>

                              {/* Stat bars */}
                              <div className="flex gap-1 mt-3 items-end">
                                {pick.recentForm.map((val, i) => (
                                  <div key={i} className="flex-1 flex flex-col items-center gap-1">
                                    <div className="text-xs text-gray-400 font-mono">{val}</div>
                                    <div className={`w-full h-2 rounded-full ${formColor(val)}`} />
                                  </div>
                                ))}
                              </div>
                              <div className="text-xs text-gray-600 mt-1">← last 5 games</div>

                              {/* Hit rate row */}
                              <div className="flex gap-3 mt-3 text-xs">
                                <span className="text-gray-400">L5: <span className="text-white font-semibold">{pick.hitRate5}%</span></span>
                                <span className="text-gray-400">L10: <span className="text-white font-semibold">{pick.hitRate10}%</span></span>
                                <span className="text-gray-400">All: <span className="text-white font-semibold">{pick.allTimeRate}%</span></span>
                              </div>

                              <button
                                onClick={() => {
                                  setManualPlayer(pick.playerName);
                                  setManualStat(pick.statType as "disposals"|"kicks"|"marks"|"handballs"|"tackles"|"clearances"|"goals");
                                  setManualThreshold(String(pick.suggestedThreshold));
                                  setTab("builder");
                                }}
                                className="mt-3 w-full py-2 rounded-lg bg-green-500 text-black text-xs font-bold hover:bg-green-400 transition-colors"
                              >
                                Add to My Multi →
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  );
                })()}
              </>
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
