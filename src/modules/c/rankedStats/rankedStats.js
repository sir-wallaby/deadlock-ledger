import { LightningElement, api } from 'lwc';
import {
    CALIBRATION_MATCHES,
    RANK_NAMES,
    decodeBadge
} from '../../../../services/constants.js';
import { isMatchScored, isMatchWon } from '../../../../services/outcomes.js';

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

export default class RankedStats extends LightningElement {
    // Raw ranked rows for the current season, newest first (from
    // getPlayerHeroStats). heroMap: hero_id -> hero metadata. localRanked:
    // { rank, heroMmr } from the GC poller, own account only (null otherwise).
    @api rankedMatches = [];
    @api heroMap = new Map();
    @api localRanked = null;

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

    get recent() {
        return this.rankedMatches.slice(0, 5).map((m) => {
            const meta = this.heroMap.get(m.hero_id) || {};
            const images = meta.images || {};
            const scored = isMatchScored(m);
            const won = scored && isMatchWon(m);
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
                    : deltaText(m.ranked_delta)
            };
        });
    }
}
