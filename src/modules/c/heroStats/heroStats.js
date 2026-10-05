import { LightningElement, api } from 'lwc';
import {
    RANKED_TOTAL_WINS,
    RANKED_HEROES_NEEDED,
    RANKED_HERO_WINS
} from '../../../../services/constants.js';

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

    // Template can't mix text and expressions inside attribute values, so
    // header/label strings are composed here from the shared constants.
    get totalWinsGoal() {
        return RANKED_TOTAL_WINS;
    }

    get heroesNeeded() {
        return RANKED_HEROES_NEEDED;
    }

    get heroWinsGoal() {
        return RANKED_HERO_WINS;
    }

    get rankedHeader() {
        return `Ranked (${RANKED_HERO_WINS})`;
    }

    get rankedColumnTitle() {
        return `Ranked (${RANKED_HERO_WINS} wins)`;
    }

    get totalWinsPct() {
        return Math.min(100, Math.round((this.totalWins / RANKED_TOTAL_WINS) * 100));
    }

    get statusVariant() {
        return this.isEligible ? 'success' : 'warning';
    }

    get statusLabel() {
        return this.isEligible ? 'RANKED ELIGIBLE' : 'NOT YET ELIGIBLE';
    }
}
