import { LightningElement, api } from 'lwc';

const RANKED_TOTAL = 60;

export default class HeroStats extends LightningElement {
    @api stats;
    @api isEligible = false;

    // Empty means no Standard matches at all. A player with matches but zero
    // wins still gets the summary (0/60) and an empty table — the rows list
    // only shows heroes with at least one win.
    get empty() {
        return !this.stats || this.stats.empty;
    }

    get totalWins() {
        return this.stats ? this.stats.totalWins : 0;
    }

    get eligibleCount() {
        return this.stats ? this.stats.eligibleCount : 0;
    }

    get totalMatches() {
        return this.stats ? this.stats.totalMatches : 0;
    }

    get rows() {
        return this.stats ? this.stats.rows : [];
    }

    get totalWinsPct() {
        return Math.min(100, Math.round((this.totalWins / RANKED_TOTAL) * 100));
    }

    get statusVariant() {
        return this.isEligible ? 'success' : 'warning';
    }

    get statusLabel() {
        return this.isEligible ? 'RANKED ELIGIBLE' : 'NOT YET ELIGIBLE';
    }
}
