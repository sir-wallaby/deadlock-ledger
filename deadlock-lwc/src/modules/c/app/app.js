import { LightningElement, track } from 'lwc';
import HeroStats from 'c/heroStats';
import RankedStats from 'c/rankedStats';
import {
    LOCAL_ACCOUNT_ID,
    getPlayerHeroStats,
    getLocalMatchMeta
} from '../../../../services/deadlockApi.js';
import heroes from '../../../../services/heroes.js';
import { SEASONS } from '../../../../services/constants.js';
import { isMatchWon, isMatchScored } from '../../../../services/outcomes.js';

// Single-account dashboard: the GC poller serves this account's data, so the
// app is pinned to it (no search, no player persistence).
const OWN_PLAYER = { accountId: LOCAL_ACCOUNT_ID, personaname: 'Wallaby32' };

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
    avatarUrl = '';
    @track stats = null;
    loading = false;
    refreshing = false;
    error = null;
    lastUpdated = null;
    dataFresh = true;
    rateLimited = false;
    dataSource = 'api';
    localFileUpdated = null;
    @track rankedMatches = [];
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

    handleRefresh() {
        this.loadData(false);
    }

    connectedCallback() {
        this.loadAvatar();
        this.loadData(true);
    }

    // The poller publishes the account's Steam avatar at /data/avatar.jpg
    // (scraped from the Steam profile page — the browser can't fetch it
    // itself: steamcommunity.com sends no CORS headers). Preload it and
    // set src only on success, so lightning-avatar falls back to the
    // initials when the file is absent (npm run dev) or the fetch fails.
    loadAvatar() {
        const img = new Image();
        img.onload = () => {
            this.avatarUrl = img.src;
        };
        img.src = '/data/avatar.jpg';
    }

    async loadData(isInitial) {
        const seq = ++this.loadSeq;
        this.error = null;
        if (isInitial) this.loading = true;
        else this.refreshing = true;
        try {
            // Per-match metadata is own-account only and 404-tolerant; it
            // degrades to null (no MMR bar / Match MMR section) rather than
            // failing the load, so it runs alongside the stats fetch.
            const [result, matchMeta] = await Promise.all([
                getPlayerHeroStats(this.player.accountId, {
                    isScored: isMatchScored,
                    isWon: isMatchWon
                }),
                getLocalMatchMeta(this.player.accountId)
            ]);
            if (seq !== this.loadSeq) return; // superseded by a refresh — drop stale data
            this.stats = this.computeStats(result.stats);
            this.rankedMatches = result.rankedMatches || [];
            this.matchMeta = matchMeta;
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
            this.matchMeta = null;
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
}
