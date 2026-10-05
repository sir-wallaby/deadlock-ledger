// player_match_outcome values from match history:
// 0=invalid 1=win 2=loss 3=penalized 4=penalized party 5=not scored
export const OUTCOME = {
    INVALID: 0,
    WIN: 1,
    LOSS: 2,
    PENALIZED: 3,
    PENALIZED_PARTY: 4,
    NOT_SCORED: 5
};

// A scored match counts toward win totals; penalized and not-scored matches
// do not. Rows without the field (older data) are treated as scored.
// A 0/0/0 KDA match is one the player never actually played (instant
// disconnect / auto-win) — the game marks those not-scored too, and the GC
// can't, so detect it here.
export function isMatchScored(m) {
    const o = m.player_match_outcome;
    if (o === undefined || o === null) return true;
    if (o === OUTCOME.PENALIZED || o === OUTCOME.PENALIZED_PARTY || o === OUTCOME.NOT_SCORED) return false;
    return !(m.player_kills === 0 && m.player_deaths === 0 && m.player_assists === 0);
}

export function isMatchWon(m) {
    const o = m.player_match_outcome;
    if (o === undefined || o === null || o === OUTCOME.INVALID) {
        return m.match_result === m.player_team;
    }
    return o === OUTCOME.WIN;
}
