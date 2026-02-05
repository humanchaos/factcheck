// ============================================================
// FAKTCHECK v3.0 — COMPLETE PIPELINE INTEGRATION
// ============================================================
// Drop-in replacement for your current extraction → verification flow.
// Fixes:
//   1. Robust Gemini JSON extraction (strips fences, preamble, handles truncation)
//   2. Full claim hydration with search query decomposition
//   3. Source-tier-aware verdict engine
//   4. Causal pipeline only fires when type === 'causal'
//   5. UTF-8 sanitization for edge cases
//   6. Detailed error logging to diagnose remaining failures
//
// INTEGRATION: Replace your current chunk processing loop with processChunk()
// at the bottom of this file.

// ─── CONFIG ─────────────────────────────────────────────────

const CONFIG = {
    model: 'gemini-2.0-flash',
    fallbackModel: 'gemini-1.5-flash-latest',
    maxRetries: 2,
    temperature: 0.1,
    maxOutputTokens: 4096,
    // Set your API key retrieval here
    getApiKey: () => {
        // Replace with your actual key retrieval
        // e.g. return chrome.storage.local.get('geminiApiKey')
        return window.__FAKTCHECK_API_KEY || '';
    }
};

// ─── SOURCE TIERS ───────────────────────────────────────────

const TIER_1_DOMAINS = [
    'parlament.gv.at', 'ris.bka.gv.at', 'orf.at',
    'bundeskanzleramt.gv.at', 'bmj.gv.at', 'bmi.gv.at',
    'rechnungshof.gv.at'
];

const TIER_2_DOMAINS = [
    'derstandard.at', 'diepresse.com', 'wienerzeitung.at',
    'profil.at', 'falter.at', 'kurier.at',
    'kleinezeitung.at', 'news.at', 'apa.at'
];

function getSourceTier(url) {
    if (!url) return 3;
    const u = url.toLowerCase();
    if (TIER_1_DOMAINS.some(d => u.includes(d))) return 1;
    if (TIER_2_DOMAINS.some(d => u.includes(d))) return 2;
    return 3;
}

// ─── TEXT UTILITIES ─────────────────────────────────────────

/**
 * Fix double-encoded UTF-8 (mojibake). Safe to call on clean text.
 * Handles: Ã¼ → ü, Ã– → Ö, etc.
 */
function fixMojibake(text) {
    if (!text) return text;
    // Quick check: if no Ã characters, text is probably fine
    if (!text.includes('Ã')) return text;
    try {
        const bytes = new Uint8Array([...text].map(c => c.charCodeAt(0)));
        const decoded = new TextDecoder('utf-8').decode(bytes);
        // Verify it actually improved (decoded should be shorter or have fewer Ã)
        if (decoded.includes('Ã') && decoded.length >= text.length) return text;
        return decoded;
    } catch {
        return text;
    }
}

/**
 * Sanitize string: remove control chars, limit length.
 */
function sanitize(str, maxLen = 500) {
    return String(str || '')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
        .trim()
        .slice(0, maxLen);
}

// ─── GEMINI JSON EXTRACTION ─────────────────────────────────

/**
 * Extracts JSON from Gemini responses. Handles:
 * - ```json ... ``` markdown fences
 * - Preamble text before JSON
 * - Trailing text after JSON
 * - Nested brackets
 * - Empty/null responses
 */
function extractJSON(raw) {
    if (!raw) throw new Error('Empty response from Gemini');
    if (typeof raw === 'object') return raw; // Already parsed

    let text = String(raw).trim();

    // Strip markdown code fences
    text = text.replace(/^```(?:json|JSON)?\s*\n?/m, '');
    text = text.replace(/\n?\s*```\s*$/m, '');
    text = text.trim();

    // Find first [ or { character
    const jsonStart = text.search(/[\[{]/);
    if (jsonStart === -1) {
        throw new Error(`No JSON found in response: "${text.slice(0, 100)}..."`);
    }
    text = text.substring(jsonStart);

    // Match balanced brackets
    const openChar = text[0];
    const closeChar = openChar === '[' ? ']' : '}';
    let depth = 0;
    let inString = false;
    let escaped = false;
    let endIndex = -1;

    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (escaped) { escaped = false; continue; }
        if (c === '\\' && inString) { escaped = true; continue; }
        if (c === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (c === openChar) depth++;
        if (c === closeChar) depth--;
        if (depth === 0) { endIndex = i; break; }
    }

    if (endIndex === -1) {
        // Truncated response — try to repair by closing brackets
        console.warn('FAKTCHECK: Attempting to repair truncated JSON');
        let repaired = text;
        while (depth > 0) {
            repaired += closeChar;
            depth--;
        }
        return JSON.parse(repaired);
    }

    return JSON.parse(text.substring(0, endIndex + 1));
}

// ─── GEMINI API CALLER ──────────────────────────────────────

/**
 * Calls Gemini API with google_search tool and robust error handling.
 * Includes automatic fallback to older model.
 *
 * @param {string} prompt - The prompt text
 * @param {Object} options - Override options
 * @returns {Promise<Object>} Parsed JSON response
 */
async function callGemini(prompt, options = {}) {
    const model = options.model || CONFIG.model;
    const apiKey = options.apiKey || CONFIG.getApiKey();

    if (!apiKey) throw new Error('No Gemini API key configured');

    const isV2Model = model.includes('2.0') || model.includes('2.5');

    const requestBody = {
        contents: [{
            parts: [{ text: prompt }]
        }],
        tools: [{
            google_search: {}
        }],
        generationConfig: {
            temperature: CONFIG.temperature,
            topP: 0.8,
            maxOutputTokens: CONFIG.maxOutputTokens,
            // Only Gemini 2.0+ supports response_mime_type
            ...(isV2Model ? { response_mime_type: 'application/json' } : {})
        }
    };

    let lastError;
    const models = [model];
    if (model !== CONFIG.fallbackModel) {
        models.push(CONFIG.fallbackModel);
    }

    for (const m of models) {
        for (let attempt = 0; attempt < CONFIG.maxRetries; attempt++) {
            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;

                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(requestBody)
                });

                if (response.status === 429) {
                    // Rate limited — wait and retry
                    const wait = Math.pow(2, attempt) * 1000;
                    console.warn(`FAKTCHECK: Rate limited, waiting ${wait}ms`);
                    await new Promise(r => setTimeout(r, wait));
                    continue;
                }

                if (!response.ok) {
                    throw new Error(`Gemini ${m} returned ${response.status}: ${response.statusText}`);
                }

                const result = await response.json();

                // Check for blocked/empty responses
                const candidate = result.candidates?.[0];
                if (!candidate?.content?.parts?.length) {
                    const reason = candidate?.finishReason || 'UNKNOWN';
                    throw new Error(`Gemini returned no content (finishReason: ${reason})`);
                }

                // Extract text parts (skip function call parts from google_search)
                const textParts = candidate.content.parts
                    .filter(p => p.text)
                    .map(p => p.text);

                if (textParts.length === 0) {
                    // Gemini only returned tool calls, no text response
                    // This can happen if grounding consumed the entire response
                    throw new Error('Gemini returned only tool calls, no text verdict');
                }

                const fullText = textParts.join('');

                // Extract and parse JSON
                return extractJSON(fullText);

            } catch (error) {
                lastError = error;
                console.warn(`FAKTCHECK: Attempt ${attempt + 1} with ${m} failed:`, error.message);
            }
        }
    }

    throw lastError || new Error('All Gemini API attempts failed');
}

// ─── PHASE 1: EXTRACTION ────────────────────────────────────

/**
 * Extracts and hydrates claims from a transcript chunk.
 *
 * @param {string} text - Raw transcript text
 * @param {string} videoTitle - Video title for context enrichment
 * @param {string|null} speaker - Known speaker name if available
 * @returns {Promise<Array>} Array of hydrated claim objects
 */
async function extractClaims(text, videoTitle = '', speaker = null) {
    const cleanText = fixMojibake(text);

    const prompt = `Du bist ein neutraler Informations-Auditor für politische Inhalte.

## KONTEXT
Video-Titel: "${videoTitle}"
${speaker ? `Sprecher: ${speaker}` : 'Sprecher: Aus dem Kontext ableiten'}

## TRANSCRIPT
"${cleanText}"

## AUFGABE
Extrahiere überprüfbare Claims nach folgenden Regeln:

### 1. CLAIM HYDRATION (PFLICHT!)
Jeder Claim MUSS die Wer-Was-Wo-Regel erfüllen:
- Ersetze ALLE Pronomen durch konkrete Namen
- Ergänze den Kontext (Gremium, Ausschuss, Ereignis) aus dem Video-Titel
- Mache jeden Claim als eigenständigen Satz verständlich

### 2. SEARCH QUERIES (PFLICHT!)
Generiere 2-3 kurze Google-Suchbegriffe pro Claim (3-6 Wörter).
KEINE ganzen Sätze! Nur Keyword-Kombinationen.

### 3. TYPE
- "factual": Überprüfbare Tatsachenbehauptung
- "causal": NUR wenn die KAUSALVERKNÜPFUNG die Kernaussage ist
- "opinion": Wertung oder Meinung
- "procedural": Parlamentarische Ankündigungen, Anträge

### 4. SPEAKER
Leite den Sprecher aus dem Kontext ab. Bei "-" Wechsel = neuer Sprecher.

### 5. VETO
- LÖSCHE: Reine Befindlichkeiten, Moderationsfloskeln
- BEHALTE: Alles mit Entitäten (Personen, Institutionen, Daten)

## OUTPUT
Antworte NUR mit einem JSON-Array. KEIN Markdown, KEINE Backticks, KEIN Erklärtext.

[{
  "claim": "Vollständig hydratisierter Satz mit allen Namen und Kontext",
  "search_queries": ["3-6 Wort Query 1", "3-6 Wort Query 2"],
  "anchors": ["Person", "Institution", "Ereignis"],
  "type": "factual|causal|opinion|procedural",
  "speaker": "Name (Partei)" oder null,
  "checkability": 1-5,
  "importance": 1-5
}]

Keine Claims? Antworte: []`;

    try {
        const claims = await callGemini(prompt, {
            // Extraction doesn't need google_search, but we keep it
            // consistent. Gemini will just not use it.
        });

        if (!Array.isArray(claims)) {
            console.warn('FAKTCHECK: Extraction returned non-array:', typeof claims);
            return [];
        }

        // Validate and normalize each claim
        return claims
            .filter(c => c && c.claim)
            .map(c => ({
                claim: sanitize(c.claim, 500),
                originalClaim: sanitize(c.claim, 500),
                search_queries: Array.isArray(c.search_queries)
                    ? c.search_queries.map(q => sanitize(q, 100)).slice(0, 3)
                    : generateFallbackQueries(c),
                anchors: Array.isArray(c.anchors)
                    ? c.anchors.map(a => sanitize(a, 100)).slice(0, 5)
                    : [],
                type: ['factual', 'causal', 'opinion', 'procedural'].includes(c.type)
                    ? c.type
                    : 'factual',
                speaker: c.speaker ? sanitize(c.speaker, 100) : null,
                checkability: Math.max(1, Math.min(5, Number(c.checkability) || 3)),
                importance: Math.max(1, Math.min(5, Number(c.importance) || 3))
            }));
    } catch (error) {
        console.error('FAKTCHECK: Extraction failed:', error.message);
        // FALLBACK: Return raw claims without hydration rather than nothing
        return fallbackExtraction(cleanText, videoTitle);
    }
}

/**
 * Generates search queries from anchors when Gemini didn't provide them.
 */
function generateFallbackQueries(claim) {
    const anchors = claim.anchors || [];
    if (anchors.length >= 2) {
        return [anchors.join(' '), anchors.slice(0, 2).join(' ') + ' Österreich'];
    }
    // Extract capitalized words as likely entities
    const entities = (claim.claim || '')
        .split(/\s+/)
        .filter(w => w.length > 3 && /^[A-ZÄÖÜ]/.test(w))
        .slice(0, 4);
    return entities.length > 0 ? [entities.join(' ')] : [''];
}

/**
 * Emergency fallback: Split text into sentence-level claims without Gemini.
 * Better to have unhydrated claims than no claims at all.
 */
function fallbackExtraction(text, videoTitle) {
    const sentences = text
        .split(/[.!?]+/)
        .map(s => s.trim())
        .filter(s => s.length > 20 && /[A-ZÄÖÜ]/.test(s)); // Must have entities

    return sentences.slice(0, 5).map(s => {
        const entities = s.split(/\s+/).filter(w => /^[A-ZÄÖÜ]/.test(w) && w.length > 2);
        return {
            claim: s,
            originalClaim: s,
            search_queries: entities.length > 0 ? [entities.join(' ')] : [],
            anchors: entities,
            type: 'factual',
            speaker: null,
            checkability: 2,
            importance: 2,
            _fallback: true
        };
    });
}

// ─── PHASE 2: VERIFICATION ─────────────────────────────────

/**
 * Verifies a single claim using Gemini + Google Search.
 *
 * @param {Object} claim - Hydrated claim from extraction
 * @param {string} videoTitle - Video title for additional context
 * @returns {Promise<Object>} Verification result
 */
async function verifyClaim(claim, videoTitle = '') {
    // Skip opinion/procedural claims — just label them
    if (claim.type === 'opinion') {
        return {
            verdict: 'opinion',
            displayVerdict: 'opinion',
            confidence: 0.80,
            explanation: 'Dies ist eine Meinungsäußerung, keine überprüfbare Tatsachenbehauptung.',
            key_facts: [],
            sources: [],
            is_causal: false
        };
    }

    if (claim.type === 'procedural') {
        return {
            verdict: 'unverifiable',
            displayVerdict: 'unverifiable',
            confidence: 0.50,
            explanation: 'Parlamentarische Ankündigung — Umsetzung noch nicht überprüfbar.',
            key_facts: [],
            sources: [],
            is_causal: false
        };
    }

    // Build search-query-aware verification prompt
    const queries = claim.search_queries || [];
    const queryInstructions = queries.length > 0
        ? queries.map((q, i) => `### Suche ${i + 1}: "${q}"`).join('\n')
        : `### Suche 1: "${claim.anchors?.join(' ') || claim.claim.split(' ').slice(0, 5).join(' ')}"`;

    const causalSection = claim.type === 'causal' ? `
## TIMELINE-PRÜFUNG (kausaler Claim!)
Suche nach Datumsangaben:
- intent_date: Wann wurde die angebliche FOLGE geplant/angekündigt?
- trigger_date: Wann passierte die angebliche URSACHE?
- Wenn intent_date VOR trigger_date → Kausalität ist falsch → "deceptive"
` : '';

    const prompt = `Du bist ein investigativer Faktenprüfer für österreichische Politik.

## CLAIM
"${claim.claim}"

## CLAIM-TYP: ${claim.type}
## KONTEXT: ${videoTitle}

## SUCHSTRATEGIE
Verwende google_search mit folgenden Queries nacheinander:
${queryInstructions}
${causalSection}

## QUELLEN-BEWERTUNG
- Tier 1 (1 Quelle reicht): parlament.gv.at, ris.bka.gv.at, orf.at
- Tier 2 (2 Quellen nötig): derstandard.at, diepresse.com, profil.at, falter.at
- Tier 3 (2+ Quellen, keine Widersprüche): alle anderen

## ENTSCHEIDUNG — DU MUSST ENTSCHEIDEN!
- "true": Bestätigt durch Quellen (Tier beachten)
- "false": Widerlegt durch offizielle Daten
- "partially_true": Kern stimmt, Details weichen ab
${claim.type === 'causal' ? '- "deceptive": Fakten stimmen, aber zeitlicher Zusammenhang ist falsch' : ''}
- "unverifiable": NUR wenn NULL relevante Quellen gefunden

## OUTPUT
Antworte NUR mit JSON. KEIN Markdown, KEINE Backticks, KEIN Erklärtext.

{
  "verdict": "true|false|partially_true|${claim.type === 'causal' ? 'deceptive|' : ''}unverifiable",
  "confidence": 0.85,
  "explanation": "Kurze Begründung mit Verweis auf Quellen.",
  "key_facts": ["Fakt 1", "Fakt 2"],
  "sources": [{"title": "Quellentitel", "url": "https://..."}]${claim.type === 'causal' ? `,
  "timeline": {"intent_date": "YYYY-MM-DD oder null", "trigger_date": "YYYY-MM-DD oder null"}` : ''}
}`;

    try {
        const rawResult = await callGemini(prompt);
        return normalizeVerdict(rawResult, claim);
    } catch (error) {
        console.error('FAKTCHECK: Verification failed for:', claim.claim.slice(0, 60), error.message);
        return {
            verdict: 'unverifiable',
            displayVerdict: 'unverifiable',
            confidence: 0.3,
            explanation: `Verifikation fehlgeschlagen: ${error.message}`,
            key_facts: [],
            sources: [],
            is_causal: false,
            _error: error.message
        };
    }
}

// ─── PHASE 3: VERDICT NORMALIZATION ─────────────────────────

const VALID_VERDICTS = [
    'true', 'mostly_true', 'partially_true',
    'mostly_false', 'false', 'unverifiable',
    'misleading', 'opinion', 'deceptive'
];

const DISPLAY_MAP = {
    'true':           'true',
    'mostly_true':    'true',
    'false':          'false',
    'mostly_false':   'false',
    'deceptive':      'deceptive',
    'partially_true': 'partially_true',
    'misleading':     'partially_true',
    'unverifiable':   'unverifiable',
    'opinion':        'opinion'
};

/**
 * Normalizes and enriches the raw Gemini verdict.
 */
function normalizeVerdict(data, originalClaim = {}) {
    let verdict = VALID_VERDICTS.includes(data.verdict) ? data.verdict : 'unverifiable';
    let confidence = Math.max(0, Math.min(1, Number(data.confidence) || 0.5));
    let explanation = sanitize(String(data.explanation || ''), 500);

    // Process sources with tier detection
    const sources = Array.isArray(data.sources)
        ? data.sources
            .filter(s => s && s.url)
            .slice(0, 8)
            .map(s => ({
                title: sanitize(String(s.title || 'Quelle'), 150),
                url: String(s.url),
                tier: getSourceTier(s.url)
            }))
        : [];

    // Source-tier confidence adjustment
    const bestTier = sources.length > 0 ? Math.min(...sources.map(s => s.tier)) : 99;

    if (verdict === 'true' || verdict === 'mostly_true') {
        if (bestTier === 1) {
            confidence = Math.max(confidence, 0.85);
        } else if (bestTier === 2 && sources.length >= 2) {
            confidence = Math.max(confidence, 0.80);
        } else if (sources.length < 2 && bestTier === 3) {
            // Single low-tier source: downgrade
            verdict = 'partially_true';
            confidence = Math.min(confidence, 0.60);
            explanation += ' [Nur eine Quelle niedriger Qualität gefunden]';
        }
    }

    // Causal pipeline (ONLY for causal claims)
    const isCausalClaim = originalClaim.type === 'causal';
    const timeline = data.timeline || {};
    const intentDate = timeline.intent_date ? new Date(timeline.intent_date) : null;
    const triggerDate = timeline.trigger_date ? new Date(timeline.trigger_date) : null;

    if (isCausalClaim) {
        confidence = Math.min(confidence, 0.70);
        if (intentDate && triggerDate && intentDate < triggerDate) {
            verdict = 'deceptive';
            confidence = 0.90;
            explanation = `TIMELINE-WIDERSPRUCH: Ereignis am ${timeline.intent_date} ` +
                `dokumentiert, angebliche Ursache erst am ${timeline.trigger_date}. ` +
                `Original: ${explanation}`;
        }
    }

    const keyFacts = Array.isArray(data.key_facts)
        ? data.key_facts.filter(f => typeof f === 'string').slice(0, 5)
        : [];

    return {
        verdict,
        displayVerdict: DISPLAY_MAP[verdict] || 'unverifiable',
        confidence: Math.round(confidence * 100) / 100,
        explanation,
        key_facts: keyFacts,
        sources,
        timeline: isCausalClaim ? timeline : null,
        is_causal: isCausalClaim
    };
}

// ─── CHUNK PROCESSOR (MAIN ENTRY POINT) ─────────────────────

/**
 * Processes a single transcript chunk end-to-end.
 * This replaces your current chunk processing loop.
 *
 * @param {Object} chunk - Raw chunk from your transcript capture
 * @param {string} videoTitle - Video title for context
 * @returns {Promise<Object>} Processed chunk with verified claims
 */
async function processChunk(chunk, videoTitle = '') {
    const text = fixMojibake(chunk.fullText || chunk.newContent || '');

    if (!text || text.length < 20) {
        return { ...chunk, claims: [] };
    }

    // Phase 1: Extract and hydrate claims
    const extractedClaims = await extractClaims(text, videoTitle);

    // Phase 2: Verify each claim (with concurrency limit)
    const verifiedClaims = [];
    for (const claim of extractedClaims) {
        // Skip low-importance/low-checkability claims to save API calls
        if (claim.checkability <= 1 && claim.importance <= 1) {
            verifiedClaims.push({
                ...claim,
                verification: {
                    verdict: 'unverifiable',
                    displayVerdict: 'unverifiable',
                    confidence: 0.3,
                    explanation: 'Zu geringe Überprüfbarkeit/Relevanz.',
                    key_facts: [],
                    sources: [],
                    is_causal: false
                }
            });
            continue;
        }

        const verification = await verifyClaim(claim, videoTitle);
        verifiedClaims.push({
            originalClaim: claim.originalClaim,
            claim: claim.claim,
            speaker: claim.speaker,
            category: claim.type,
            type: claim.type,
            anchors: claim.anchors,
            search_queries: claim.search_queries,
            checkability: claim.checkability,
            importance: claim.importance,
            verification
        });

        // Small delay to avoid rate limiting
        await new Promise(r => setTimeout(r, 200));
    }

    return {
        ...chunk,
        claims: verifiedClaims
    };
}

/**
 * Processes multiple chunks in sequence.
 *
 * @param {Array} chunks - Array of transcript chunks
 * @param {string} videoTitle - Video title
 * @param {Function} onProgress - Optional callback(chunkIndex, totalChunks)
 * @returns {Promise<Array>} Processed chunks
 */
async function processAllChunks(chunks, videoTitle = '', onProgress = null) {
    const results = [];

    for (let i = 0; i < chunks.length; i++) {
        if (onProgress) onProgress(i, chunks.length);

        try {
            const processed = await processChunk(chunks[i], videoTitle);
            results.push(processed);
        } catch (error) {
            console.error(`FAKTCHECK: Chunk ${i} failed entirely:`, error);
            results.push({ ...chunks[i], claims: [], _error: error.message });
        }
    }

    return results;
}

// ─── DISPLAY CONFIG ─────────────────────────────────────────

const DISPLAY_CONFIG = {
    true:            { label: 'Bestätigt',          color: '#22c55e', icon: '✅', emoji: '🟢' },
    false:           { label: 'Falsch',              color: '#ef4444', icon: '❌', emoji: '🔴' },
    deceptive:       { label: 'Irreführend',         color: '#f97316', icon: '⚠️', emoji: '🟠' },
    partially_true:  { label: 'Teilweise wahr',      color: '#eab308', icon: '⚡', emoji: '🟡' },
    unverifiable:    { label: 'Nicht überprüfbar',   color: '#6b7280', icon: '❓', emoji: '⚪' },
    opinion:         { label: 'Meinung',             color: '#8b5cf6', icon: '💬', emoji: '🟣' }
};

// ─── EXPORTS ────────────────────────────────────────────────
// For Chrome extension: attach to window or use ES module exports

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        processChunk,
        processAllChunks,
        extractClaims,
        verifyClaim,
        normalizeVerdict,
        extractJSON,
        fixMojibake,
        callGemini,
        DISPLAY_CONFIG,
        CONFIG
    };
} else if (typeof window !== 'undefined') {
    window.FAKTCHECK = {
        processChunk,
        processAllChunks,
        extractClaims,
        verifyClaim,
        normalizeVerdict,
        extractJSON,
        fixMojibake,
        callGemini,
        DISPLAY_CONFIG,
        CONFIG
    };
}
