/* global describe, test, expect, require */
/**
 * Jest Test Suite: Verification Engine v5.4 Stable — Confidence Calibration
 * Tests the deterministic calculateConfidence() formula against ticket specifications.
 */
const { calculateConfidence } = require('./calculateConfidence.js');

describe('Verification Engine v5.4 Stable Plus: Confidence Calibration', () => {

    test('Case: Stocker 1% Goal (High Trust / Tier-1)', () => {
        const evidence = [
            { url: 'https://www.bundeskanzleramt.gv.at/news/stocker', tier: 1, timestamp: '2026-01-10', sentiment: 'supporting' },
            { url: 'https://www.dievolkspartei.at/programm', tier: 1, timestamp: '2025-11-20', sentiment: 'supporting' }
        ];
        // Two Tier-1, recent, unanimous: (0.75 + 0.75) * 1.0 = 1.5 → capped at 0.95
        const result = calculateConfidence(evidence);
        expect(result).toBe(0.95);
    });

    test('Case: Propaganda Filter (YouTube Sanitization)', () => {
        const evidence = [
            { url: 'https://www.youtube.com/watch?v=123', tier: 3, timestamp: '2026-02-08', sentiment: 'supporting' }
        ];
        // YouTube filtered → empty → 0.1
        const result = calculateConfidence(evidence);
        expect(result).toBe(0.1);
    });

    test('Case: Wikipedia Sanitization', () => {
        const evidence = [
            { url: 'https://de.wikipedia.org/wiki/Test', tier: 3, timestamp: '2026-02-08', sentiment: 'supporting' }
        ];
        // Wikipedia filtered → empty → 0.1
        expect(calculateConfidence(evidence)).toBe(0.1);
    });

    test('Case: Contradicting Evidence (Consistency Multiplier)', () => {
        const evidence = [
            { url: 'https://www.statistik.at/daten', tier: 1, timestamp: '2026-01-01', sentiment: 'supporting' },
            { url: 'https://www.wifo.ac.at/prognose', tier: 1, timestamp: '2026-01-01', sentiment: 'contradicting' }
        ];
        // Erwartung: (0.75 + 0.75) * 0.5 (Multiplier) = 0.75
        const result = calculateConfidence(evidence);
        expect(result).toBe(0.75);
    });

    test('Case: Outdated Data (Recency Weight)', () => {
        const evidence = [
            { url: 'https://www.imf.org/report2020', tier: 1, timestamp: '2020-01-01', sentiment: 'supporting' }
        ];
        // Tier-1 × old = 0.75 * 0.5 = 0.375
        const result = calculateConfidence(evidence);
        expect(result).toBe(0.38);
    });

    test('Case: Global Ranking "Platz 185" (Mixed Sources)', () => {
        const evidence = [
            { url: 'https://www.fpoe-tv.at/video', tier: 3, timestamp: '2026-02-08', sentiment: 'supporting' },
            { url: 'https://www.unbekannter-blog.at', tier: 3, timestamp: '2026-02-08', sentiment: 'supporting' }
        ];
        // Erwartung: Ohne Tier-1/2 bleibt der Wert extrem niedrig
        const result = calculateConfidence(evidence);
        expect(result).toBeLessThan(0.3);
    });

    test('Case: Empty evidence chain', () => {
        expect(calculateConfidence([])).toBe(0.1);
        expect(calculateConfidence(null)).toBe(0.1);
        expect(calculateConfidence(undefined)).toBe(0.1);
    });

    test('Case: No timestamp defaults to current year', () => {
        const evidence = [
            { url: 'https://www.statistik.at/daten', tier: 1, timestamp: null, sentiment: 'supporting' }
        ];
        // No timestamp → assumes current → W_i = 1.0 → 0.75 * 1.0 = 0.75
        expect(calculateConfidence(evidence)).toBe(0.75);
    });

    test('Case: Mixed Tier-2 + Tier-3 (News agencies)', () => {
        const evidence = [
            { url: 'https://reuters.com/article/test', tier: 2, timestamp: '2026-01-15', sentiment: 'supporting' },
            { url: 'https://apnews.com/article/test', tier: 2, timestamp: '2026-01-15', sentiment: 'supporting' },
            { url: 'https://random-blog.com', tier: 3, timestamp: '2026-02-01', sentiment: 'supporting' }
        ];
        // (0.3 + 0.3 + 0.1) * 1.0 = 0.7
        const result = calculateConfidence(evidence);
        expect(result).toBe(0.7);
    });
});
