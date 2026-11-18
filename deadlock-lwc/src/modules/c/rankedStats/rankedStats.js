import { LightningElement, api, track } from 'lwc';
import {
    CALIBRATION_MATCHES,
    RANK_NAMES,
    ROMAN,
    RANK_POINTS_PER_RANK,
    RANK_POINTS_PER_SUBRANK,
    ETERNUS_POINTS,
    decodeBadge,
    rankForPoints
} from '../../../../services/constants.js';
import { isMatchScored, isMatchWon } from '../../../../services/outcomes.js';
import { LOCAL_ACCOUNT_ID } from '../../../../services/deadlockApi.js';

// SVG geometry (viewBox units); the right padding holds the rank-name labels.
const CHART = { w: 600, h: 170, padL: 10, padR: 76, padT: 22, padB: 14, dot: 4.5 };

const ET_FORMATTER = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
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

function isCalibration(m) {
    return m.ranked_calibration_match > 0;
}

function deltaText(delta) {
    if (delta === null || delta === undefined) return '—';
    if (delta > 0) return `+${delta}`;
    return delta === 0 ? '0' : `−${Math.abs(delta)}`;
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
    // getPlayerHeroStats). heroMap: hero_id -> hero metadata. localRanked:
    // { rank, heroMmr } from the GC poller, own account only (null otherwise).
    // matchMeta: the poller's match-meta.json ({ matches: { id: entry } }),
    // own account only (null otherwise / under dev).
    @api rankedMatches = [];
    @api heroMap = new Map();
    @api localRanked = null;
    @api matchMeta = null;

    // The recent-list row the user selected for the Match MMR section. null =
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
        return r.numeral ? `${r.name} ${r.numeral}` : r.name;
    }

    // Points bar from the SO cache — own account only.
    get points() {
        const rank = this.localRanked && this.localRanked.rank;
        if (!rank || rank.progress === null || rank.progress === undefined) return null;
        const max = rank.max_progress || 0;
        return {
            value: rank.progress,
            max,
            pct: max ? Math.min(100, Math.round((rank.progress / max) * 100)) : 0
        };
    }

    get pointsFillStyle() {
        const p = this.points;
        return p ? `width: ${p.pct}%` : '';
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

    // Last 8 outcomes, most recent left.
    get form() {
        return this.rankedMatches.slice(0, 8).map((m, i) => {
            const scored = isMatchScored(m);
            const won = scored && isMatchWon(m);
            return {
                i,
                label: scored ? (won ? 'W' : 'L') : '–',
                cls:
                    'form__dot' + (scored ? (won ? ' form__dot--win' : ' form__dot--loss') : '')
            };
        });
    }

    // ---- Badge chart ----

    get chart() {
        // Prop is newest-first; the chart runs oldest → newest, left → right.
        const rows = [...this.rankedMatches].reverse();
        const n = rows.length;
        if (n === 0) return null;

        const badges = rows.map((m) => {
            const b = m.ranked_display_badge;
            return b === null || b === undefined ? null : b;
        });
        const firstKnownIdx = badges.findIndex((b) => b !== null);
        if (firstKnownIdx === -1) return null; // no badge info anywhere — nothing to plot

        // Carry-forward: unknowns before the first known use the first known
        // badge, later unknowns use the last known; unknowns render hollow.
        let lastKnown = null;
        const points = rows.map((m, i) => {
            const known = badges[i] !== null;
            if (known) lastKnown = badges[i];
            const badge = known ? badges[i] : i < firstKnownIdx ? badges[firstKnownIdx] : lastKnown;
            const scored = isMatchScored(m);
            const won = scored && isMatchWon(m);
            return {
                i,
                badge,
                known,
                x: 0,
                y: 0,
                cls:
                    'chart__dot ' +
                    (known ? '' : 'chart__dot--unknown ') +
                    (scored ? (won ? 'chart__dot--win' : 'chart__dot--loss') : 'chart__dot--muted'),
                tooltip: this.tooltipFor(m, badge, known, scored, won)
            };
        });

        const maxBadge = Math.max(...badges.filter((b) => b !== null));
        const maxY = Math.max(20, Math.ceil(maxBadge / 10) * 10);
        const plotW = CHART.w - CHART.padL - CHART.padR;
        const plotH = CHART.h - CHART.padT - CHART.padB;
        const slot = plotW / n;
        points.forEach((p, i) => {
            p.x = CHART.padL + (i + 0.5) * slot;
            p.y = CHART.padT + (1 - p.badge / maxY) * plotH;
        });

        // Calibration band over the leading stretch of calibration matches.
        let calibIdx = -1;
        rows.forEach((m, i) => {
            if (isCalibration(m)) calibIdx = i;
        });
        const calibBand = calibIdx >= 0 ? { x: CHART.padL, w: (calibIdx + 1) * slot } : null;

        // Gridlines at rank boundaries; the label is the rank that starts
        // just above the line (badge r*10+1..r*10+6 is rank r).
        const gridlines = [];
        for (let g = 10; g <= maxY; g += 10) {
            gridlines.push({
                key: g,
                y: CHART.padT + (1 - g / maxY) * plotH,
                labelY: CHART.padT + (1 - g / maxY) * plotH + 3,
                label: RANK_NAMES[g / 10] || ''
            });
        }

        const plotRight = CHART.w - CHART.padR;
        return {
            viewBox: `0 0 ${CHART.w} ${CHART.h}`,
            padL: CHART.padL,
            padT: CHART.padT,
            plotH,
            plotRight,
            labelX: plotRight + 6,
            calibLabelY: 14,
            dot: CHART.dot,
            points,
            polyline: points
                .map((p) => `${Math.round(p.x * 10) / 10},${Math.round(p.y * 10) / 10}`)
                .join(' '),
            gridlines,
            calibBand
        };
    }

    tooltipFor(m, badge, known, scored, won) {
        const meta = this.heroMap.get(m.hero_id) || {};
        const r = decodeBadge(badge);
        const parts = [];
        if (m.start_time) parts.push(formatEt(m.start_time));
        parts.push(scored ? (won ? 'Win' : 'Loss') : 'Not scored');
        parts.push(r.numeral ? `${r.name} ${r.numeral}` : r.name);
        if (m.ranked_delta !== null && m.ranked_delta !== undefined) {
            parts.push(`${deltaText(m.ranked_delta)} pts`);
        }
        parts.push(meta.name || `Hero ${m.hero_id}`);
        if (isCalibration(m)) {
            parts.push(`Calibration ${m.ranked_calibration_match}/${CALIBRATION_MATCHES}`);
        }
        if (!known) parts.push('rank carried from nearby match');
        return parts.join(' · ');
    }

    // ---- Hero MMR strip (own account only) ----

    get showMmr() {
        return this.mmrHeroes.length > 0;
    }

    get mmrHeroes() {
        const mmr = this.localRanked && this.localRanked.heroMmr;
        if (!mmr || !Array.isArray(mmr.heroes)) return [];
        // -10 = unplayed default; only heroes actually played in ranked show.
        return mmr.heroes
            .filter((h) => h.relative_mmr > -10)
            .sort((a, b) => b.relative_mmr - a.relative_mmr)
            .map((h) => {
                const meta = this.heroMap.get(h.hero_id) || {};
                const images = meta.images || {};
                const v = h.relative_mmr;
                return {
                    id: h.hero_id,
                    name: meta.name || `Hero ${h.hero_id}`,
                    icon: images.icon_hero_card_webp || images.icon_hero_card || '',
                    value: v > 0 ? `+${v}` : `${v}`,
                    cls:
                        'mmr__value' +
                        (v > 0 ? ' mmr__value--up' : v < 0 ? ' mmr__value--down' : '')
                };
            });
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

    get recent() {
        const metaIds = this.metaIds;
        const selectedId = this.matchMmr && this.matchMmr.selectedId;
        return this.rankedMatches.slice(0, 5).map((m) => {
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

        const rowsFor = (team) =>
            entry.players
                .filter((p) => p.team === team)
                .sort((a, b) => a.player_slot - b.player_slot)
                .map((p) => this.buildPlayerRow(p));
        out.team0 = rowsFor(0);
        out.team1 = rowsFor(1);

        const r = own && own.rank;
        // Calibration: the history row's per-season number is authoritative;
        // meta's initial_calibration_games is the pre-match count (+1 = this).
        const isCalib =
            (m.ranked_calibration_match || 0) > 0 ||
            (!r || r.initial_display_rank === 0);
        if (isCalib) {
            const n =
                m.ranked_calibration_match ||
                (r && r.initial_calibration_games
                    ? r.initial_calibration_games + 1
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
            // pre-match count, so this match is cal #count+1.
            const cal = r.initial_calibration_games || 0;
            row.badgeText =
                cal < CALIBRATION_MATCHES
                    ? `Cal ${Math.min(CALIBRATION_MATCHES, cal + 1)}/${CALIBRATION_MATCHES}`
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
