// ============================================================
// FAKTCHECK v3.0 — VERDICT ENGINE
// ============================================================
// Core validation logic with all v2 → v3 fixes:
// - Source-tier aware verdict resolution
// - Causal pipeline is opt-in (only type === 'causal')
// - Robust Gemini JSON parsing (strips markdown fences)
// - Separate display category for 'deceptive'
// - Confidence floors based on source quality

// ─── CONSTANTS ──────────────────────────────────────────────

const TIER_1_DOMAINS = [
    'parlament.gv.at',
    'ris.bka.gv.at',
    'orf.at',
    'bundeskanzleramt.gv.at',
    'bmj.gv.at',
    'bmi.gv.at',
    'rechnungshof.gv.at'
];

const TIER_2_DOMAINS = [
    'derstandard.at',
    'diepresse.com',
    'wienerzeitung.at',
    'profil.at',
    'falter.at',
    'kurier.at',
    'kleinezeitung.at',
    'news.at',
    'apa.at'
];

const VALID_VERDICTS = [
    'true', 'mostly_true', 'partially_true',
    'mostly_false', 'false', 'unverifiable',
    'misleading', 'opinion', 'deceptive'
];

// ─── UTILITIES ──────────────────────────────────────────────

/**
 * Strips markdown code fences and extracts JSON from Gemini responses.
 * Gemini often wraps JSON in ```json ... ``` despite instructions.
 */
function extractJSON(raw) {
    if (typeof raw !== 'string') return raw;

    let cleaned = raw.trim();

    // Strip markdown code fences (```json ... ``` or ``` ... ```)
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '');
    cleaned = cleaned.replace(/\n?\s*```\s*$/i, '');
    cleaned = cleaned.trim();

    // Handle cases where Gemini prepends explanation text before JSON
    const jsonStart = cleaned.search(/[\[{]/);
    if (jsonStart > 0) {
        cleaned = cleaned.substring(jsonStart);
    }

    // Find matching closing bracket
    const openChar = cleaned[0];
    if (openChar === '[' || openChar === '{') {
        const closeChar = openChar === '[' ? ']' : '}';
        let depth = 0;
        let inString = false;
        let escape = false;

        for (let i = 0; i < cleaned.length; i++) {
            const c = cleaned[i];
            if (escape) { escape = false; continue; }
            if (c === '\\') { escape = true; continue; }
            if (c === '"') { inString = !inString; continue; }
            if (inString) continue;
            if (c === openChar) depth++;
            if (c === closeChar) depth--;
            if (depth === 0) {
                cleaned = cleaned.substring(0, i + 1);
                break;
            }
        }
    }

    return JSON.parse(cleaned);
}

/**
 * Sanitize string to max length, removing control characters.
 */
function sanitize(str, maxLen = 500) {
    return String(str)
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
        .slice(0, maxLen);
}

/**
 * Determine source tier from URL.
 */
function getSourceTier(url) {
    if (!url) return 3;
    const urlLower = url.toLowerCase();
    if (TIER_1_DOMAINS.some(d => urlLower.includes(d))) return 1;
    if (TIER_2_DOMAINS.some(d => urlLower.includes(d))) return 2;
    return 3;
}

// ─── MAIN VALIDATION ────────────────────────────────────────

/**
 * Validates and normalizes the verification result from Gemini.
 *
 * @param {Object|string} rawData - Raw Gemini response (may be JSON string)
 * @param {Object} originalClaim - The claim object from extraction phase
 * @returns {Object} Normalized verdict object
 */
function validateVerification(rawData, originalClaim = {}) {
    // Step 0: Parse if string (Gemini often returns stringified JSON)
    let data;
    try {
        data = typeof rawData === 'string' ? extractJSON(rawData) : rawData;
    } catch (e) {
        console.error('FAKTCHECK: Failed to parse Gemini response:', e.message);
        return {
            verdict: 'unverifiable',
            displayVerdict: 'unverifiable',
            confidence: 0.3,
            explanation: 'Verifikation fehlgeschlagen: Antwort konnte nicht geparst werden.',
            key_facts: [],
            sources: [],
            timeline: null,
            is_causal: false,
            _parse_error: true
        };
    }

    // Step 1: Extract and validate base fields
    let verdict = VALID_VERDICTS.includes(data.verdict)
        ? data.verdict
        : 'unverifiable';
    let confidence = Math.max(0, Math.min(1, Number(data.confidence) || 0.5));
    let explanation = sanitize(String(data.explanation || ''), 500);

    // Step 2: Process and tier-classify sources
    const sources = Array.isArray(data.sources)
        ? data.sources
            .filter(s => s && s.url)
            .slice(0, 8)
            .map(s => ({
                title: sanitize(String(s.title || 'Quelle'), 150),
                url: String(s.url),
                tier: s.tier || getSourceTier(s.url)
            }))
        : [];

    // Step 3: Source-tier-aware confidence adjustment
    const bestTier = sources.length > 0
        ? Math.min(...sources.map(s => s.tier))
        : 99;
    const sourceCount = sources.length;

    if (verdict === 'true' || verdict === 'mostly_true') {
        // Boost confidence for high-tier sources
        if (bestTier === 1) {
            confidence = Math.max(confidence, 0.85);
        } else if (bestTier === 2 && sourceCount >= 2) {
            confidence = Math.max(confidence, 0.80);
        } else if (bestTier === 3 && sourceCount < 2) {
            // Single low-tier source: downgrade to partially_true
            verdict = 'partially_true';
            confidence = Math.min(confidence, 0.60);
            explanation += ' [Herabgestuft: nur eine Quelle niedriger Qualität]';
        }
    }

    // Step 4: CAUSAL PIPELINE (only for causal claims!)
    const claimType = originalClaim.type || data.type || 'factual';
    const isCausalClaim = claimType === 'causal';
    const timeline = data.timeline || {};
    const intentDate = timeline.intent_date ? new Date(timeline.intent_date) : null;
    const triggerDate = timeline.trigger_date ? new Date(timeline.trigger_date) : null;

    if (isCausalClaim) {
        // Cap confidence for causal claims (correlation ≠ causation)
        confidence = Math.min(confidence, 0.70);

        // Auto-detect timeline contradiction
        if (intentDate && triggerDate && intentDate < triggerDate) {
            verdict = 'deceptive';
            confidence = 0.90; // High but not 0.95 — leave room for edge cases
            explanation = `TIMELINE-WIDERSPRUCH: Ereignis war bereits am ` +
                `${timeline.intent_date} dokumentiert, die angebliche Ursache ` +
                `trat erst am ${timeline.trigger_date} ein. ` +
                `Ursprüngliche Einschätzung: ${explanation}`;
        }
    }

    // Step 5: Display mapping (v3: deceptive gets its own category)
    const displayMap = {
        'true':             'true',
        'mostly_true':      'true',
        'false':            'false',
        'mostly_false':     'false',
        'deceptive':        'deceptive',     // ← NEW: separate category
        'partially_true':   'partially_true',
        'misleading':       'partially_true',
        'unverifiable':     'unverifiable',
        'opinion':          'opinion'
    };

    // Step 6: Key facts
    const keyFacts = Array.isArray(data.key_facts)
        ? data.key_facts.filter(f => typeof f === 'string').slice(0, 5)
        : [];

    return {
        verdict,
        displayVerdict: displayMap[verdict] || 'unverifiable',
        confidence: Math.round(confidence * 100) / 100,
        explanation,
        key_facts: keyFacts,
        sources,
        timeline: isCausalClaim ? { intentDate, triggerDate, ...timeline } : null,
        is_causal: isCausalClaim
    };
}

// ─── GEMINI API CALLER ──────────────────────────────────────

/**
 * Calls the Gemini API with google_search tool enabled.
 * This is the integration point for Chrome extension context.
 *
 * @param {string} prompt - The verification prompt
 * @param {string} model - Gemini model identifier
 * @returns {Promise<Object>} Parsed response
 */
async function callGeminiWithSearch(prompt, model = 'gemini-2.0-flash') {
    const API_KEY = await getApiKey(); // Your existing key retrieval

    const requestBody = {
        contents: [{
            parts: [{ text: prompt }]
        }],
        tools: [{
            // Gemini's built-in google_search tool
            google_search: {}
        }],
        generationConfig: {
            temperature: 0.1,       // Low temp for factual consistency
            topP: 0.8,
            maxOutputTokens: 2048,
            // Gemini 2.0 supports response_mime_type for JSON mode
            response_mime_type: "application/json"
        }
    };

    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        }
    );

    if (!response.ok) {
        // Fallback to older model on failure
        if (model === 'gemini-2.0-flash') {
            console.warn('FAKTCHECK: Falling back to gemini-1.5-flash-latest');
            return callGeminiWithSearch(prompt, 'gemini-1.5-flash-latest');
        }
        throw new Error(`Gemini API error: ${response.status}`);
    }

    const result = await response.json();

    // Extract text from Gemini response structure
    const text = result.candidates?.[0]?.content?.parts
        ?.map(p => p.text)
        .filter(Boolean)
        .join('') || '';

    return extractJSON(text);
}

// ─── FULL PIPELINE ──────────────────────────────────────────

/**
 * Runs the complete fact-check pipeline for a single claim.
 *
 * @param {Object} claim - Extracted claim from Phase 1
 * @returns {Promise<Object>} Final verdict
 */
async function checkClaim(claim) {
    const { buildVerificationPrompt } = await import('./prompts/verification.js');
    const prompt = buildVerificationPrompt(claim);

    try {
        const rawResult = await callGeminiWithSearch(prompt);
        return validateVerification(rawResult, claim);
    } catch (error) {
        console.error('FAKTCHECK: Pipeline error for claim:', claim.claim, error);
        return {
            verdict: 'unverifiable',
            displayVerdict: 'unverifiable',
            confidence: 0.3,
            explanation: `Verifikation fehlgeschlagen: ${error.message}`,
            key_facts: [],
            sources: [],
            timeline: null,
            is_causal: false,
            _error: error.message
        };
    }
}

// ─── EXPORTS ────────────────────────────────────────────────

export {
    validateVerification,
    callGeminiWithSearch,
    checkClaim,
    extractJSON,
    getSourceTier,
    TIER_1_DOMAINS,
    TIER_2_DOMAINS,
    VALID_VERDICTS
};
