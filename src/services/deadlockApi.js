const API = 'https://api.deadlock-api.com/v1';

// Deadlock internal game_mode codes (match-history returns integers, not the
// string enum used by hero-stats). 1 = normal (Standard).
const STANDARD_GAME_MODE = 1;
// Ranked is Standard (game_mode 1) with match_mode 4.
const RANKED_MATCH_MODE = 4;

// Season starts (UTC), duplicated from services/constants.js — services
// can't import each other (LWR rebases relative imports). Keep in sync.
const SEASON_STARTS = [
    Date.UTC(2026, 6, 30), // Beta Season 1
    Date.UTC(2026, 10, 5, 20, 0, 0) // Beta Season 2 (an hour early, 12pm PST)
];

// Match history for this account is self-hosted: a small Rust tool
// (deadlock-gc-history) on the machine running Steam polls the Steam Game
// Coordinator every 10 minutes and publishes the JSON here, served at /data/
// by nginx. It is fresher than the public API, so it is the primary source
// for this account; anything else (and any failure) falls back to the API.
export const LOCAL_ACCOUNT_ID = 199434043;
const LOCAL_MATCH_HISTORY_URL = '/data/match-history.json';
// Own-account ranked state from the GC poller (absent under dev / before
// the first push — both are 404-tolerant).
const LOCAL_RANK_DATA_URL = '/data/rank-data.json';
const LOCAL_HERO_MMR_URL = '/data/hero-mmr.json';
// The updater runs every 10 min and touches the file on every run (even when
// content is unchanged), so a file older than this means the updater is not
// running; surface the same staleness banner the API path would.
const LOCAL_STALE_AFTER_MS = 30 * 60 * 1000;

// Largest season index whose start is <= the timestamp (ms), or -1.
// (Duplicated logic from services/constants.js — see SEASON_STARTS.)
function seasonIndexFor(ms) {
    let idx = -1;
    for (let i = 0; i < SEASON_STARTS.length; i++) {
        if (ms >= SEASON_STARTS[i]) idx = i;
        else break;
    }
    return idx;
}

async function getLocalMatchHistory() {
    const res = await fetch(LOCAL_MATCH_HISTORY_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`local match history ${res.status}`);
    const matches = await res.json();
    if (!Array.isArray(matches) || matches.length === 0) {
        throw new Error('local match history is empty');
    }
    let fresh = true;
    let lastUpdated = null;
    const lastModified = res.headers.get('Last-Modified');
    if (lastModified) {
        lastUpdated = Date.parse(lastModified);
        if (!Number.isNaN(lastUpdated) && Date.now() - lastUpdated > LOCAL_STALE_AFTER_MS) fresh = false;
    }
    return { matches, fresh, lastUpdated };
}

// The /players/hero-stats endpoint only reflects recent matches (~30 days),
// which badly undercounts a player's all-time record. Aggregate the full
// match history instead, keeping the same per-hero shape the UI expects.
//
// The match-history endpoint takes no `limit` param — it returns the player's
// whole stored history. Freshness depends on whether the API has a live Steam
// connection for this account: the `Called-Steam` response header is `true`
// only when Steam was actually queried. `false` means the response is the last
// stored snapshot, which may be missing recent matches. On a 429 (hourly rate
// limit) the API still returns that stored snapshot in the body, so we use it
// and flag it stale instead of erroring out.
//
// `isScored`/`isWon` are predicates supplied by the caller (see outcomes.js).
// Services don't import each other — LWR's bundler can't resolve relative
// imports between non-module files.
export async function getPlayerHeroStats(accountId, {
    isScored = () => true,
    isWon = (m) => m.match_result === m.player_team,
} = {}) {
    let matches = null; // null = not loaded yet (fall back to the API below)
    let fresh;
    let rateLimited = false;
    let source = 'api';
    let localUpdated = null;

    if (Number(accountId) === LOCAL_ACCOUNT_ID) {
        try {
            ({ matches, fresh, lastUpdated: localUpdated } = await getLocalMatchHistory());
            source = 'local';
        } catch {
            matches = null; // fall back to the API below
        }
        if (matches !== null) {
            // The GC only serves recent history, but the game's win counts
            // include the older beta-era matches only the API still has. Add
            // any API match the local file lacks so totals match the game
            // (on duplicate match ids the local/GC row wins).
            try {
                const apiRes = await fetch(`${API}/players/${accountId}/match-history`);
                if (apiRes.ok || apiRes.status === 429) {
                    const apiMatches = await apiRes.json();
                    if (Array.isArray(apiMatches)) {
                        const localById = new Map(matches.map((m) => [m.match_id, m]));
                        for (const m of apiMatches) {
                            if (!m) continue;
                            const existing = localById.get(m.match_id);
                            if (existing) {
                                // The GC sends the real outcome enum but leaves
                                // it unset (0) for some matches (e.g. beta-era
                                // ones); when the API has the real value,
                                // prefer it. (Ranked fields are the poller's
                                // own now — never backfilled from the API.)
                                if (m.player_match_outcome) {
                                    existing.player_match_outcome = m.player_match_outcome;
                                }
                            } else {
                                matches.push(m);
                            }
                        }
                    }
                }
            } catch {
                // local-only is fine
            }
        }
    }

    if (matches === null) {
        const res = await fetch(`${API}/players/${accountId}/match-history`);
        fresh = res.headers.get('Called-Steam') === 'true';
        rateLimited = res.status === 429;

        if (res.ok || rateLimited) {
            matches = await res.json();
        } else {
            let detail = '';
            try {
                detail = (await res.text()).slice(0, 200);
            } catch {
                detail = '';
            }
            throw new Error(`Deadlock API ${res.status}${detail ? ' — ' + detail : ''}`);
        }
    }
    const byHero = new Map();
    for (const m of matches) {
        if (m.game_mode !== STANDARD_GAME_MODE) continue;
        // Penalized and not-scored matches don't count toward ranked progress,
        // so they are excluded from the per-hero aggregation entirely.
        if (!isScored(m)) continue;
        const heroId = m.hero_id;
        let h = byHero.get(heroId);
        if (!h) {
            h = {
                hero_id: heroId,
                wins: 0,
                matches_played: 0,
                kills: 0,
                deaths: 0,
                assists: 0,
                last_played: 0
            };
            byHero.set(heroId, h);
        }
        h.matches_played += 1;
        // A win is when the player's team is the winning team. `match_result`
        // holds the winning team id and `player_team` the player's team, so a
        // win is `match_result === player_team` (not `match_result === 1`).
        // The caller's isWon prefers the real outcome field when present.
        if (isWon(m)) h.wins += 1;
        h.kills += m.player_kills || 0;
        h.deaths += m.player_deaths || 0;
        h.assists += m.player_assists || 0;
        if (m.start_time > h.last_played) h.last_played = m.start_time;
    }
    // Newest three Standard matches, for the "last played" display. Scoped to
    // Standard (game_mode 1) to match the per-hero aggregation above; a
    // ranked-only filter can be layered on later.
    const recentMatches = matches
        .filter((m) => m.start_time && m.game_mode === STANDARD_GAME_MODE)
        .sort((a, b) => b.start_time - a.start_time)
        .slice(0, 3);
    // Ranked matches for the chart/rank card: scoped to the newest season in
    // which the player actually played ranked (an S1-only player sees their
    // S1 run, not an empty S2), newest first. Ranked fields come from the
    // poller (interval-scoped GC call + coalesce for older seasons); the
    // API-only beta-era rows it appends carry their own.
    const ranked = matches.filter(
        (m) => m.game_mode === STANDARD_GAME_MODE && m.match_mode === RANKED_MATCH_MODE
    );
    let newestRankedSeason = -1;
    for (const m of ranked) {
        const idx = seasonIndexFor(m.start_time * 1000);
        if (idx > newestRankedSeason) newestRankedSeason = idx;
    }
    const rankedMatches =
        newestRankedSeason === -1
            ? []
            : ranked
                  .filter((m) => seasonIndexFor(m.start_time * 1000) === newestRankedSeason)
                  .sort((a, b) => b.start_time - a.start_time);
    return {
        stats: Array.from(byHero.values()),
        recentMatches,
        rankedMatches,
        fresh,
        rateLimited,
        source,
        localUpdated,
    };
}

export function isLocalAccount(accountId) {
    return Number(accountId) === LOCAL_ACCOUNT_ID;
}

// 404-tolerant JSON fetch for the own-account data files: they are absent
// under `npm run dev` and until the first poller push, and absence is a
// normal state (feature degrades), not an error.
async function fetchLocalJson(url) {
    try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    }
}

// Own-account ranked state: rank-data.json (SO cache + GetRankData) and
// hero-mmr.json (GetHeroMMRRankings). Only the local account has these
// files; for anyone else (and when both are missing) returns null.
export async function getLocalRankedData(accountId) {
    if (!isLocalAccount(accountId)) return null;
    const [rank, heroMmr] = await Promise.all([
        fetchLocalJson(LOCAL_RANK_DATA_URL),
        fetchLocalJson(LOCAL_HERO_MMR_URL)
    ]);
    if (!rank && !heroMmr) return null;
    return { rank, heroMmr };
}
