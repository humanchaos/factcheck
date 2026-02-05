// ============================================================
// FAKTCHECK v3.1 — THE REAL FIX
// ============================================================
//
// ROOT CAUSE FOUND:
//
// Gemini's `google_search` tool and `response_mime_type: "application/json"`
// are INCOMPATIBLE. When combined:
//   - Gemini performs the search (web_search_queries are populated)
//   - But the structured output mechanism conflicts with grounding
//   - The response comes back malformed, empty, or as raw grounding
//     metadata instead of your requested JSON
//   - Your JSON.parse() fails → "Could not parse response"
//
// This is a KNOWN Gemini bug, confirmed on Google AI Developers Forum
// (Dec 2025): grounding_chunks and grounding_supports are empty when
// using structured output with google_search.
//
// SOLUTION: Two-pass architecture
//   Pass 1: google_search enabled, NO response_mime_type → get free-text verdict
//   Pass 2: NO google_search, response_mime_type: "application/json" → structure it
//
// Alternatively (simpler, implemented here): Single pass with google_search,
// NO response_mime_type, and robust free-text parsing.
//
// ============================================================

// ─── CONFIG ─────────────────────────────────────────────────

const CONFIG = {
    model: 'gemini-2.0-flash',
    fallbackModel: 'gemini-1.5-flash-latest',
    maxRetries: 2,
    temperature: 0.1,
    maxOutputTokens: 4096,
    getApiKey: async () => {
        const { geminiApiKey } = await chrome.storage.local.get(['geminiApiKey']);
        return geminiApiKey || '';
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

function fixMojibake(text) {
    if (!text || !text.includes('Ã')) return text;
    try {
        const bytes = new Uint8Array([...text].map(c => c.charCodeAt(0)));
        const decoded = new TextDecoder('utf-8').decode(bytes);
        if (decoded.includes('Ã') && decoded.length >= text.length) return text;
        return decoded;
    } catch { return text; }
}

function sanitize(str, maxLen = 500) {
    return String(str || '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim().slice(0, maxLen);
}

// ─── GEMINI JSON EXTRACTION (BATTLE-TESTED) ─────────────────

/**
 * Extracts JSON from Gemini free-text responses.
 * Handles: markdown fences, preamble text, trailing text,
 * truncated responses, mixed grounding metadata.
 */
function extractJSON(raw) {
    if (!raw) throw new Error('Empty response');
    if (typeof raw === 'object') return raw;

    let text = String(raw).trim();

    // Strip markdown code fences (multiple possible formats)
    text = text.replace(/^```(?:json|JSON|js|javascript)?\s*\n?/gm, '');
    text = text.replace(/\n?\s*```\s*$/gm, '');
    text = text.trim();

    // Find first JSON structure
    const jsonStart = text.search(/[\[{]/);
    if (jsonStart === -1) {
        throw new Error(`No JSON structure found in: "${text.slice(0, 120)}"`);
    }
    text = text.substring(jsonStart);

    // Match balanced brackets
    const openChar = text[0];
    const closeChar = openChar === '[' ? ']' : '}';
    let depth = 0, inString = false, escaped = false, endIndex = -1;

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
        // Try to repair truncated JSON
        let repaired = text;
        while (depth > 0) { repaired += closeChar; depth--; }
        try { return JSON.parse(repaired); } catch { }
        throw new Error('Truncated JSON, repair failed');
    }

    return JSON.parse(text.substring(0, endIndex + 1));
}

// ─── GEMINI API CALLER ──────────────────────────────────────

/**
 * THE KEY FIX: Calls Gemini WITHOUT response_mime_type when google_search
 * is enabled. This prevents the incompatibility that causes parse failures.
 *
 * @param {string} prompt - Prompt text
 * @param {Object} options
 * @param {boolean} options.useSearch - Enable google_search tool (default: true)
 * @param {boolean} options.forceJSON - Use response_mime_type (default: false)
 * @returns {Promise<Object>} Parsed response
 */
async function callGemini(prompt, options = {}) {
    const {
        model = CONFIG.model,
        useSearch = true,
        forceJSON = false,  // DEFAULT FALSE — this was the bug
        apiKey = await CONFIG.getApiKey()
    } = options;

    if (!apiKey) throw new Error('No Gemini API key');

    // ┌──────────────────────────────────────────────────────┐
    // │ CRITICAL: Do NOT combine google_search with          │
    // │ response_mime_type. They are incompatible in Gemini.  │
    // │                                                       │
    // │ If search is on  → no response_mime_type              │
    // │ If search is off → response_mime_type is safe         │
    // └──────────────────────────────────────────────────────┘
    const tools = useSearch ? [{ google_search: {} }] : [];
    const canForceJSON = forceJSON && !useSearch;
    const isV2Plus = model.includes('2.0') || model.includes('2.5');

    const requestBody = {
        contents: [{ parts: [{ text: prompt }] }],
        ...(tools.length > 0 ? { tools } : {}),
        generationConfig: {
            temperature: CONFIG.temperature,
            topP: 0.8,
            maxOutputTokens: CONFIG.maxOutputTokens,
            ...(canForceJSON && isV2Plus ? { response_mime_type: 'application/json' } : {})
        }
    };

    let lastError;
    const modelsToTry = [model];
    if (model !== CONFIG.fallbackModel) modelsToTry.push(CONFIG.fallbackModel);

    for (const m of modelsToTry) {
        for (let attempt = 0; attempt < CONFIG.maxRetries; attempt++) {
            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(requestBody)
                });

                if (response.status === 429) {
                    await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
                    continue;
                }

                if (!response.ok) {
                    throw new Error(`Gemini ${m}: ${response.status} ${response.statusText}`);
                }

                const result = await response.json();
                const candidate = result.candidates?.[0];

                if (!candidate?.content?.parts?.length) {
                    const reason = candidate?.finishReason || 'NO_CONTENT';
                    throw new Error(`Empty response (${reason})`);
                }

                // Extract text parts only (skip tool call parts)
                const textParts = candidate.content.parts
                    .filter(p => p.text)
                    .map(p => p.text);

                if (textParts.length === 0) {
                    throw new Error('No text parts in response (only tool calls)');
                }

                const fullText = textParts.join('');

                // Also extract grounding sources if available
                const groundingSources = extractGroundingSources(result);

                const parsed = extractJSON(fullText);

                // Merge grounding sources into parsed result if it's a verification
                if (parsed && !Array.isArray(parsed) && groundingSources.length > 0) {
                    parsed._groundingSources = groundingSources;
                }

                console.log(`[FAKTCHECK v3.1] ${m} success, sources:`, groundingSources.length);
                return parsed;

            } catch (error) {
                lastError = error;
                console.warn(`[FAKTCHECK v3.1] ${m} attempt ${attempt + 1}:`, error.message);
            }
        }
    }

    throw lastError || new Error('All API attempts failed');
}

/**
 * Extracts source URLs from Gemini's grounding metadata.
 * These are bonus sources — we don't depend on them.
 */
function extractGroundingSources(apiResponse) {
    try {
        const meta = apiResponse.candidates?.[0]?.groundingMetadata;
        if (!meta?.groundingChunks) return [];
        return meta.groundingChunks
            .filter(c => c.web?.uri)
            .map(c => ({
                title: c.web.title || 'Source',
                url: c.web.uri,
                tier: getSourceTier(c.web.uri)
            }));
    } catch {
        return [];
    }
}

// ─── PHASE 1: EXTRACTION ────────────────────────────────────

async function extractClaims(text, videoTitle = '', speaker = null) {
    const cleanText = fixMojibake(text);

    const prompt = `Du bist ein neutraler Informations-Auditor für österreichische politische Inhalte.

KONTEXT — Video-Titel: "${videoTitle}"
${speaker ? `Sprecher: ${speaker}` : 'Sprecher: Aus Kontext ableiten (bei "-" = Sprecherwechsel)'}

TRANSCRIPT:
"${cleanText}"

AUFGABE: Extrahiere überprüfbare Claims.

REGELN:
1. CLAIM HYDRATION — Ersetze alle Pronomen durch konkrete Namen. Ergänze Gremium/Ereignis aus Titel.
2. SEARCH QUERIES — Pro Claim 2-3 kurze Google-Suchbegriffe (3-6 Wörter, KEINE Sätze!)
3. TYPE — "factual" (Tatsache), "causal" (nur wenn Kausalverknüpfung DER Kern ist), "opinion" (Wertung), "procedural" (Ankündigung)
4. VETO — Lösche reine Befindlichkeiten. Behalte alles mit Entitäten.

Antworte NUR mit einem JSON-Array. Kein anderer Text.

[{"claim": "Hydratisierter Satz", "search_queries": ["query1", "query2"], "anchors": ["Person", "Institution"], "type": "factual", "speaker": "Name (Partei)", "checkability": 3, "importance": 3}]

Keine Claims? Antworte: []`;

    try {
        // Extraction doesn't need search — use forceJSON for reliability
        const claims = await callGemini(prompt, { useSearch: false, forceJSON: true });

        if (!Array.isArray(claims)) return [];

        return claims.filter(c => c?.claim).map(c => ({
            claim: sanitize(c.claim, 500),
            originalClaim: sanitize(c.claim, 500),
            search_queries: Array.isArray(c.search_queries)
                ? c.search_queries.map(q => sanitize(q, 100)).slice(0, 3)
                : buildFallbackQueries(c),
            anchors: Array.isArray(c.anchors)
                ? c.anchors.map(a => sanitize(a, 100)).slice(0, 5)
                : [],
            type: ['factual', 'causal', 'opinion', 'procedural'].includes(c.type) ? c.type : 'factual',
            speaker: c.speaker ? sanitize(c.speaker, 100) : null,
            checkability: Math.max(1, Math.min(5, Number(c.checkability) || 3)),
            importance: Math.max(1, Math.min(5, Number(c.importance) || 3))
        }));
    } catch (error) {
        console.error('[FAKTCHECK v3.1] Extraction failed:', error.message);
        return fallbackExtraction(cleanText);
    }
}

function buildFallbackQueries(claim) {
    const anchors = claim.anchors || [];
    if (anchors.length >= 2) return [anchors.join(' ')];
    const entities = (claim.claim || '').split(/\s+/).filter(w => w.length > 3 && /^[A-ZÄÖÜ]/.test(w)).slice(0, 4);
    return entities.length > 0 ? [entities.join(' ')] : [];
}

function fallbackExtraction(text) {
    return text.split(/[.!?]+/)
        .map(s => s.trim())
        .filter(s => s.length > 20 && /[A-ZÄÖÜ]/.test(s))
        .slice(0, 5)
        .map(s => {
            const entities = s.split(/\s+/).filter(w => /^[A-ZÄÖÜ]/.test(w) && w.length > 2);
            return {
                claim: s, originalClaim: s,
                search_queries: entities.length ? [entities.join(' ')] : [],
                anchors: entities, type: 'factual', speaker: null,
                checkability: 2, importance: 2, _fallback: true
            };
        });
}

// ─── PHASE 2: VERIFICATION ─────────────────────────────────

async function verifyClaim(claim, videoTitle = '') {
    // Short-circuit opinions and procedural claims
    if (claim.type === 'opinion') {
        return {
            verdict: 'opinion', displayVerdict: 'opinion', confidence: 0.80,
            explanation: 'Meinungsäußerung, keine überprüfbare Tatsachenbehauptung.',
            key_facts: [], sources: [], is_causal: false
        };
    }
    if (claim.type === 'procedural') {
        return {
            verdict: 'unverifiable', displayVerdict: 'unverifiable', confidence: 0.50,
            explanation: 'Parlamentarische Ankündigung — Umsetzung nicht überprüfbar.',
            key_facts: [], sources: [], is_causal: false
        };
    }

    const queries = claim.search_queries || [];
    const queryLines = queries.length > 0
        ? queries.map((q, i) => `Suche ${i + 1}: "${q}"`).join('\n')
        : `Suche 1: "${claim.anchors?.join(' ') || claim.claim.split(' ').slice(0, 5).join(' ')}"`;

    const causalSection = claim.type === 'causal' ? `
TIMELINE-PRÜFUNG (kausaler Claim!):
- Suche nach Datumsangaben für Ursache und Wirkung
- intent_date: Wann wurde die FOLGE geplant?
- trigger_date: Wann passierte die URSACHE?
- Wenn intent_date VOR trigger_date → "deceptive"` : '';

    const prompt = `Du bist ein investigativer Faktenprüfer für österreichische Politik.

CLAIM: "${claim.claim}"
TYP: ${claim.type}
KONTEXT: ${videoTitle}

SUCHSTRATEGIE — Verwende google_search mit diesen Queries:
${queryLines}
${causalSection}

QUELLEN-BEWERTUNG:
- parlament.gv.at, orf.at = 1 Quelle reicht für "true"
- derstandard.at, diepresse.com, profil.at = 2 Quellen für "true"
- Andere = 2+ ohne Widersprüche

DU MUSST ENTSCHEIDEN. "unverifiable" NUR wenn NULL Quellen.

Antworte NUR mit JSON. Kein anderer Text davor oder danach.

{"verdict": "true|false|partially_true|deceptive|unverifiable", "confidence": 0.85, "explanation": "Begründung", "key_facts": ["Fakt 1"], "sources": [{"title": "Titel", "url": "https://..."}]${claim.type === 'causal' ? ', "timeline": {"intent_date": null, "trigger_date": null}' : ''}}`;

    try {
        // VERIFICATION: google_search ON, response_mime_type OFF
        const rawResult = await callGemini(prompt, { useSearch: true, forceJSON: false });
        return normalizeVerdict(rawResult, claim);
    } catch (error) {
        console.error('[FAKTCHECK v3.1] Verification failed:', claim.claim.slice(0, 50), error.message);
        return {
            verdict: 'unverifiable', displayVerdict: 'unverifiable', confidence: 0.3,
            explanation: `Verifikation fehlgeschlagen: ${error.message}`,
            key_facts: [], sources: [], is_causal: false, _error: error.message
        };
    }
}

// ─── PHASE 3: VERDICT NORMALIZATION ─────────────────────────

const VALID_VERDICTS = [
    'true', 'mostly_true', 'partially_true', 'mostly_false',
    'false', 'unverifiable', 'misleading', 'opinion', 'deceptive'
];

const DISPLAY_MAP = {
    'true': 'true', 'mostly_true': 'true',
    'false': 'false', 'mostly_false': 'false',
    'deceptive': 'deceptive',
    'partially_true': 'partially_true', 'misleading': 'partially_true',
    'unverifiable': 'unverifiable', 'opinion': 'opinion'
};

function normalizeVerdict(data, originalClaim = {}) {
    let verdict = VALID_VERDICTS.includes(data.verdict) ? data.verdict : 'unverifiable';
    let confidence = Math.max(0, Math.min(1, Number(data.confidence) || 0.5));
    let explanation = sanitize(String(data.explanation || ''), 500);

    // Merge sources from JSON response + grounding metadata
    let sources = Array.isArray(data.sources)
        ? data.sources.filter(s => s?.url).slice(0, 8).map(s => ({
            title: sanitize(String(s.title || 'Quelle'), 150),
            url: String(s.url),
            tier: getSourceTier(s.url)
        }))
        : [];

    // Add grounding sources that aren't already present
    if (data._groundingSources) {
        const existingUrls = new Set(sources.map(s => s.url));
        for (const gs of data._groundingSources) {
            if (!existingUrls.has(gs.url)) {
                sources.push(gs);
            }
        }
    }

    // Source-tier confidence adjustment
    const bestTier = sources.length > 0 ? Math.min(...sources.map(s => s.tier)) : 99;

    if (verdict === 'true' || verdict === 'mostly_true') {
        if (bestTier === 1) {
            confidence = Math.max(confidence, 0.85);
        } else if (bestTier === 2 && sources.length >= 2) {
            confidence = Math.max(confidence, 0.80);
        } else if (sources.length < 2 && bestTier === 3) {
            verdict = 'partially_true';
            confidence = Math.min(confidence, 0.60);
            explanation += ' [Nur eine Quelle niedriger Qualität]';
        }
    }

    // Causal pipeline (ONLY for type=causal)
    const isCausalClaim = originalClaim.type === 'causal';
    const timeline = data.timeline || {};

    if (isCausalClaim) {
        const intentDate = timeline.intent_date ? new Date(timeline.intent_date) : null;
        const triggerDate = timeline.trigger_date ? new Date(timeline.trigger_date) : null;
        confidence = Math.min(confidence, 0.70);

        if (intentDate && triggerDate && intentDate < triggerDate) {
            verdict = 'deceptive';
            confidence = 0.90;
            explanation = `TIMELINE-WIDERSPRUCH: Folge am ${timeline.intent_date}, ` +
                `Ursache erst am ${timeline.trigger_date}. Original: ${explanation}`;
        }
    }

    return {
        verdict,
        displayVerdict: DISPLAY_MAP[verdict] || 'unverifiable',
        confidence: Math.round(confidence * 100) / 100,
        explanation,
        key_facts: Array.isArray(data.key_facts) ? data.key_facts.filter(f => typeof f === 'string').slice(0, 5) : [],
        sources: sources.slice(0, 8),
        timeline: isCausalClaim ? timeline : null,
        is_causal: isCausalClaim
    };
}

// ─── DISPLAY CONFIG ─────────────────────────────────────────

const DISPLAY_CONFIG = {
    true: { label: 'Bestätigt', color: '#22c55e', icon: '✅', emoji: '🟢' },
    false: { label: 'Falsch', color: '#ef4444', icon: '❌', emoji: '🔴' },
    deceptive: { label: 'Irreführend', color: '#f97316', icon: '⚠️', emoji: '🟠' },
    partially_true: { label: 'Teilweise wahr', color: '#eab308', icon: '⚡', emoji: '🟡' },
    unverifiable: { label: 'Nicht überprüfbar', color: '#6b7280', icon: '❓', emoji: '⚪' },
    opinion: { label: 'Meinung', color: '#8b5cf6', icon: '💬', emoji: '🟣' }
};

// ─── EXPORTS FOR BACKGROUND.JS ──────────────────────────────

// These will be imported by background.js
