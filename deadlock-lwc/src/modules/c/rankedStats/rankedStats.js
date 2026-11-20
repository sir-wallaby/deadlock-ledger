import { LightningElement, api, track } from 'lwc';
import {
    CALIBRATION_MATCHES,
    RANK_NAMES,
    ROMAN,
    RANK_POINTS_PER_RANK,
    RANK_POINTS_PER_SUBRANK,
    ETERNUS_POINTS,
    TEAM_FRACTIONS,
    decodeBadge,
    rankForPoints,
    rankLabel
} from '../../../../services/constants.js';
import { isMatchScored, isMatchWon } from '../../../../services/outcomes.js';
import { LOCAL_ACCOUNT_ID } from '../../../../services/deadlockApi.js';

// SVG geometry (viewBox units); right padding holds the subrank labels,
// bottom padding the date labels.
const CHART = { w: 600, h: 170, padL: 10, padR: 76, padT: 10, padB: 24, dot: 4.5 };

const ET_TIME_ZONE = 'America/New_York';

const ET_FORMATTER = new Intl.DateTimeFormat('en-US', {
    timeZone: ET_TIME_ZONE,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
});

function formatEt(timestamp) {
    try {
        return ET_FORMATTER.format(new Date(timestamp * 1000));
    } catch {
        return new Date(timestamp * 1000).toString();
    }
}

const ET_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
    timeZone: ET_TIME_ZONE,
    month: 'short',
    day: 'numeric'
});

function formatDate(timestamp) {
    try {
        return ET_DATE_FORMATTER.format(new Date(timestamp * 1000));
    } catch {
        return '';
    }
}

function isCalibration(m) {
    return m.ranked_calibration_match > 0;
}

function deltaText(delta) {
    if (delta === null || delta === undefined) return '—';
    if (delta > 0) return `+${delta}`;
    return delta === 0 ? '0' : `−${Math.abs(delta)}`;
}

// The rank/subrank name at the top of a subrank span: the next subrank of
// the same rank, or the next rank's I (Eternus above Ascendant VI).
function borderName(info) {
    if (info.subrank < 6) {
        return `${RANK_NAMES[info.rank]} ${ROMAN[info.subrank + 1]}`;
    }
    const next = info.rank + 1;
    return next === 11 ? RANK_NAMES[11] : `${RANK_NAMES[next]} I`;
}

// Rank-ladder bar for one match: the window spans the full rank(s) covered
// by before/after, with a tick at every subrank border (thin) and rank
// border (thick), subrank roman numerals centered in each subrank span, and
// rank names at each rank's start. Markers sit at the before/after points.
function buildLadder(before, after) {
    const loR = rankForPoints(Math.min(before, after));
    const hiR = rankForPoints(Math.max(before, after));
    const start = (loR.rank - 1) * RANK_POINTS_PER_RANK;
    const end =
        hiR.rank === 11
            ? Math.max(before, after) + RANK_POINTS_PER_SUBRANK // Eternus has no fixed end — show a 1000-pt window
            : hiR.rank * RANK_POINTS_PER_RANK;
    const span = end - start;
    const pct = (p) => ((p - start) / span) * 100;

    const ticks = [];
    const sublabels = [];
    const rankLabels = [];
    for (let r = loR.rank; r <= hiR.rank && r <= 10; r++) {
        const rankStart = (r - 1) * RANK_POINTS_PER_RANK;
        rankLabels.push({
            key: `r${r}`,
            text: RANK_NAMES[r] || '',
            style: `left: ${pct(rankStart).toFixed(2)}%`
        });
        for (let s = 1; s <= 6; s++) {
            const sStart = rankStart + (s - 1) * RANK_POINTS_PER_SUBRANK;
            const sEnd =
                s === 6
                    ? rankStart + RANK_POINTS_PER_RANK
                    : sStart + RANK_POINTS_PER_SUBRANK;
            if (sEnd <= start || sStart >= end) continue;
            sublabels.push({
                key: `s${r}-${s}`,
                text: ROMAN[s],
                style: `left: ${pct((sStart + sEnd) / 2).toFixed(2)}%`
            });
            // Border between subrank s-1 and s (the rank start itself is the bar edge).
            if (s > 1) {
                ticks.push({
                    key: `t${r}-${s}`,
                    cls: 'match-mmr__ladder-tick',
                    style: `left: ${pct(sStart).toFixed(2)}%`
                });
            }
        }
    }
    if (hiR.rank === 11) {
        rankLabels.push({
            key: 'r11',
            text: RANK_NAMES[11] || '',
            style: `left: ${pct(ETERNUS_POINTS).toFixed(2)}%`
        });
    }
    // Rank borders strictly inside the window (thicker ticks).
    for (let r = loR.rank + 1; r <= hiR.rank && r <= 10; r++) {
        const border = (r - 1) * RANK_POINTS_PER_RANK;
        if (border > start && border < end) {
            ticks.push({
                key: `tb${r}`,
                cls: 'match-mmr__ladder-tick match-mmr__ladder-tick--rank',
                style: `left: ${pct(border).toFixed(2)}%`
            });
        }
    }

    const applied = after - before;
    return {
        ticks,
        sublabels,
        rankLabels,
        beforeStyle: `left: ${pct(before).toFixed(2)}%`,
        afterStyle: `left: ${pct(after).toFixed(2)}%`,
        afterCls:
            'match-mmr__ladder-marker match-mmr__ladder-marker--after' +
            (applied > 0
                ? ' match-mmr__ladder-marker--up'
                : applied < 0
                    ? ' match-mmr__ladder-marker--down'
                    : '')
    };
}

export default class RankedStats extends LightningElement {
    // Raw ranked rows for the current season, newest first (from
    // getPlayerHeroStats). heroMap: hero_id -> hero metadata.
    // matchMeta: the poller's match-meta.json ({ matches: { id: entry } }),
    // own account only (null otherwise / under dev).
    @api rankedMatches = [];
    @api heroMap = new Map();
    @api matchMeta = null;

    // The matches-list row the user selected for the Match MMR section. null =
    // auto (newest ranked match that has metadata).
    @track selectedMatchId = null;

    get show() {
        return Array.isArray(this.rankedMatches) && this.rankedMatches.length > 0;
    }

    get calibrationTotal() {
        return CALIBRATION_MATCHES;
    }

    // ---- Rank card ----

    // Primary rank = first known badge scanning newest → oldest. null means
    // no badge is known at all (distinct from 0 = Obscurus).
    get firstKnownBadge() {
        for (const m of this.rankedMatches) {
            const b = m.ranked_display_badge;
            if (b !== null && b !== undefined) return b;
        }
        return null;
    }

    get rankInfo() {
        const badge = this.firstKnownBadge;
        if (badge === null) return { name: 'Unrated', numeral: '', icon: '' };
        return decodeBadge(badge);
    }

    get rankTitle() {
        const r = this.rankInfo;
        let t = r.numeral ? `${r.name} ${r.numeral}` : r.name;
        if (r.material) t += ` (${r.material})`;
        return t;
    }

    // The own-account post-match MMR (match-meta final_flat_progress) for a
    // match — the number the in-game screen shows after it. null until the
    // poller has metadata for it, and null while the rank is unrevealed
    // (mid-calibration: the progress values are 0–245 placeholders, not MMR).
    ownMmr(m) {
        const meta = this.matchMeta;
        if (!meta || !meta.matches) return null;
        const entry = meta.matches[m.match_id];
        if (!entry) return null;
        const own = entry.players.find((p) => p.account_id === LOCAL_ACCOUNT_ID);
        const r = own && own.rank;
        if (!r || (r.initial_display_rank || 0) === 0) return null;
        const v = r.final_flat_progress;
        return v === null || v === undefined ? null : v;
    }

    // Current MMR = the newest ranked match with metadata. null until the
    // poller has metadata for at least one.
    get mmr() {
        for (const m of this.rankedMatches) {
            const value = this.ownMmr(m);
            if (value === null) continue;
            return this.mmrInfo(value);
        }
        return null;
    }

    // Ladder position of an MMR value: fill within the current subrank and
    // the distance to the next border (subrank, or the next rank's I).
    // Eternus has no fixed end — no bar.
    mmrInfo(value) {
        const info = rankForPoints(value);
        const out = {
            label: value.toLocaleString('en-US'),
            hasBar: info.subrankEnd !== null,
            pct: 0,
            toLabel: ''
        };
        if (info.subrankEnd !== null) {
            out.pct = Math.max(
                0,
                Math.min(
                    100,
                    Math.round(
                        ((value - info.subrankStart) / (info.subrankEnd - info.subrankStart)) * 100
                    )
                )
            );
            out.toLabel = `${(info.subrankEnd - value).toLocaleString('en-US')} to ${borderName(info)}`;
        }
        return out;
    }

    get mmrFillStyle() {
        const m = this.mmr;
        return m && m.hasBar ? `width: ${m.pct}%` : '';
    }

    // Max known calibration number — the API misses some calibration rows,
    // so counting rows underreports (5/8 when all 8 were played).
    get calibCount() {
        return this.rankedMatches.reduce(
            (max, m) => Math.max(max, m.ranked_calibration_match || 0),
            0
        );
    }

    // Shown while calibration is in flight: the newest match is a calibration
    // match, or its status is unknown (a GC row the API hasn't caught up with)
    // and completion isn't confirmed. Hidden once a real match is confirmed.
    get showCalibChip() {
        if (this.calibCount === 0) return false;
        const newest = this.rankedMatches[0];
        const c = newest && newest.ranked_calibration_match;
        return c === null || c === undefined || c > 0;
    }

    get shieldUsed() {
        const newest = this.rankedMatches[0];
        return !!(newest && newest.ranked_used_demotion_protection === true);
    }

    // Season record over scored ranked matches — replaces the old W/L dot
    // strip (the matches list below already shows every outcome).
    get seasonRecord() {
        let wins = 0;
        let losses = 0;
        for (const m of this.rankedMatches) {
            if (!isMatchScored(m)) continue;
            if (isMatchWon(m)) wins += 1;
            else losses += 1;
        }
        return { wins, losses };
    }

    // ---- MMR chart ----

    get chart() {
        // Prop is newest-first; the chart runs oldest → newest, left → right.
        // Y = post-match MMR (match-meta), which moves ~±350 a match — the
        // badge barely moves over a season, so it can't show the swings.
        const rows = [...this.rankedMatches].reverse();
        const n = rows.length;
        if (n === 0) return null;

        const mmrs = rows.map((m) => this.ownMmr(m));
        const firstKnownIdx = mmrs.findIndex((v) => v !== null);
        if (firstKnownIdx === -1) return null; // no MMR data anywhere — nothing to plot

        // Carry-forward: unknowns before the first known use the first known
        // value, later unknowns use the last known; unknowns render hollow.
        let lastKnown = null;
        const plotted = mmrs.map((v, i) => {
            const known = v !== null;
            if (known) lastKnown = v;
            return known ? v : i < firstKnownIdx ? mmrs[firstKnownIdx] : lastKnown;
        });

        // Zoom window: the MMR range reached, half a subrank (500 pts) of
        // padding, at least two subranks of span (a flat line still shows
        // its neighbors).
        const minV = Math.min(...plotted);
        const maxV = Math.max(...plotted);
        let yLo = minV - 500;
        let yHi = maxV + 500;
        if (yHi - yLo < 2000) {
            const mid = (minV + maxV) / 2;
            yLo = mid - 1000;
            yHi = mid + 1000;
        }
        const span = yHi - yLo;
        const plotW = CHART.w - CHART.padL - CHART.padR;
        const plotH = CHART.h - CHART.padT - CHART.padB;
        const yFor = (v) => CHART.padT + (1 - (v - yLo) / span) * plotH;

        const slot = plotW / n;
        const points = rows.map((m, i) => {
            const known = mmrs[i] !== null;
            const scored = isMatchScored(m);
            const won = scored && isMatchWon(m);
            return {
                i,
                known,
                x: CHART.padL + (i + 0.5) * slot,
                y: yFor(plotted[i]),
                cls:
                    'chart__dot ' +
                    (known ? '' : 'chart__dot--unknown ') +
                    (scored ? (won ? 'chart__dot--win' : 'chart__dot--loss') : 'chart__dot--muted'),
                tooltip: this.tooltipFor(m, mmrs[i], known, scored, won)
            };
        });

        // Gridline at every subrank boundary (subrank start) inside the
        // window; rank starts (subrank I) are bold. Label every line unless
        // the window is wide, in which case only the rank starts.
        const gridlines = [];
        for (let rank = 1; rank <= 10; rank++) {
            for (let sub = 1; sub <= 6; sub++) {
                const v = (rank - 1) * RANK_POINTS_PER_RANK + (sub - 1) * RANK_POINTS_PER_SUBRANK;
                if (v <= yLo || v >= yHi) continue;
                gridlines.push({
                    key: v,
                    rank,
                    sub,
                    y: yFor(v)
                });
            }
        }
        const labelAll = gridlines.length <= 8;
        gridlines.forEach((g) => {
            const labeled = labelAll || g.sub === 1;
            g.labelY = g.y + 3;
            g.label = labeled ? `${RANK_NAMES[g.rank]} ${ROMAN[g.sub]}` : '';
            g.cls = 'chart__grid' + (g.sub === 1 ? ' chart__grid--rank' : '');
            g.labelCls = 'chart__grid-label' + (g.sub === 1 ? ' chart__grid-label--rank' : '');
        });

        // Date labels at five even positions (first, quartiles, last),
        // deduped when the season is short.
        const xlabels = [];
        const seen = new Set();
        for (let i = 0; i < 5; i++) {
            const idx = Math.round((i * (n - 1)) / 4);
            if (seen.has(idx)) continue;
            seen.add(idx);
            const ts = rows[idx].start_time;
            if (!ts) continue;
            xlabels.push({ key: idx, x: points[idx].x, text: formatDate(ts) });
        }

        const plotRight = CHART.w - CHART.padR;
        return {
            viewBox: `0 0 ${CHART.w} ${CHART.h}`,
            padL: CHART.padL,
            plotRight,
            labelX: plotRight + 6,
            xLabelY: CHART.h - 6,
            dot: CHART.dot,
            points,
            polyline: points
                .map((p) => `${Math.round(p.x * 10) / 10},${Math.round(p.y * 10) / 10}`)
                .join(' '),
            gridlines,
            xlabels
        };
    }

    tooltipFor(m, mmr, known, scored, won) {
        const meta = this.heroMap.get(m.hero_id) || {};
        const badge = m.ranked_display_badge;
        const parts = [];
        if (m.start_time) parts.push(formatEt(m.start_time));
        parts.push(scored ? (won ? 'Win' : 'Loss') : 'Not scored');
        if (mmr !== null) parts.push(`${mmr.toLocaleString('en-US')} MMR`);
        if (badge !== null && badge !== undefined) parts.push(rankLabel(badge));
        if (m.ranked_delta !== null && m.ranked_delta !== undefined) {
            parts.push(`${deltaText(m.ranked_delta)} pts`);
        }
        parts.push(meta.name || `Hero ${m.hero_id}`);
        if (isCalibration(m)) {
            parts.push(`Calibration ${m.ranked_calibration_match}/${CALIBRATION_MATCHES}`);
        }
        if (!known) parts.push('MMR carried from nearby match');
        return parts.join(' · ');
    }

    // ---- Ranked hero table (current season, scored matches only) ----

    get heroRows() {
        const byHero = new Map();
        for (const m of this.rankedMatches) {
            if (!isMatchScored(m)) continue;
            let h = byHero.get(m.hero_id);
            if (!h) {
                h = {
                    hero_id: m.hero_id,
                    wins: 0,
                    losses: 0,
                    matches: 0,
                    kills: 0,
                    deaths: 0,
                    assists: 0
                };
                byHero.set(m.hero_id, h);
            }
            h.matches += 1;
            if (isMatchWon(m)) h.wins += 1;
            else h.losses += 1;
            h.kills += m.player_kills || 0;
            h.deaths += m.player_deaths || 0;
            h.assists += m.player_assists || 0;
        }
        return Array.from(byHero.values())
            .sort((a, b) => b.matches - a.matches || b.wins - a.wins)
            .map((h) => {
                const meta = this.heroMap.get(h.hero_id) || {};
                const images = meta.images || {};
                return {
                    heroId: h.hero_id,
                    name: meta.name || `Hero ${h.hero_id}`,
                    icon: images.icon_hero_card_webp || images.icon_hero_card || '',
                    record: `${h.wins}-${h.losses}`,
                    winRate: h.matches ? Math.round((h.wins / h.matches) * 100) : 0,
                    kda: `${h.kills} / ${h.deaths} / ${h.assists}`
                };
            });
    }

    // ---- Recent 5 ranked ----

    // Match ids the poller has metadata for (drains a few per run).
    get metaIds() {
        const meta = this.matchMeta;
        if (!meta || !meta.matches) return new Set();
        return new Set(
            this.rankedMatches
                .filter((m) => meta.matches[m.match_id])
                .map((m) => m.match_id)
        );
    }

    // Every ranked match of the season, newest first — the scrollable list
    // below the chart. Rows with metadata are selectable for the Match MMR
    // section.
    get seasonMatches() {
        const metaIds = this.metaIds;
        const selectedId = this.matchMmr && this.matchMmr.selectedId;
        return this.rankedMatches.map((m) => {
            const meta = this.heroMap.get(m.hero_id) || {};
            const images = meta.images || {};
            const scored = isMatchScored(m);
            const won = scored && isMatchWon(m);
            const hasMeta = metaIds.has(m.match_id);
            return {
                key: m.match_id,
                name: meta.name || `Hero ${m.hero_id}`,
                icon: images.icon_hero_card_webp || images.icon_hero_card || '',
                when: m.start_time ? formatEt(m.start_time) : '',
                label: scored ? (won ? 'W' : 'L') : 'N/S',
                badgeClass:
                    'ranked-recent__badge ' +
                    (scored
                        ? won
                            ? 'ranked-recent__badge--win'
                            : 'ranked-recent__badge--loss'
                        : 'ranked-recent__badge--muted'),
                delta: isCalibration(m)
                    ? `Calibration ${m.ranked_calibration_match}/${CALIBRATION_MATCHES}`
                    : deltaText(m.ranked_delta),
                itemClass:
                    'ranked-recent__item' +
                    (hasMeta ? ' ranked-recent__item--selectable' : '') +
                    (m.match_id === selectedId
                        ? ' ranked-recent__item--selected'
                        : '')
            };
        });
    }

    handleRecentSelect(e) {
        this.selectedMatchId = Number(e.currentTarget.dataset.id);
    }

    // ---- Match MMR (per-match metadata, own account only) ----

    // The selected match's post-match view. null = nothing to show (no
    // metadata at all, e.g. dev mode); hasEntry false = a row was picked
    // whose metadata the poller hasn't fetched yet.
    get matchMmr() {
        const meta = this.matchMeta;
        if (!meta || !meta.matches || this.rankedMatches.length === 0) return null;
        const withMeta = this.rankedMatches.filter((m) => meta.matches[m.match_id]);
        if (withMeta.length === 0) return null;
        const sel =
            this.rankedMatches.find((m) => m.match_id === this.selectedMatchId) ||
            withMeta[0];
        const entry = meta.matches[sel.match_id] || null;
        return {
            selectedId: sel.match_id,
            hasEntry: !!entry,
            ...this.buildMatchMmr(sel, entry)
        };
    }

    buildMatchMmr(m, entry) {
        const scored = isMatchScored(m);
        const won = scored && isMatchWon(m);
        const out = {
            outcomeLabel: scored ? (won ? 'W' : 'L') : 'N/S',
            outcomeClass:
                'match-mmr__outcome ' +
                (scored
                    ? won
                        ? 'match-mmr__outcome--win'
                        : 'match-mmr__outcome--loss'
                    : 'match-mmr__outcome--muted'),
            when: m.start_time ? formatEt(m.start_time) : '',
            ownHeroName: '',
            ownHeroIcon: '',
            ownKda: '',
            calibLabel: '',
            team0: [],
            team1: [],
            team0Name: TEAM_FRACTIONS[0] || 'Team 0',
            team1Name: TEAM_FRACTIONS[1] || 'Team 1',
            team0Avg: '',
            team1Avg: '',
            ladder: null,
            badgeShift: '',
            pointsText: '',
            note: ''
        };
        if (!entry) return out;

        const own =
            entry.players.find((p) => p.account_id === LOCAL_ACCOUNT_ID) || null;
        if (own) {
            const h = this.heroMap.get(own.hero_id) || {};
            const images = h.images || {};
            out.ownHeroName = h.name || `Hero ${own.hero_id}`;
            out.ownHeroIcon = images.icon_hero_card_webp || images.icon_hero_card || '';
            out.ownKda = `${own.kills} / ${own.deaths} / ${own.assists}`;
        }

        // Team average = mean post-match MMR over players whose rank is
        // revealed (initial_display_rank > 0). Mid-calibration players
        // (cal 1–7) have no real MMR yet — their progress values are
        // placeholders — so they only count in the denominator gap.
        const teamAvg = (team) => {
            const players = entry.players.filter((p) => p.team === team);
            const vals = players
                .filter(
                    (p) =>
                        p.rank &&
                        (p.rank.initial_display_rank || 0) > 0 &&
                        p.rank.final_flat_progress !== null &&
                        p.rank.final_flat_progress !== undefined
                )
                .map((p) => p.rank.final_flat_progress);
            if (vals.length === 0) return '';
            const avg = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
            return `avg ${avg.toLocaleString('en-US')} (${vals.length}/${players.length})`;
        };
        out.team0Avg = teamAvg(0);
        out.team1Avg = teamAvg(1);

        const rowsFor = (team) =>
            entry.players
                .filter((p) => p.team === team)
                .sort((a, b) => a.player_slot - b.player_slot)
                .map((p) => this.buildPlayerRow(p));
        out.team0 = rowsFor(0);
        out.team1 = rowsFor(1);

        const r = own && own.rank;
        // Calibration: the history row's per-season number is authoritative;
        // meta's initial_calibration_games is the REMAINING count incl. this
        // match (8 on the first calib match → 1 on the last, 0 on real ones).
        const isCalib =
            (m.ranked_calibration_match || 0) > 0 ||
            (!r || r.initial_display_rank === 0);
        if (isCalib) {
            const n =
                m.ranked_calibration_match ||
                (r && r.initial_calibration_games
                    ? CALIBRATION_MATCHES - r.initial_calibration_games + 1
                    : 0);
            out.calibLabel = `Calibration ${n}/${CALIBRATION_MATCHES}`;
            if (r) {
                out.pointsText = `${deltaText(
                    (r.final_flat_progress || 0) - (r.initial_flat_progress || 0)
                )} pts`;
            }
            return out;
        }
        if (!r) return out;

        const before = r.initial_flat_progress || 0;
        const after = r.final_flat_progress || 0;
        const applied = after - before;
        out.pointsText = `${before} → ${after} pts (${deltaText(applied)})`;

        const beforeBadge = decodeBadge(r.initial_display_rank);
        const afterBadge =
            m.ranked_display_badge !== null && m.ranked_display_badge !== undefined
                ? decodeBadge(m.ranked_display_badge)
                : null;
        if (afterBadge) {
            out.badgeShift = `${beforeBadge.name} ${beforeBadge.numeral} → ${afterBadge.name} ${afterBadge.numeral}`;
        }
        if (r.consumed_demotion_protection === true) {
            out.note = 'demotion protection applied — loss clamped at subrank border';
        }
        out.ladder = buildLadder(before, after);
        return out;
    }

    buildPlayerRow(p) {
        const h = this.heroMap.get(p.hero_id) || {};
        const images = h.images || {};
        const row = {
            key: `${p.team}-${p.player_slot}`,
            icon: images.icon_hero_card_webp || images.icon_hero_card || '',
            rowClass:
                'match-mmr__row' +
                (p.account_id === LOCAL_ACCOUNT_ID ? ' match-mmr__row--own' : ''),
            badgeIcon: '',
            badgeNumeral: '',
            badgeText: '—',
            mmrText: '—',
            deltaText: '',
            deltaClass: 'match-mmr__delta match-mmr__delta--flat',
            deltaTitle: '',
            shield: false
        };
        const r = p.rank;
        if (!r) return row;
        const badge = decodeBadge(r.initial_display_rank);
        if (badge.rank > 0) {
            row.badgeIcon = badge.icon;
            row.badgeNumeral = badge.numeral;
        } else {
            // Obscurus = mid-calibration. initial_calibration_games is the
            // REMAINING count incl. this match (8 → 1), so this match is
            // cal #8-count+1; 0 with no revealed rank = unrated.
            const cal = r.initial_calibration_games || 0;
            row.badgeText =
                cal > 0
                    ? `Cal ${CALIBRATION_MATCHES - cal + 1}/${CALIBRATION_MATCHES}`
                    : 'Obscurus';
        }
        const before = r.initial_flat_progress || 0;
        const after = r.final_flat_progress || 0;
        const applied = after - before;
        row.mmrText = `${before} → ${after}`;
        row.deltaText = deltaText(applied);
        row.deltaClass =
            'match-mmr__delta ' +
            (applied > 0
                ? 'match-mmr__delta--up'
                : applied < 0
                    ? 'match-mmr__delta--down'
                    : 'match-mmr__delta--flat');
        if (
            r.desired_progress_change !== null &&
            r.desired_progress_change !== undefined &&
            r.desired_progress_change !== applied
        ) {
            row.deltaTitle = `Wanted ${deltaText(r.desired_progress_change)}`;
        }
        row.shield = r.consumed_demotion_protection === true;
        return row;
    }
}
