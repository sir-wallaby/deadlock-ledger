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

const ROMAN = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV', 5: 'V', 6: 'VI' };

// Badge encoding (verified against live data): badge = rank*10 + subrank,
// subrank 1..6 (I..VI). Badge 0 = Obscurus (calibration / unrated).
export function decodeBadge(badge) {
    if (!badge) {
        return { rank: 0, subrank: 0, name: 'Obscurus', numeral: '', icon: '' };
    }
    const rank = Math.floor(badge / 10);
    const subrank = badge % 10;
    const name = RANK_NAMES[rank] || `Rank ${rank}`;
    return {
        rank,
        subrank,
        name,
        numeral: ROMAN[subrank] || '',
        icon: rankIcon(name)
    };
}

// The 11 user-provided base badges (no baked-in numeral) live in
// src/assets, served at /public/assets.
export function rankIcon(rankName) {
    return `/public/assets/rank-icons/Rank_${rankName}_Badge.webp`;
}
