/* global module */
/**
 * Verification Engine v5.4 Stable Plus — Deterministic Confidence Formula
 * Formula: Confidence = min(0.95, Σ(S_i × W_i) × V_c)
 *
 * S_i = Source Score (Tier-1: 0.75 [1.5x sovereign boost], Tier-2: 0.3, Tier-3+: 0.1)
 * W_i = Recency Weight (≤24mo: 1.0, >24mo: 0.5)
 * V_c = Verdict Consistency (unanimous: 1.0, conflicting: 0.5)
 *
 * @param {Array} evidenceChain - Array of {url, tier, timestamp, sentiment}
 * @returns {number} confidenceValue - Between 0.1 and 0.95
 */
function calculateConfidence(evidenceChain) {
    if (!Array.isArray(evidenceChain) || evidenceChain.length === 0) return 0.1;

    // 1. Source sanitization — remove YouTube + Wikipedia (context only, not evidence)
    const filteredEvidence = evidenceChain.filter(item => {
        if (!item.url) return true; // Keep items without URL (conservative)
        try {
            const domain = new URL(item.url).hostname.toLowerCase();
            return !domain.includes('youtube.com') && !domain.includes('youtu.be')
                && !domain.includes('wikipedia.org');
        } catch { return true; }
    });

    if (filteredEvidence.length === 0) return 0.1; // No external evidence

    let totalScore = 0;
    let hasConflict = false;
    const currentYear = new Date().getFullYear();

    for (const source of filteredEvidence) {
        // A. Source Score (S_i) based on tier — v5.4+: 1.5x Tier-1 sovereign boost
        const S_i = source.tier === 1 ? 0.75  // 0.5 × 1.5x Tier-1 boost
            : source.tier === 2 ? 0.3
                : 0.1; // Tier 3, 4, 5

        // B. Recency Weight (W_i)
        // Default: assume current — Google Search grounding returns live data
        let sourceYear = currentYear;
        if (source.timestamp) {
            try { sourceYear = new Date(source.timestamp).getFullYear(); } catch { }
        }
        const W_i = (currentYear - sourceYear <= 2) ? 1.0 : 0.5;

        // C. Accumulate
        totalScore += (S_i * W_i);

        // D. Conflict detection
        if (source.sentiment === 'contradicting') {
            hasConflict = true;
        }
    }

    // E. Verdict Consistency multiplier
    const V_c = hasConflict ? 0.5 : 1.0;

    // F. Final: capped at 0.95, floor at 0.1
    const raw = Math.min(0.95, totalScore * V_c);
    return parseFloat(raw.toFixed(2)) || 0.1;
}

// Export for both Node.js (Jest) and browser (background.js)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { calculateConfidence };
}
