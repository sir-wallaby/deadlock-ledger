// Deadlock ranked-season model (S2) — display-side constants.
//
// The season boundaries below are also duplicated in deadlockApi.js, which
// needs them to scope ranked matches but can't import this file (services
// must not import each other — LWR rebases relative imports). Keep in sync.

export const RANKED_GAME_MODE = 1; // Standard (normal)
export const RANKED_MATCH_MODE = 4; // Ranked

// Season boundaries, UTC. S1 ended an hour early (12pm PST); the last
// season is open-ended for scoping (its `end` is display-only).
export const SEASONS = [
    {
        id: 1,
        name: 'Beta Season 1',
        start: Date.UTC(2026, 6, 30),
        end: Date.UTC(2026, 10, 5, 20, 0, 0)
    },
    {
        id: 2,
        name: 'Beta Season 2',
        start: Date.UTC(2026, 10, 5, 20, 0, 0),
        end: Date.UTC(2027, 2, 11)
    }
];

// Largest season index whose start is <= the timestamp, or -1.
export function seasonIndexFor(timestampSec) {
    const ms = timestampSec * 1000;
    let idx = -1;
    for (let i = 0; i < SEASONS.length; i++) {
        if (ms >= SEASONS[i].start) idx = i;
        else break;
    }
    return idx;
}

// S2 mechanics (for labels).
export const CALIBRATION_MATCHES = 8;
export const RANKED_POINTS_PER_MATCH = 350;

// Faction name per lobby team index. The GC metadata only carries the index
// (ECitadelLobbyTeam 0/1 — no faction field), but the mapping is a stable
// game-side fact, verified 7/7 of the account's matches against a third-party
// tracker (Nov 19 2026): team 0 is always The Hidden King, team 1 The Archmother.
export const TEAM_FRACTIONS = { 0: 'The Hidden King', 1: 'The Archmother' };

// Rank-points ladder — what the per-match metadata's `flat_progress` means:
// cumulative rank points, Initiate I = 0. points(R, S) = (R-1)*6500 +
// (S-1)*1000 for R = 1..10 (Initiate..Ascendant), S = 1..6 (I..VI); subrank
// VI is 1500 wide (it ends at the next rank's start); Eternus is
// percentile-based from 65,000 up. Verified against live match data.
export const RANK_POINTS_PER_RANK = 6500;
export const RANK_POINTS_PER_SUBRANK = 1000;
export const ETERNUS_POINTS = 65000;

// Official S2 rank names, by rank number (1..11).
export const RANK_NAMES = {
    1: 'Initiate',
    2: 'Seeker',
    3: 'Acolyte',
    4: 'Sentinel',
    5: 'Mystic',
    6: 'Ritualist',
    7: 'Emissary',
    8: 'Oracle',
    9: 'Phantom',
    10: 'Ascendant',
    11: 'Eternus'
};

// The rank's material (deadlock.wiki "Material" column) — the secondary name
// on the badge. Phantom and above have none.
export const RANK_MATERIALS = {
    1: 'Brick',
    2: 'Stone',
    3: 'Iron',
    4: 'Bronze',
    5: 'Silver',
    6: 'Gold',
    7: 'Platinum',
    8: 'Diamond'
};

export const ROMAN = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV', 5: 'V', 6: 'VI' };

// Map a flat_progress value onto the ladder: its rank, subrank, and the
// point range of that subrank (subrankEnd is null for Eternus — no fixed end).
export function rankForPoints(points) {
    if (points >= ETERNUS_POINTS) {
        return {
            rank: 11,
            subrank: 0,
            rankStart: ETERNUS_POINTS,
            subrankStart: points,
            subrankEnd: null
        };
    }
    const rank = Math.min(10, Math.floor(points / RANK_POINTS_PER_RANK) + 1);
    const rankStart = (rank - 1) * RANK_POINTS_PER_RANK;
    const subrank = Math.min(
        6,
        Math.floor((points - rankStart) / RANK_POINTS_PER_SUBRANK) + 1
    );
    const subrankStart = rankStart + (subrank - 1) * RANK_POINTS_PER_SUBRANK;
    const subrankEnd =
        subrank === 6
            ? rankStart + RANK_POINTS_PER_RANK
            : subrankStart + RANK_POINTS_PER_SUBRANK;
    return { rank, subrank, rankStart, subrankStart, subrankEnd };
}

// Badge encoding (verified against live data): badge = rank*10 + subrank,
// subrank 1..6 (I..VI). Badge 0 = Obscurus (calibration / unrated).
export function decodeBadge(badge) {
    if (!badge) {
        return { rank: 0, subrank: 0, name: 'Obscurus', numeral: '', material: '', icon: '' };
    }
    const rank = Math.floor(badge / 10);
    const subrank = badge % 10;
    const name = RANK_NAMES[rank] || `Rank ${rank}`;
    return {
        rank,
        subrank,
        name,
        numeral: ROMAN[subrank] || '',
        material: RANK_MATERIALS[rank] || '',
        icon: rankIcon(name)
    };
}

// Display name for a badge: "Seeker V (Stone)". Obscurus passes through.
export function rankLabel(badge) {
    const r = decodeBadge(badge);
    if (r.rank === 0) return r.name;
    let s = r.numeral ? `${r.name} ${r.numeral}` : r.name;
    if (r.material) s += ` (${r.material})`;
    return s;
}

// The 11 user-provided base badges (no baked-in numeral) live in
// src/assets, served at /public/assets.
export function rankIcon(rankName) {
    return `/public/assets/rank-icons/Rank_${rankName}_Badge.webp`;
}
