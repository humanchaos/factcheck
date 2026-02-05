// FAKTCHECK v3.0 - FIXED Background Service Worker
// FIXES: Correct model, removed broken tools, added extensive logging

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// ✅ FIX #1: Use correct, stable model name
const DEFAULT_MODEL = 'gemini-2.0-flash';  // Stable and fast

console.log('[FAKTCHECK BG] ====================================');
console.log('[FAKTCHECK BG] Service worker started');
console.log('[FAKTCHECK BG] Model:', DEFAULT_MODEL);
console.log('[FAKTCHECK BG] ====================================');

// Rate Limiter
const rateLimiter = {
    calls: [],
    maxCalls: 30,
    windowMs: 60000,

    canMakeCall() {
        const now = Date.now();
        this.calls = this.calls.filter(t => now - t < this.windowMs);
        if (this.calls.length >= this.maxCalls) {
            console.log('[FAKTCHECK BG] Rate limit hit!');
            return false;
        }
        this.calls.push(now);
        return true;
    },

    getRemainingCalls() {
        const now = Date.now();
        this.calls = this.calls.filter(t => now - t < this.windowMs);
        return Math.max(0, this.maxCalls - this.calls.length);
    }
};

// Claim Cache
const claimCache = new Map();

async function hashClaim(claim) {
    try {
        const normalized = claim.toLowerCase().trim().replace(/\s+/g, ' ');
        const encoder = new TextEncoder();
        const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(normalized));
        return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch {
        return claim.toLowerCase().slice(0, 50);
    }
}

async function getCached(claim) {
    try {
        const hash = await hashClaim(claim);
        const cached = claimCache.get(hash);
        if (cached && Date.now() - cached.ts < 3600000) {
            console.log('[FAKTCHECK BG] Cache HIT');
            return { ...cached.data, fromCache: true };
        }
    } catch (e) { }
    return null;
}

async function setCache(claim, data) {
    try {
        if (claimCache.size >= 500) {
            const first = claimCache.keys().next().value;
            if (first) claimCache.delete(first);
        }
        const hash = await hashClaim(claim);
        claimCache.set(hash, { data, ts: Date.now() });
    } catch (e) { }
}

// Sanitization with prompt injection protection
function sanitize(text, maxLen = 5000) {
    if (typeof text !== 'string') return '';
    return text
        .replace(/[\x00-\x1F\x7F]/g, '')  // Remove control chars
        .replace(/"/g, '\\"')              // Escape double quotes
        .replace(/`/g, "'")                // Replace backticks
        .slice(0, maxLen)
        .trim();
}

function validateClaims(data) {
    if (!Array.isArray(data)) {
        console.log('[FAKTCHECK BG] validateClaims: Not an array:', typeof data);
        return [];
    }
    const valid = data.filter(item =>
        typeof item === 'object' && item !== null &&
        typeof item.claim === 'string' &&
        item.claim.length > 5
    ).map(item => ({
        claim: sanitize(item.claim, 1000),
        speaker: item.speaker ? String(item.speaker).slice(0, 100) : null,
        checkability: Number(item.checkability) || 3,
        importance: Number(item.importance) || 3,
        category: String(item.category || 'UNKNOWN'),
        // V3.0 fields
        type: ['factual', 'causal', 'opinion'].includes(item.type) ? item.type : 'factual',
        search_queries: Array.isArray(item.search_queries) ? item.search_queries.slice(0, 3) : [],
        anchors: Array.isArray(item.anchors) ? item.anchors.slice(0, 5) : [],
        is_satire_context: Boolean(item.is_satire_context)
    }));
    console.log('[FAKTCHECK BG] Validated claims:', valid.length);
    return valid;
}

// V3.0 Source Tier Domains
const SOURCE_TIERS = {
    tier1: [ // Official/Parliamentary - 1 source = sufficient
        'parlament.gv.at', 'ris.bka.gv.at', 'orf.at', 'bundeskanzleramt.gv.at',
        'bmj.gv.at', 'bmi.gv.at', 'rechnungshof.gv.at', 'bka.gv.at'
    ],
    tier2: [ // Quality Media - 2 sources = sufficient
        'derstandard.at', 'diepresse.com', 'wienerzeitung.at', 'profil.at',
        'falter.at', 'kurier.at', 'kleinezeitung.at', 'news.at', 'apa.at'
    ]
};

function getSourceTier(url) {
    if (!url) return 3;
    try {
        const domain = new URL(url).hostname.replace('www.', '');
        if (SOURCE_TIERS.tier1.some(d => domain.includes(d))) return 1;
        if (SOURCE_TIERS.tier2.some(d => domain.includes(d))) return 2;
    } catch (e) { }
    return 3;
}

// V3.1 JSON Extraction (BATTLE-TESTED)
// Handles: markdown fences, preamble text, trailing text, truncated responses
function extractJSON(raw) {
    if (!raw) return null;
    if (typeof raw === 'object') return raw;

    let text = String(raw).trim();

    // Try direct parse first
    try { return JSON.parse(text); } catch (e) { }

    // Strip markdown code fences (multiple possible formats)
    text = text.replace(/^```(?:json|JSON|js|javascript)?\s*\n?/gm, '');
    text = text.replace(/\n?\s*```\s*$/gm, '');
    text = text.trim();

    // Try again after fence removal
    try { return JSON.parse(text); } catch (e) { }

    // Find first JSON structure (skip preamble text)
    const jsonStart = text.search(/[\[{]/);
    if (jsonStart === -1) {
        console.warn('[FAKTCHECK] extractJSON: No JSON structure found in:', text.slice(0, 100));
        return null;
    }
    text = text.substring(jsonStart);

    // Match balanced brackets (handles nested structures correctly)
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
        try {
            const result = JSON.parse(repaired);
            console.log('[FAKTCHECK] extractJSON: Repaired truncated JSON');
            return result;
        } catch (e) {
            console.warn('[FAKTCHECK] extractJSON: Truncated JSON repair failed');
            return null;
        }
    }

    try {
        return JSON.parse(text.substring(0, endIndex + 1));
    } catch (e) {
        console.warn('[FAKTCHECK] extractJSON: Final parse failed:', e.message);
        return null;
    }
}

function validateVerification(data, claimType = 'factual') {
    const validVerdicts = ['true', 'mostly_true', 'partially_true', 'mostly_false', 'false', 'unverifiable', 'misleading', 'opinion', 'deceptive'];
    if (typeof data !== 'object' || !data) {
        return { verdict: 'unverifiable', displayVerdict: 'unverifiable', confidence: 0.3, explanation: 'Invalid response', sources: [] };
    }

    let verdict = validVerdicts.includes(data.verdict) ? data.verdict : 'unverifiable';
    let confidence = Math.max(0, Math.min(1, Number(data.confidence) || 0.5));
    let explanation = sanitize(String(data.explanation || ''), 500);

    // V3.1: Source tier analysis - merge JSON sources with grounding sources
    let sources = Array.isArray(data.sources) ? data.sources.filter(s => s && s.url).slice(0, 8) : [];

    // Add grounding sources from Gemini that aren't already present
    if (Array.isArray(data._groundingSources)) {
        const existingUrls = new Set(sources.map(s => s.url));
        for (const gs of data._groundingSources) {
            if (gs.url && !existingUrls.has(gs.url)) {
                sources.push(gs);
            }
        }
    }

    const tieredSources = sources.slice(0, 8).map(s => ({
        title: String(s.title || 'Source').slice(0, 100),
        url: s.url,
        tier: s.tier || getSourceTier(s.url)
    }));

    const tier1Count = tieredSources.filter(s => s.tier === 1).length;
    const tier2Count = tieredSources.filter(s => s.tier === 2).length;
    const totalSources = tieredSources.length;

    // V3.0: Tier-aware confidence adjustment
    if (verdict === 'true' || verdict === 'mostly_true') {
        if (tier1Count >= 1) {
            confidence = Math.max(confidence, 0.85);  // 1 Tier-1 source = high confidence
        } else if (tier2Count >= 2) {
            confidence = Math.max(confidence, 0.80);  // 2 Tier-2 sources
        } else if (totalSources >= 2) {
            confidence = Math.min(confidence, 0.75);  // 2+ Tier-3 only
        } else if (totalSources === 1) {
            verdict = 'partially_true';  // Downgrade: only 1 low-tier source
            confidence = Math.min(confidence, 0.60);
        }
    }

    // V3.0: Causal analysis - ONLY for explicit causal claims
    const isCausalClaim = claimType === 'causal';
    const timeline = data.timeline || {};

    if (isCausalClaim) {
        const intentDate = timeline.intent_date ? new Date(timeline.intent_date) : null;
        const triggerDate = timeline.trigger_date ? new Date(timeline.trigger_date) : null;

        // Cap confidence for causal claims
        confidence = Math.min(confidence, 0.70);

        // Timeline contradiction detection
        if (intentDate && triggerDate && intentDate < triggerDate) {
            verdict = 'deceptive';
            confidence = 0.90;  // V3: reduced from 0.95
            explanation = `Ereignis war bereits am ${timeline.intent_date} geplant, die angebliche Ursache trat erst am ${timeline.trigger_date} ein.`;
        } else if (verdict === 'true' && !intentDate && !triggerDate) {
            // Facts true but causal link unproven
            verdict = 'partially_true';
            confidence = Math.min(confidence, 0.65);
            explanation = (explanation || '') + ' Kausalzusammenhang nicht eindeutig belegt.';
        }
    }

    // V3.0: Display mapping with deceptive → orange
    const displayMap = {
        'true': 'true', 'mostly_true': 'true',
        'false': 'false', 'mostly_false': 'false',
        'deceptive': 'deceptive',  // V3: separate category (orange)
        'partially_true': 'partially_true', 'misleading': 'partially_true',
        'unverifiable': 'unverifiable',
        'opinion': 'opinion'  // V3: new category (purple)
    };

    return {
        verdict,
        displayVerdict: displayMap[verdict] || 'unverifiable',
        confidence,
        explanation,
        key_facts: Array.isArray(data.key_facts) ? data.key_facts.filter(f => typeof f === 'string').slice(0, 5) : [],
        sources: tieredSources,
        timeline: timeline,
        is_causal: isCausalClaim,
        source_quality: tier1Count > 0 ? 'high' : tier2Count > 0 ? 'medium' : 'low'
    };
}

// Language Detection
function detectLang(text) {
    const deWords = ['und', 'der', 'die', 'das', 'ist', 'nicht', 'mit', 'für', 'von', 'wir', 'haben', 'dass', 'werden', 'wurde', 'sind'];
    const words = text.toLowerCase().split(/\s+/);
    const deCount = words.filter(w => deWords.includes(w)).length;
    return deCount > words.length * 0.03 ? 'de' : 'en';
}

// ✅ FIX #2: Gemini API call with proper error handling and NO broken tools
async function callGemini(apiKey, prompt, retryAttempt = 0) {
    const url = `${GEMINI_API_BASE}/${DEFAULT_MODEL}:generateContent?key=${apiKey}`;

    console.log('[FAKTCHECK BG] ----------------------------------------');
    console.log('[FAKTCHECK BG] Calling Gemini API');
    console.log('[FAKTCHECK BG] URL:', url.replace(apiKey, 'API_KEY_HIDDEN'));
    console.log('[FAKTCHECK BG] Prompt length:', prompt.length);

    // Standard call without search
    const body = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 4096
        }
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        console.log('[FAKTCHECK BG] Response status:', response.status);

        // Retry on 503 (overloaded) or 429 (rate limit) with exponential backoff
        if (response.status === 503 || response.status === 429) {
            const retryCount = retryAttempt + 1;
            if (retryCount <= 3) {
                const delay = Math.pow(2, retryCount) * 1000; // 2s, 4s, 8s
                console.log(`[FAKTCHECK BG] Model overloaded, retry ${retryCount}/3 in ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
                return callGemini(apiKey, prompt, retryCount);
            }
        }

        if (!response.ok) {
            const errorText = await response.text();
            console.error('[FAKTCHECK BG] HTTP Error:', response.status, errorText.slice(0, 200));
            throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 100)}`);
        }

        const data = await response.json();

        if (data.error) {
            console.error('[FAKTCHECK BG] API Error:', JSON.stringify(data.error));
            throw new Error(data.error.message || 'Gemini API error');
        }

        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

        if (!text) {
            console.error('[FAKTCHECK BG] Empty response from API');
            console.error('[FAKTCHECK BG] Full response:', JSON.stringify(data).slice(0, 500));
            throw new Error('Empty response from Gemini API');
        }

        // Clean markdown
        const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
        console.log('[FAKTCHECK BG] Response received, length:', cleaned.length);
        console.log('[FAKTCHECK BG] Response preview:', cleaned.slice(0, 100));

        return cleaned;
    } catch (error) {
        console.error('[FAKTCHECK BG] Fetch error:', error.message);
        throw error;
    }
}

// Call Gemini WITH Google Search (for verification)
async function callGeminiWithSearch(apiKey, prompt, retryAttempt = 0) {
    const url = `${GEMINI_API_BASE}/${DEFAULT_MODEL}:generateContent?key=${apiKey}`;

    console.log('[FAKTCHECK BG] ----------------------------------------');
    console.log('[FAKTCHECK BG] Calling Gemini WITH Google Search');
    console.log('[FAKTCHECK BG] Prompt length:', prompt.length);

    // Use Google Search tool for verification
    const body = {
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{
            google_search: {}  // Current API format
        }],
        generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 4096
        }
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        console.log('[FAKTCHECK BG] Search Response status:', response.status);

        // Retry on 503/429
        if (response.status === 503 || response.status === 429) {
            const retryCount = retryAttempt + 1;
            if (retryCount <= 3) {
                const delay = Math.pow(2, retryCount) * 1000;
                console.log(`[FAKTCHECK BG] Search retry ${retryCount}/3 in ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
                return callGeminiWithSearch(apiKey, prompt, retryCount);
            }
        }

        if (!response.ok) {
            const errorText = await response.text();
            console.error('[FAKTCHECK BG] Search HTTP Error:', response.status, errorText.slice(0, 200));
            // Fallback to regular call without search
            console.log('[FAKTCHECK BG] Falling back to non-search call');
            return callGemini(apiKey, prompt);
        }

        const data = await response.json();

        if (data.error) {
            console.error('[FAKTCHECK BG] Search API Error:', JSON.stringify(data.error));
            // Fallback to regular call
            return callGemini(apiKey, prompt);
        }

        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

        // V3.1: Extract grounding metadata
        const groundingMeta = data.candidates?.[0]?.groundingMetadata;
        let groundingSources = [];

        if (groundingMeta?.webSearchQueries) {
            console.log('[FAKTCHECK BG] 🔍 Google Search used:', groundingMeta.webSearchQueries);
        }

        // Extract grounding sources from chunks
        if (groundingMeta?.groundingChunks) {
            groundingSources = groundingMeta.groundingChunks
                .filter(c => c.web?.uri)
                .map(c => ({
                    title: c.web.title || 'Source',
                    url: c.web.uri,
                    tier: getSourceTier(c.web.uri)
                }));
            console.log('[FAKTCHECK BG] 📚 Grounding sources found:', groundingSources.length);
        }

        if (!text) {
            console.error('[FAKTCHECK BG] Empty search response');
            return callGemini(apiKey, prompt);
        }

        console.log('[FAKTCHECK BG] Search response received, length:', text.length);

        // V3.1: Return text with grounding sources attached
        // This allows extractJSON to handle it, and we'll merge sources later
        return { _rawText: text, _groundingSources: groundingSources };
    } catch (error) {
        console.error('[FAKTCHECK BG] Search fetch error:', error.message);
        // Fallback to regular call
        return callGemini(apiKey, prompt);
    }
}

// Extract Claims
async function extractClaims(text, apiKey, metadata = null) {
    const lang = detectLang(text);
    const sanitized = sanitize(text);

    console.log('[FAKTCHECK BG] ========== EXTRACT CLAIMS ==========');
    console.log('[FAKTCHECK BG] Language:', lang);
    console.log('[FAKTCHECK BG] Input text length:', sanitized.length);
    console.log('[FAKTCHECK BG] Text preview:', sanitized.slice(0, 100) + '...');
    console.log('[FAKTCHECK BG] Metadata:', metadata);

    if (sanitized.length < 50) {
        console.log('[FAKTCHECK BG] Text too short, skipping');
        return { claims: [], lang };
    }

    // Build grounding context from metadata
    let groundingContext = '';
    if (metadata && (metadata.title || metadata.channel || metadata.detectedCountry !== 'unknown')) {
        const parts = [];
        if (metadata.title) parts.push(`Video: "${metadata.title}"`);
        if (metadata.channel) parts.push(`Channel: ${metadata.channel}`);
        if (metadata.detectedCountry && metadata.detectedCountry !== 'unknown') {
            parts.push(`Country context: ${metadata.detectedCountry}`);
        }

        groundingContext = lang === 'de'
            ? `\n\nKONTEXT (Phase 0 Grounding):\n${parts.join('\n')}\n\nWICHTIG für Grounding:\n- Erkenne Satire/Ironie (z.B. "Witzekanzler" statt "Vizekanzler" = Satire)\n- Erkenne politische Kampfbegriffe (z.B. "Staatsfunk" = kritischer Begriff für ORF)\n- Verifiziere Titel/Funktionen (z.B. ist "Professor Babler" korrekt?)\n- Wenn Personen mit falschen Titeln genannt werden, markiere als SATIRE oder prüfe den Titel\n`
            : `\n\nCONTEXT (Phase 0 Grounding):\n${parts.join('\n')}\n\nGROUNDING RULES:\n- Detect satire/irony (e.g., mocking titles, exaggerated claims)\n- Recognize politically charged terms vs neutral descriptions\n- Verify titles/positions match reality\n- If persons are given incorrect titles, flag as SATIRE or verify\n`;
    }

    const prompt = lang === 'de' ?
        `# FAKTCHECK v3.0 — Extraktions-Engine
${groundingContext}

## AUFGABE
Extrahiere Claims nach dem Anker-Prinzip mit QUERY DECOMPOSITION:

### 1. CLAIM HYDRATION
Jeder Claim MUSS die "Wer-Was-Wo-Regel" erfüllen:
- Ersetze ALLE Pronomen durch konkrete Namen
- Ergänze Kontext aus Video-Titel/Gremium

### 2. QUERY DECOMPOSITION (NEU!)
Für jeden Claim generiere 2-3 kurze Such-Queries (3-6 Wörter):
- Kombiniere Schlüssel-Entitäten für Google-Suche
- NICHT den ganzen hydratisierten Satz verwenden

BEISPIEL:
Claim: "Im Pilnacek-U-Ausschuss wird behauptet, dass es Vorbereitungskurse gab"
search_queries: ["Hafenecker Vorbereitungskurse Zeugen U-Ausschuss", "ÖVP Anwälte Auskunftspersonen Pilnacek"]

### 3. TYPE DETECTION
- "factual": Reine Faktenbehauptung
- "causal": Enthält "weil/aufgrund/verursacht/führte zu"
- "opinion": Werturteil/Meinung einer Person (z.B. "X kritisiert", "Y fordert")

### 4. VETO
LÖSCHE NUR: Reine Befindlichkeiten ("Er ist glücklich")
BEHALTE: Alles mit Entitäten → hydratisieren!

## Text:
"${sanitized.slice(0, 4000)}"

## Output (NUR JSON-Array):
[{
  "claim": "Hydratisierter Satz mit Namen/Kontext",
  "search_queries": ["Query1 3-6 Wörter", "Query2 3-6 Wörter"],
  "anchors": ["Person", "Institution", "Ereignis"],
  "type": "factual|causal|opinion",
  "is_satire_context": false
}]

Keine Claims? Antworte: []` :
        `You are a fact-checker. Extract verifiable factual claims from this transcript.

Text: "${sanitized.slice(0, 4000)}"

CRITICAL RULES:
1. Every claim MUST be semantically complete (Subject + Verb + Object)
2. NEVER extract sentence fragments like "They did that" or "He said this"
3. The claim must be understandable and verifiable WITHOUT additional context
4. REPLACE ALL PRONOUNS AND REFERENCES with specific terms from context:
   - "that standard" → "the ISO 8601 date format standard" (or whichever standard is meant)
   - "this organization" → "the ITU" (or whichever organization is meant)
   - "the country" → "Germany" (or whichever country is meant)
5. ONLY claims with specific numbers, dates, names, or verifiable facts
6. If context is missing to resolve the reference, DO NOT extract the claim

GOOD EXAMPLES:
✓ "US unemployment rate fell to 3.7% in November 2023"
✓ "Tesla sold over 1.8 million vehicles worldwide in 2023"
✓ "The ITU time format standard was adopted by 20 countries"

BAD EXAMPLES (DO NOT EXTRACT):
✗ "Today, almost every country has that standard" (Which standard?)
✗ "At the beginning, only three countries adopted it" (Adopted what?)
✗ "Prices came down" (Which prices? By how much?)

Respond ONLY with JSON array:
[{"claim": "Complete, self-explanatory claim with all resolved references", "speaker": "Name or null", "checkability": 1-5, "importance": 1-5, "category": "STATISTICS|ECONOMY|POLITICS|SCIENCE"}]

No verifiable facts with sufficient context? Respond: []`;

    try {
        const result = await callGemini(apiKey, prompt);
        console.log('[FAKTCHECK BG] Raw API response:', result.slice(0, 300));

        let parsed;
        try {
            parsed = JSON.parse(result);
            console.log('[FAKTCHECK BG] JSON parsed successfully');
        } catch (parseError) {
            console.log('[FAKTCHECK BG] JSON parse failed, trying to extract array...');
            const match = result.match(/\[[\s\S]*\]/);
            if (match) {
                parsed = JSON.parse(match[0]);
                console.log('[FAKTCHECK BG] Array extracted successfully');
            } else {
                console.error('[FAKTCHECK BG] Could not find JSON array in response');
                return { claims: [], lang, error: 'Could not parse response' };
            }
        }

        const validated = validateClaims(parsed);
        console.log('[FAKTCHECK BG] ========== RESULT ==========');
        console.log('[FAKTCHECK BG] Extracted', validated.length, 'claims');
        validated.forEach((c, i) => console.log(`[FAKTCHECK BG]   ${i + 1}. ${c.claim.slice(0, 60)}...`));
        return { claims: validated, lang };
    } catch (error) {
        console.error('[FAKTCHECK BG] ========== ERROR ==========');
        console.error('[FAKTCHECK BG] Extract claims failed:', error.message);
        return { claims: [], lang, error: error.message };
    }
}

// Verify Claim (v3.0 with type-awareness)
async function verifyClaim(claimText, apiKey, lang = 'de', claimType = 'factual') {
    console.log('[FAKTCHECK BG] ========== VERIFY CLAIM ==========');
    console.log('[FAKTCHECK BG] Claim:', claimText.slice(0, 80) + '...');
    console.log('[FAKTCHECK BG] Type:', claimType);

    const cached = await getCached(claimText);
    if (cached) return cached;

    const sanitized = sanitize(claimText, 1000);
    const isCausal = claimType === 'causal';

    // V3.0: Build type-specific prompt
    const causalBlock = isCausal ? `
## KAUSAL-CHECK (nur für diesen Claim!)
Suche aktiv nach Gegenbeweisen:
- CONTRADICTION: "[Ereignis] bereits vor [Trigger-Datum] geplant?"
- Wenn Intent VOR Trigger → "deceptive"
- Confidence max 0.70 für Kausal-Claims
` : '';

    const prompt = lang === 'de' ?
        `# FAKTCHECK v3.0 — Verifizierungs-Engine

## CLAIM: "${sanitized}"
## TYPE: ${claimType}

## SUCH-STRATEGIE
1. STATUS: Prüfe aktuelle Fakten zu den Entitäten
2. TIMELINE: Extrahiere Datumsangaben aus Quellen
${isCausal ? '3. CONTRADICTION: Suche nach Gegenbeweisen für Kausalität' : ''}

${causalBlock}

## QUELLEN-BEWERTUNG (v3.0 Tier-System)
- Tier-1 (parlament.gv.at, orf.at, ris.bka.gv.at): 1 Quelle reicht
- Tier-2 (derstandard.at, diepresse.com, profil.at): 2 Quellen nötig
- Tier-3 (alle anderen): 2+ Quellen, keine Widersprüche

## VERDICT MATRIX
- TRUE: 1x Tier-1 ODER 2x Tier-2 ODER 2x Tier-3 ohne Widerspruch
- FALSE: Offizielle Daten widerlegen
- DECEPTIVE: Fakten ok, aber Kausal-Link zeitlich unmöglich
- PARTIALLY_TRUE: Kern ok, Details fragwürdig ODER nur 1x Tier-3
- OPINION: Claim ist Werturteil/Meinung
- UNVERIFIABLE: Null Quellen gefunden

## WICHTIG: ENTSCHEIDE! "unverifiable" nur bei NULL Quellen.

## OUTPUT (NUR JSON):
{"verdict": "true", "confidence": 0.85, "explanation": "Kurze Begründung.", "sources": [{"title": "Quelle", "url": "https://..."}]}` :
        `Verify this claim: "${sanitized}"

Evaluate if the claim is true, false, or unverifiable.

Respond ONLY with JSON (NO markdown):
{"verdict": "true", "confidence": 0.8, "explanation": "Brief explanation", "key_facts": ["Fact 1"], "sources": [{"title": "Source", "url": "https://example.com"}]}

Possible verdicts: true, false, partially_true, unverifiable, opinion`;

    try {
        // Use Google Search for verification!
        const result = await callGeminiWithSearch(apiKey, prompt);

        // V3.1: Handle new return format with grounding sources
        let textToParse = result;
        let groundingSources = [];

        if (result && typeof result === 'object' && result._rawText) {
            textToParse = result._rawText;
            groundingSources = result._groundingSources || [];
        }

        // V3.1: Use extractJSON for robust Gemini response handling
        let parsed = extractJSON(textToParse);
        if (!parsed) {
            console.warn('[FAKTCHECK BG] extractJSON failed, raw:', String(textToParse).slice(0, 200));
            parsed = { verdict: 'unverifiable', explanation: 'Could not parse response' };
        }

        // V3.1: Merge grounding sources into parsed result
        if (groundingSources.length > 0) {
            parsed._groundingSources = groundingSources;
        }

        const validated = validateVerification(parsed, claimType);
        await setCache(claimText, validated);
        console.log('[FAKTCHECK BG] Verdict:', validated.verdict, '| Confidence:', validated.confidence, '| Quality:', validated.source_quality);
        return validated;
    } catch (error) {
        console.error('[FAKTCHECK BG] Verify failed:', error.message);
        return {
            verdict: 'unverifiable',
            displayVerdict: 'unverifiable',
            confidence: 0,
            explanation: 'Fehler: ' + error.message,
            sources: [],
            error: error.message
        };
    }
}

// Message Handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[FAKTCHECK BG] Message received:', message.type);

    if (message.type === 'EXTRACT_CLAIMS') {
        if (!rateLimiter.canMakeCall()) {
            console.log('[FAKTCHECK BG] Rate limited, rejecting');
            sendResponse({ error: 'Rate limit exceeded. Please wait a moment.', claims: [] });
            return true;
        }

        (async () => {
            try {
                const { geminiApiKey } = await chrome.storage.local.get(['geminiApiKey']);
                if (!geminiApiKey) {
                    console.error('[FAKTCHECK BG] No API key configured!');
                    sendResponse({ error: 'No API key. Click extension icon to add your Gemini API key.', claims: [] });
                    return;
                }
                console.log('[FAKTCHECK BG] API key found, length:', geminiApiKey.length);

                const result = await extractClaims(message.text, geminiApiKey, message.metadata);
                console.log('[FAKTCHECK BG] Sending response:', result.claims?.length || 0, 'claims');
                sendResponse(result);
            } catch (e) {
                console.error('[FAKTCHECK BG] Handler error:', e);
                sendResponse({ error: e.message, claims: [] });
            }
        })();
        return true;
    }

    if (message.type === 'VERIFY_CLAIM') {
        if (!rateLimiter.canMakeCall()) {
            sendResponse({ error: 'Rate limit', verification: null });
            return true;
        }

        (async () => {
            try {
                const { geminiApiKey } = await chrome.storage.local.get(['geminiApiKey']);
                if (!geminiApiKey) {
                    sendResponse({ error: 'No API key', verification: null });
                    return;
                }
                const verification = await verifyClaim(message.claim, geminiApiKey, message.lang || 'de', message.claimType || 'factual');
                sendResponse({ verification });
            } catch (e) {
                console.error('[FAKTCHECK BG] Verify handler error:', e);
                sendResponse({ error: e.message, verification: null });
            }
        })();
        return true;
    }

    if (message.type === 'CHECK_API_KEY') {
        chrome.storage.local.get(['geminiApiKey'], (result) => {
            const hasKey = !!result.geminiApiKey;
            console.log('[FAKTCHECK BG] API key check:', hasKey ? 'PRESENT' : 'MISSING');
            sendResponse({ hasKey });
        });
        return true;
    }

    if (message.type === 'SAVE_API_KEY') {
        chrome.storage.local.set({ geminiApiKey: message.apiKey }, () => {
            console.log('[FAKTCHECK BG] API key saved successfully');
            sendResponse({ success: true });
        });
        return true;
    }

    if (message.type === 'GET_STATS') {
        sendResponse({
            cacheSize: claimCache.size,
            remaining: rateLimiter.getRemainingCalls()
        });
        return true;
    }

    return false;
});

console.log('[FAKTCHECK BG] Ready and listening for messages');
