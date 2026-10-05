import { LightningElement, track } from 'lwc';
import {
    classifyInput,
    steamId64ToAccountId,
    accountIdToSteamId64,
} from '../../../../services/steam.js';
import { getSteamProfile, steamSearch } from '../../../../services/deadlockApi.js';

function normalizeProfile(p) {
    return {
        accountId: p.account_id,
        personaname: p.personaname || '',
        avatar: p.avatar || '',
        avatarfull: p.avatarfull || '',
        profileurl: p.profileurl || '',
    };
}

export default class PlayerSearch extends LightningElement {
    @track query = '';
    @track results = [];
    @track selected = null;
    searching = false;
    error = null;

    get showHint() {
        return !this.searching && !this.error && !this.results.length && !this.selected;
    }

    get showResults() {
        return !this.searching && this.results.length > 0 && !this.selected;
    }

    get showConfirm() {
        return !!this.selected;
    }

    get selectedInitials() {
        const name = (this.selected && this.selected.personaname) || '?';
        return name.slice(0, 2).toUpperCase();
    }

    onQueryChange(event) {
        this.query = event.detail.value;
    }

    async onFind() {
        const cls = classifyInput(this.query);
        if (cls.kind === 'empty') {
            this.error = 'Enter a Steam username, SteamID64, or account ID.';
            return;
        }
        this.error = null;
        this.results = [];
        this.selected = null;
        this.searching = true;
        try {
            if (cls.kind === 'steamId64') {
                await this.resolveAccountId(steamId64ToAccountId(cls.steamId64));
            } else if (cls.kind === 'accountId') {
                await this.resolveAccountId(cls.accountId);
            } else {
                const found = await steamSearch(cls.username);
                if (!found || found.length === 0) {
                    this.error = `No Steam profiles found for "${cls.username}".`;
                } else {
                    this.results = found.map(normalizeProfile);
                }
            }
        } catch (e) {
            this.error = (e && e.message) || 'Search failed';
        } finally {
            this.searching = false;
        }
    }

    async resolveAccountId(accountId) {
        const profiles = await getSteamProfile(accountId);
        if (!profiles || profiles.length === 0) {
            this.error = `No Steam profile found for account_id ${accountId}.`;
            return;
        }
        this.selected = normalizeProfile(profiles[0]);
    }

    onSelect(event) {
        const idx = Number(event.currentTarget.dataset.index);
        const profile = this.results[idx];
        if (profile) this.selected = profile;
    }

    onBack() {
        this.selected = null;
    }

    onConfirm() {
        if (!this.selected) return;
        const p = this.selected;
        const player = {
            accountId: p.accountId,
            steamId64: accountIdToSteamId64(p.accountId),
            personaname: p.personaname,
            avatar: p.avatarfull || p.avatar,
        };
        this.dispatchEvent(new CustomEvent('confirm', { detail: player }));
    }
}
