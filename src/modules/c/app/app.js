import { LightningElement, track } from 'lwc';
import PlayerSearch from 'c/playerSearch';
import HeroStats from 'c/heroStats';
import { getHeroes, getPlayerHeroStats } from '../../../../services/deadlockApi.js';
import {
    RANKED_TOTAL_WINS,
    RANKED_HEROES_NEEDED,
    RANKED_HERO_WINS
} from '../../../../services/constants.js';
import { OUTCOME, isMatchWon, isMatchScored } from '../../../../services/outcomes.js';

const STORAGE_KEY = 'deadlock.player';
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

export default class App extends LightningElement {
    @track player = null;
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

    heroMap = new Map();

    // Monotonic id for in-flight loads; lets a stale response (e.g. a refresh
    // for the previous player) discard itself instead of overwriting newer state.
    loadSeq = 0;

    get showSearch() {
        return !this.player;
    }

    get showContent() {
        return !!this.player;
    }

    get isEligible() {
        if (!this.stats) return false;
        return this.stats.totalWins >= RANKED_TOTAL_WINS && this.stats.eligibleCount >= RANKED_HEROES_NEEDED;
    }

    get eligibilityRule() {
        return `${RANKED_TOTAL_WINS} total Standard wins + ${RANKED_HEROES_NEEDED} heroes with ${RANKED_HERO_WINS}+ wins`;
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

    async handleConfirm(event) {
        this.player = event.detail;
        this.stats = null;
        this.error = null;
        this.persist();
        await this.loadData(true);
    }

    handleSwitch() {
        this.loadSeq += 1; // invalidate any in-flight load
        this.player = null;
        this.stats = null;
        this.recentMatches = [];
        this.error = null;
        this.loading = false;
        this.refreshing = false;
        this.lastUpdated = null;
        this.clearPersist();
    }

    handleRefresh() {
        this.loadData(false);
    }

    persist() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this.player));
        } catch {
            /* ignore */
        }
    }

    clearPersist() {
        try {
            localStorage.removeItem(STORAGE_KEY);
        } catch {
            /* ignore */
        }
    }

    readPersist() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    }

    connectedCallback() {
        const saved = this.readPersist();
        if (saved && saved.accountId) {
            this.player = saved;
            this.loadData(true);
        }
    }

    async loadData(isInitial) {
        const seq = ++this.loadSeq;
        this.error = null;
        if (isInitial) this.loading = true;
        else this.refreshing = true;
        try {
            if (!this.heroMap.size) {
                // Hero metadata is player-independent, so cache it even if this
                // load is superseded before the fetch resolves.
                const heroes = await getHeroes();
                this.heroMap = new Map(heroes.map((h) => [h.id, h]));
            }
            const {
                stats: heroStats,
                recentMatches,
                fresh,
                rateLimited,
                source,
                localUpdated: localFileUpdated,
            } = await getPlayerHeroStats(this.player.accountId, {
                isScored: isMatchScored,
                isWon: isMatchWon
            });
            if (seq !== this.loadSeq) return; // superseded (switch/refresh) — drop stale data
            this.stats = this.computeStats(heroStats);
            this.recentMatches = this.computeRecentMatches(recentMatches);
            this.dataFresh = fresh;
            this.rateLimited = rateLimited;
            this.dataSource = source;
            this.localFileUpdated = localFileUpdated;
            this.lastUpdated = new Date().toLocaleString();
        } catch (e) {
            if (seq !== this.loadSeq) return;
            this.error = (e && e.message) || 'Failed to load stats';
            this.stats = null;
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
                const eligible = wins >= RANKED_HERO_WINS;
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
                    winRate: matches ? Math.round((wins / matches) * 100) : 0,
                    eligible,
                    rowClass: 'hero-row' + (eligible ? ' hero-row--eligible' : ''),
                    fillStyle: `width: ${Math.min(100, Math.round((wins / RANKED_HERO_WINS) * 100))}%`,
                };
            })
            .sort((a, b) => b.wins - a.wins || b.matches - a.matches);

        const totalWins = heroStats.reduce((s, h) => s + (h.wins || 0), 0);
        const totalMatches = heroStats.reduce((s, h) => s + (h.matches_played || 0), 0);
        const eligibleCount = rows.filter((r) => r.eligible).length;
        return { rows, totalWins, totalMatches, eligibleCount, empty: totalMatches === 0 };
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
