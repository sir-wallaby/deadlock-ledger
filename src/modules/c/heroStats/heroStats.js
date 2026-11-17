import { LightningElement, api } from 'lwc';

export default class HeroStats extends LightningElement {
    @api stats;

    // Empty means no Standard matches at all. A player with matches but zero
    // wins still gets the summary and an empty table — the rows list only
    // shows heroes with at least one win.
    get empty() {
        return !this.stats || this.stats.empty;
    }

    get totalWins() {
        return this.stats ? this.stats.totalWins : 0;
    }

    get totalMatches() {
        return this.stats ? this.stats.totalMatches : 0;
    }

    get winRate() {
        return this.stats ? this.stats.winRate : 0;
    }

    get rows() {
        return this.stats ? this.stats.rows : [];
    }
}
