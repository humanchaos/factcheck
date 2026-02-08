/* global describe, test, expect, require */
/**
 * Jest Test Suite: Verification Engine v5.4 Stable — Confidence Calibration
 * Tests the deterministic calculateConfidence() formula against ticket specifications.
 */
const { calculateConfidence } = require('./calculateConfidence.js');

describe('Verification Engine v5.4: Confidence Calibration', () => {

    test('Case: Stocker 1% Goal (High Trust / Tier-1)', () => {
        const evidence = [
            { url: 'https://www.bundeskanzleramt.gv.at/news/stocker', tier: 1, timestamp: '2026-01-10', sentiment: 'supporting' },
            { url: 'https://www.dievolkspartei.at/programm', tier: 1, timestamp: '2025-11-20', sentiment: 'supporting' }
        ];
        // Erwartung: (0.5 + 0.5) * 1.0 = 1.0 -> Deckelung auf 0.95
        const result = calculateConfidence(evidence);
        expect(result).toBeGreaterThanOrEqual(0.85);
        expect(result).toBeLessThanOrEqual(0.95);
    });

    test('Case: Propaganda Filter (YouTube Sanitization)', () => {
        const evidence = [
            { url: 'https://www.youtube.com/watch?v=123', tier: 3, timestamp: '2026-02-08', sentiment: 'supporting' }
        ];
        // Erwartung: YouTube wird gefiltert -> Leeres Array -> 0.1 Confidence
        const result = calculateConfidence(evidence);
        expect(result).toBe(0.1);
    });

    test('Case: Contradicting Evidence (Consistency Multiplier)', () => {
        const evidence = [
            { url: 'https://www.statistik.at/daten', tier: 1, timestamp: '2026-01-01', sentiment: 'supporting' },
            { url: 'https://www.wifo.ac.at/prognose', tier: 1, timestamp: '2026-01-01', sentiment: 'contradicting' }
        ];
        // Erwartung: (0.5 + 0.5) * 0.5 (Multiplier) = 0.5
        const result = calculateConfidence(evidence);
        expect(result).toBe(0.5);
    });

    test('Case: Outdated Data (Recency Weight)', () => {
        const evidence = [
            { url: 'https://www.imf.org/report2020', tier: 1, timestamp: '2020-01-01', sentiment: 'supporting' }
        ];
        // Erwartung: 0.5 (Tier-1) * 0.5 (Weight) = 0.25
        const result = calculateConfidence(evidence);
        expect(result).toBe(0.25);
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

    test('Case: Mixed Tier-2 + Tier-3 (News agencies)', () => {
        const evidence = [
            { url: 'https://reuters.com/article/test', tier: 2, timestamp: '2026-01-15', sentiment: 'supporting' },
            { url: 'https://apnews.com/article/test', tier: 2, timestamp: '2026-01-15', sentiment: 'supporting' },
            { url: 'https://random-blog.com', tier: 3, timestamp: '2026-02-01', sentiment: 'supporting' }
        ];
        // Erwartung: (0.3 + 0.3 + 0.1) * 1.0 = 0.7
        const result = calculateConfidence(evidence);
        expect(result).toBe(0.7);
    });
});
