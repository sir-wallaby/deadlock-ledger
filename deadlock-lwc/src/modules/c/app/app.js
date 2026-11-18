import { LightningElement, track } from 'lwc';
import HeroStats from 'c/heroStats';
import RankedStats from 'c/rankedStats';
import {
    LOCAL_ACCOUNT_ID,
    getPlayerHeroStats,
    getLocalRankedData,
    getLocalMatchMeta
} from '../../../../services/deadlockApi.js';
import heroes from '../../../../services/heroes.js';
import { SEASONS } from '../../../../services/constants.js';
import { OUTCOME, isMatchWon, isMatchScored } from '../../../../services/outcomes.js';

// Single-account dashboard: the GC poller serves this account's data, so the
// app is pinned to it (no search, no player persistence).
const OWN_PLAYER = { accountId: LOCAL_ACCOUNT_ID, personaname: 'Wallaby32' };
const ET_TIME_ZONE = 'America/New_York';

function matchOutcomeLabel(m) {
    const o = m.player_match_outcome;
    if (o === OUTCOME.PENALIZED || o === OUTCOME.PENALIZED_PARTY) return 'ABANDON';
    if (o === OUTCOME.NOT_SCORED) return 'N/S';
    return isMatchWon(m) ? 'W' : 'L';
}

function gameModeLabel(mode) {
    switch (mode) {
        case 2: return '1v1 Test';
        case 3: return 'Sandbox';
        case 4: return 'Street Brawl';
        case 5: return 'Explore NYC';
        case 6: return 'Internal';
        default: return 'Standard';
    }
}

function matchModeLabel(mode) {
    switch (mode) {
        case 1: return 'Unranked';
        case 2: return 'Private Lobby';
        case 3: return 'Co-op Bot';
        case 4: return 'Ranked';
        case 5: return 'Server Test';
        case 6: return 'Tutorial';
        case 7: return 'Hero Labs';
        case 8: return 'Placement';
        default: return '';
    }
}

// Formats a Unix timestamp (seconds) as a wall-clock date/time in Eastern time.
// The IANA zone handles the EDT/EST daylight-saving switch automatically.
// The formatter is built once — Intl.DateTimeFormat construction is not free.
const ET_FORMATTER = new Intl.DateTimeFormat('en-US', {
    timeZone: ET_TIME_ZONE,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
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

// Season boundaries are UTC instants; the date alone is what gets shown.
const UTC_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
});

function formatUtcDate(ms) {
    try {
        return UTC_DATE_FORMATTER.format(new Date(ms));
    } catch {
        return '';
    }
}

export default class App extends LightningElement {
    // Set at construction (not in connectedCallback) so the template can
    // reference player.* unconditionally on the very first render.
    @track player = OWN_PLAYER;
    @track stats = null;
    loading = false;
    refreshing = false;
    error = null;
    lastUpdated = null;
    dataFresh = true;
    rateLimited = false;
    dataSource = 'api';
    localFileUpdated = null;
    @track recentMatches = [];
    @track rankedMatches = [];
    @track localRanked = null;
    @track matchMeta = null;

    // Static: hero metadata is player-independent and a local snapshot now.
    heroMap = new Map(heroes.map((h) => [h.id, h]));

    // Monotonic id for in-flight loads; lets a stale refresh discard itself
    // instead of overwriting newer state.
    loadSeq = 0;

    get seasonLine() {
        const season = SEASONS[SEASONS.length - 1];
        return `${season.name} · ends ${formatUtcDate(season.end)}`;
    }

    get showRanked() {
        return Array.isArray(this.rankedMatches) && this.rankedMatches.length > 0;
    }

    get playerInitials() {
        const name = (this.player && this.player.personaname) || '?';
        return name.slice(0, 2).toUpperCase();
    }

    get displayName() {
        return (this.player && this.player.personaname) || 'Unknown player';
    }

    get showStaleBanner() {
        return !this.loading && !this.error && !!this.stats && !this.dataFresh;
    }

    get staleMessage() {
        if (this.rateLimited) {
            return 'Hourly API rate limit reached — showing the last stored data, which may be missing recent matches.';
        }
        if (this.dataSource === 'local') {
            const when = this.localFileUpdated
                ? new Date(this.localFileUpdated).toLocaleString()
                : 'an unknown time';
            return `Local match-history file last updated ${when} — the background updater may not be running, so recent matches may be missing.`;
        }
        return 'Showing the last stored snapshot. Live updates only apply to accounts the API is connected to, so recent matches may be missing.';
    }

    get showRecentMatches() {
        return Array.isArray(this.recentMatches) && this.recentMatches.length > 0;
    }

    handleRefresh() {
        this.loadData(false);
    }

    connectedCallback() {
        this.loadData(true);
    }

    async loadData(isInitial) {
        const seq = ++this.loadSeq;
        this.error = null;
        if (isInitial) this.loading = true;
        else this.refreshing = true;
        try {
            // Local ranked state + per-match metadata are own-account only and
            // 404-tolerant; they degrade to null (no points bar / MMR strip /
            // Match MMR section) rather than failing the load, so they run
            // alongside the stats fetch.
            const [result, localRanked, matchMeta] = await Promise.all([
                getPlayerHeroStats(this.player.accountId, {
                    isScored: isMatchScored,
                    isWon: isMatchWon
                }),
                getLocalRankedData(this.player.accountId),
                getLocalMatchMeta(this.player.accountId)
            ]);
            if (seq !== this.loadSeq) return; // superseded by a refresh — drop stale data
            this.stats = this.computeStats(result.stats);
            this.rankedMatches = result.rankedMatches || [];
            this.localRanked = localRanked;
            this.matchMeta = matchMeta;
            this.recentMatches = this.computeRecentMatches(result.recentMatches);
            this.dataFresh = result.fresh;
            this.rateLimited = result.rateLimited;
            this.dataSource = result.source;
            this.localFileUpdated = result.localUpdated;
            this.lastUpdated = new Date().toLocaleString();
        } catch (e) {
            if (seq !== this.loadSeq) return;
            this.error = (e && e.message) || 'Failed to load stats';
            this.stats = null;
            this.rankedMatches = [];
            this.localRanked = null;
            this.matchMeta = null;
            this.recentMatches = [];
            this.dataFresh = true;
            this.rateLimited = false;
            this.dataSource = 'api';
            this.localFileUpdated = null;
        } finally {
            if (seq === this.loadSeq) {
                this.loading = false;
                this.refreshing = false;
            }
        }
    }

    computeStats(heroStats) {
        const rows = heroStats
            .filter((h) => (h.wins || 0) >= 1)
            .map((h) => {
                const meta = this.heroMap.get(h.hero_id) || {};
                const images = meta.images || {};
                const wins = h.wins || 0;
                const matches = h.matches_played || 0;
                return {
                    heroId: h.hero_id,
                    name: meta.name || `Hero ${h.hero_id}`,
                    heroType: meta.hero_type || '',
                    icon: images.icon_hero_card_webp || images.icon_hero_card || '',
                    wins,
                    matches,
                    kills: h.kills || 0,
                    deaths: h.deaths || 0,
                    assists: h.assists || 0,
                    winRate: matches ? Math.round((wins / matches) * 100) : 0
                };
            })
            .sort((a, b) => b.wins - a.wins || b.matches - a.matches);

        const totalWins = heroStats.reduce((s, h) => s + (h.wins || 0), 0);
        const totalMatches = heroStats.reduce((s, h) => s + (h.matches_played || 0), 0);
        return {
            rows,
            totalWins,
            totalMatches,
            winRate: totalMatches ? Math.round((totalWins / totalMatches) * 100) : 0,
            empty: totalMatches === 0
        };
    }

    computeRecentMatches(rawMatches) {
        return (rawMatches || []).map((m) => {
            const meta = this.heroMap.get(m.hero_id) || {};
            const images = meta.images || {};
            const won = isMatchWon(m);
            const scored = isMatchScored(m);
            const gm = gameModeLabel(m.game_mode);
            const mm = matchModeLabel(m.match_mode);
            let badgeClass = 'recent__badge recent__badge--muted';
            if (scored) badgeClass = 'recent__badge ' + (won ? 'recent__badge--win' : 'recent__badge--loss');
            return {
                key: m.match_id,
                name: meta.name || `Hero ${m.hero_id}`,
                icon: images.icon_hero_card_webp || images.icon_hero_card || '',
                when: m.start_time ? formatEt(m.start_time) : '',
                modeText: mm ? `${gm} · ${mm}` : gm,
                label: matchOutcomeLabel(m),
                badgeClass
            };
        });
    }
}
