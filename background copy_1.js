// FAKTCHECK v3.3 - FIXED Background Service Worker
// FIX: Prompt rewrite to force immediate structured output (no "Okay, ich werde...")

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// ✅ FIX #1: Use correct, stable model name
const DEFAULT_MODEL = 'gemini-2.0-flash';  // Stable and fast

console.log('[FAKTCHECK BG] ====================================');
console.log('[FAKTCHECK BG] Service worker started v3.3');
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

// V3.2: Parse structured VERDICT/CONFIDENCE/EXPLANATION format
function parseStructuredText(text) {
    if (!text) return null;

    const verdictMatch = text.match(/VERDICT\s*:\s*(\S+)/i);
    const confMatch = text.match(/CONFIDENCE\s*:\s*([\d.]+)/i);
    const explMatch = text.match(/EXPLANATION\s*:\s*(.+?)(?:\n|$)/i);
    const factsMatch = text.match(/KEY_FACTS\s*:\s*(.+?)(?:\n|$)/i);
    const sourcesMatch = text.match(/SOURCES\s*:\s*(.+?)(?:\n|$)/i);

    if (!verdictMatch) return null;

    const verdict = verdictMatch[1].toLowerCase().replace(/[^a-z_]/g, '');
    const confidence = confMatch ? parseFloat(confMatch[1]) : 0.5;

    let sources = [];
    if (sourcesMatch) {
        sources = sourcesMatch[1].split(/[;,]/).map(s => s.trim()).filter(s => s.startsWith('http'))
            .map(url => ({ title: 'Source', url, tier: getSourceTier(url) }));
    }

    let keyFacts = [];
    if (factsMatch) {
        keyFacts = factsMatch[1].split(';').map(f => f.trim()).filter(Boolean);
    }

    console.log('[FAKTCHECK v3.3] parseStructuredText found verdict:', verdict, 'confidence:', confidence);
    return {
        verdict,
        confidence: Math.max(0, Math.min(1, confidence)),
        explanation: explMatch ? explMatch[1].trim() : '',
        key_facts: keyFacts,
        sources
    };
}

// V3.2: Parse verdict from free-form natural language
function parseVerdictFromText(text) {
    if (!text || typeof text !== 'string') return null;
    const t = text.toLowerCase();

    // Try JSON first
    const jsonResult = extractJSON(text);
    if (jsonResult && jsonResult.verdict) return jsonResult;

    let verdict = 'unverifiable';
    let confidence = 0.5;

    // Check for explicit verdict markers
    if (/\b(verdict|urteil|ergebnis)\s*[:=]\s*"?(true|wahr|bestätigt|confirmed)/i.test(t)) {
        verdict = 'true'; confidence = 0.80;
    } else if (/\b(verdict|urteil|ergebnis)\s*[:=]\s*"?(false|falsch|widerlegt|refuted)/i.test(t)) {
        verdict = 'false'; confidence = 0.80;
    } else if (/\b(verdict|urteil|ergebnis)\s*[:=]\s*"?(partially|teilweise)/i.test(t)) {
        verdict = 'partially_true'; confidence = 0.65;
    } else if (/\b(verdict|urteil|ergebnis)\s*[:=]\s*"?(deceptive|irreführend|täuschend)/i.test(t)) {
        verdict = 'deceptive'; confidence = 0.85;
    } else if (/\b(verdict|urteil|ergebnis)\s*[:=]\s*"?(opinion|meinung)/i.test(t)) {
        verdict = 'opinion'; confidence = 0.75;
    } else if (/\b(verdict|urteil|ergebnis)\s*[:=]\s*"?(unverifiable|nicht überprüfbar)/i.test(t)) {
        verdict = 'unverifiable'; confidence = 0.50;
    }
    // Fallback: strong language indicators
    else if (/\b(ist (korrekt|richtig|wahr|bestätigt)|stimmt|trifft zu|dies ist (wahr|korrekt|richtig))\b/i.test(t)) {
        verdict = 'true'; confidence = 0.70;
    } else if (/\b(ist (falsch|inkorrekt|unwahr|widerlegt)|stimmt nicht|trifft nicht zu)\b/i.test(t)) {
        verdict = 'false'; confidence = 0.70;
    } else if (/\b(teilweise|zum teil|im kern)\b/i.test(t)) {
        verdict = 'partially_true'; confidence = 0.60;
    } else if (/\b(meinung|einschätzung|wertung|politische aussage)\b/i.test(t)) {
        verdict = 'opinion'; confidence = 0.65;
    }

    // Extract confidence if written
    const confMatch = t.match(/\b(confidence|konfidenz|sicherheit)\s*[:=]\s*(\d+(?:\.\d+)?)/i);
    if (confMatch) {
        const parsed = parseFloat(confMatch[2]);
        if (parsed > 0 && parsed <= 1) confidence = parsed;
        else if (parsed > 1 && parsed <= 100) confidence = parsed / 100;
    }

    // Extract explanation
    const explanation = text
        .split(/\n/)
        .map(l => l.trim())
        .filter(l => l.length > 30 && !/^[\[{#*]/.test(l))
        .slice(0, 3)
        .join(' ')
        .slice(0, 500) || 'Aus Suchresultaten abgeleitet.';

    console.log('[FAKTCHECK v3.3] parseVerdictFromText found verdict:', verdict);
    return { verdict, confidence, explanation, key_facts: [] };
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

    // ============================================================================
    // v3.6: METADATA-DRIVEN SPEAKER RESOLUTION
    // Extract names from title to force speaker identification
    // ============================================================================
    let speakerContext = '';
    let primaryGuest = 'Hauptsprecher';
    let identifiedNames = [];

    if (metadata && metadata.title) {
        // Find names like "Christian Hafenecker" or "Armin Wolf"
        const titleNames = metadata.title.match(/[A-ZÄÖÜ][a-zäöüß]+ [A-ZÄÖÜ][a-zäöüß]+/g) || [];
        identifiedNames = titleNames;
        primaryGuest = titleNames[0] || 'Hauptsprecher';

        console.log('[FAKTCHECK BG v3.6] Identified names from title:', identifiedNames);

        speakerContext = lang === 'de' ? `
IDENTIFIZIERTE PERSONEN AUS VIDEO-TITEL: ${identifiedNames.length > 0 ? identifiedNames.join(', ') : 'Keine gefunden'}
KANAL/MEDIUM: ${metadata.channel || 'Unbekannt'}
VIDEO-TITEL: "${metadata.title}"

ANWEISUNG ZUR SPRECHER-AUFLÖSUNG:
- Der Hauptsprecher im Video ist höchstwahrscheinlich: ${primaryGuest}
- Nutze "${metadata.channel || 'Moderator'}" für Moderatoren-Rollennamen
- Ersetze "Ein Sprecher", "Ich", "Er/Sie" IMMER durch ${primaryGuest} oder einen der Titel-Namen
- Jeder Claim MUSS einen konkreten Namen im Feld "speaker" haben
` : `
IDENTIFIED PERSONS FROM VIDEO TITLE: ${identifiedNames.length > 0 ? identifiedNames.join(', ') : 'None found'}
CHANNEL/MEDIUM: ${metadata.channel || 'Unknown'}
VIDEO TITLE: "${metadata.title}"

SPEAKER RESOLUTION INSTRUCTIONS:
- The main speaker is most likely: ${primaryGuest}
- Use "${metadata.channel || 'Moderator'}" for host/moderator roles
- ALWAYS replace "A speaker", "I", "He/She" with ${primaryGuest} or one of the title names
- Every claim MUST have a concrete name in the "speaker" field
`;
    }

    const prompt = lang === 'de' ?
        `# FAKTCHECK v3.6 — Metadata-Only Speaker Resolution
${speakerContext}

## AUFGABE
Extrahiere Claims. Löse Sprecher-Identitäten AUSSCHLIESSLICH über die obigen METADATEN auf.

### STRENGE REGELN:
1. JEDER Claim muss einen konkreten Namen im Feld "speaker" haben.
2. Nutze die Namen aus dem VIDEO-TITEL. Verwende NIEMALS "Ein Sprecher" oder "Unbekannt".
3. CLAIM-HYDRATION: Ersetze Pronomen ("er", "sie", "wir", "ich") im Text durch die Namen aus den Metadaten.
   - Beispiel: "Ich habe das abgelehnt" → "${primaryGuest} hat das abgelehnt"
   - Beispiel: "Er sagte, dass..." → "${primaryGuest} sagte, dass..."
4. QUERY-DECOMPOSITION: Erstelle 2-3 Suchbegriffe inkl. der Namen aus den Metadaten.

### TYPE DETECTION:
- "factual": Reine Faktenbehauptung
- "causal": Enthält "weil/aufgrund/verursacht/führte zu"
- "opinion": Werturteil/Meinung einer Person (z.B. "X kritisiert", "Y fordert")

### VETO:
LÖSCHE NUR: Reine Befindlichkeiten ("Er ist glücklich")
BEHALTE: Alles mit Entitäten → hydratisieren!

## TEXT:
"${sanitized.slice(0, 4000)}"

## OUTPUT (NUR JSON-Array, beginne DIREKT mit [):
[{
  "claim": "Vollständiger Satz mit Namen aus Metadaten",
  "speaker": "${primaryGuest}",
  "search_queries": ["${primaryGuest} + Schlagwort", "Query2"],
  "anchors": ["Person", "Institution"],
  "type": "factual|causal|opinion",
  "checkability": 3,
  "importance": 3
}]

Keine Claims? Antworte: []` :
        `# FAKTCHECK v3.6 — Metadata-Only Speaker Resolution
${speakerContext}

## TASK
Extract claims. Resolve speaker identities EXCLUSIVELY via the METADATA above.

### STRICT RULES:
1. EVERY claim MUST have a concrete name in the "speaker" field.
2. Use names from the VIDEO TITLE. NEVER use "A speaker" or "Unknown".
3. CLAIM HYDRATION: Replace pronouns ("he", "she", "we", "I") with names from metadata.
   - Example: "I rejected that" → "${primaryGuest} rejected that"
4. QUERY DECOMPOSITION: Create 2-3 search terms including names from metadata.

### TYPE DETECTION:
- "factual": Pure factual claim
- "causal": Contains "because/due to/caused/led to"
- "opinion": Value judgment/opinion (e.g., "X criticizes", "Y demands")

## TEXT:
"${sanitized.slice(0, 4000)}"

## OUTPUT (JSON array ONLY, start DIRECTLY with [):
[{
  "claim": "Complete sentence with names from metadata",
  "speaker": "${primaryGuest}",
  "search_queries": ["${primaryGuest} + keyword", "Query2"],
  "anchors": ["Person", "Institution"],
  "type": "factual|causal|opinion",
  "checkability": 3,
  "importance": 3
}]

No claims? Respond: []`;

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

// ============================================================================
// ✅ FIX v3.3: COMPLETELY REWRITTEN VERIFY PROMPT
// The old prompt caused Gemini to say "Okay, ich werde..." instead of doing it
// ============================================================================

async function verifyClaim(claimText, apiKey, lang = 'de', claimType = 'factual') {
    console.log('[FAKTCHECK BG] ========== VERIFY CLAIM v3.3 ==========');
    console.log('[FAKTCHECK BG] Claim:', claimText.slice(0, 80) + '...');
    console.log('[FAKTCHECK BG] Type:', claimType);

    const cached = await getCached(claimText);
    if (cached) return cached;

    const sanitized = sanitize(claimText, 1000);
    const isCausal = claimType === 'causal';

    // ============================================================================
    // v3.3 FIX: New prompt structure that FORCES immediate output
    // Key changes:
    // 1. No "task description" that sounds like instructions
    // 2. Start with "Analysiere und bewerte JETZT" (Analyze and evaluate NOW)
    // 3. Output format comes FIRST, not last
    // 4. Explicit "Beginne direkt mit VERDICT:" instruction
    // ============================================================================

    const prompt = lang === 'de' ?
        `Analysiere den folgenden Claim und gib SOFORT das Ergebnis aus.

CLAIM: "${sanitized}"

ANTWORT-FORMAT (beginne DIREKT mit VERDICT, KEINE Einleitung):
VERDICT: [true|false|partially_true|deceptive|opinion|unverifiable]
CONFIDENCE: [0.0-1.0]
EXPLANATION: [1-2 Sätze Begründung auf Deutsch]
KEY_FACTS: [Fakt 1; Fakt 2]
SOURCES: [URL1; URL2]

BEWERTUNGS-KRITERIEN:
- TRUE: Fakten durch offizielle Quellen (parlament.gv.at, orf.at) oder 2+ seriöse Medien bestätigt
- FALSE: Fakten widerlegt durch offizielle Daten
- PARTIALLY_TRUE: Kern stimmt, Details ungenau oder nur 1 unsichere Quelle
- DECEPTIVE: Fakten korrekt aber irreführend dargestellt${isCausal ? ' (z.B. Kausalität zeitlich unmöglich)' : ''}
- OPINION: Werturteil/Meinung, keine prüfbare Faktenaussage
- UNVERIFIABLE: KEINE Quellen gefunden (nur als letzter Ausweg!)

WICHTIG: Antworte SOFORT mit "VERDICT:" - keine Einleitung wie "Okay" oder "Ich werde"!` :

        `Analyze the following claim and output the result IMMEDIATELY.

CLAIM: "${sanitized}"

RESPONSE FORMAT (start DIRECTLY with VERDICT, NO introduction):
VERDICT: [true|false|partially_true|deceptive|opinion|unverifiable]
CONFIDENCE: [0.0-1.0]
EXPLANATION: [1-2 sentences]
KEY_FACTS: [Fact 1; Fact 2]
SOURCES: [URL1; URL2]

EVALUATION CRITERIA:
- TRUE: Facts confirmed by official sources or 2+ quality media
- FALSE: Facts disproven by official data
- PARTIALLY_TRUE: Core is correct, details uncertain or only 1 weak source
- DECEPTIVE: Facts correct but misleadingly presented
- OPINION: Value judgment, not a verifiable factual claim
- UNVERIFIABLE: NO sources found (only as last resort!)

IMPORTANT: Respond IMMEDIATELY with "VERDICT:" - no introduction like "Okay" or "I will"!`;

    try {
        // Use Google Search for verification!
        const result = await callGeminiWithSearch(apiKey, prompt);

        // V3.2: Handle new return format with grounding sources
        let textToParse = result;
        let groundingSources = [];

        if (result && typeof result === 'object' && result._rawText) {
            textToParse = result._rawText;
            groundingSources = result._groundingSources || [];
        }

        console.log('[FAKTCHECK BG v3.3] Raw response:', String(textToParse).slice(0, 300));
        console.log('[FAKTCHECK BG v3.3] Grounding sources:', groundingSources.length);

        // ============================================================================
        // v3.3 FIX: Detect the "Okay, ich werde..." problem and log it
        // ============================================================================
        const responseText = String(textToParse);
        if (responseText.match(/^(Okay|OK|Ich werde|I will|Let me|Lass mich)/i)) {
            console.error('[FAKTCHECK BG v3.3] ⚠️ DETECTED: AI started with acknowledgment instead of VERDICT!');
            console.error('[FAKTCHECK BG v3.3] Response start:', responseText.slice(0, 150));
            // Try to find VERDICT: somewhere in the response anyway
            const verdictIdx = responseText.indexOf('VERDICT:');
            if (verdictIdx > 0) {
                console.log('[FAKTCHECK BG v3.3] Found VERDICT at position', verdictIdx, '- extracting...');
                textToParse = responseText.substring(verdictIdx);
            }
        }

        // V3.2: Try structured text parsing first, then JSON, then free text
        let parsed = parseStructuredText(textToParse) || extractJSON(textToParse) || parseVerdictFromText(textToParse);

        if (!parsed) {
            console.warn('[FAKTCHECK BG v3.3] All parsing failed');
            // Fallback: use grounding sources if available
            parsed = {
                verdict: groundingSources.length > 0 ? 'partially_true' : 'unverifiable',
                confidence: groundingSources.length > 0 ? 0.50 : 0.30,
                explanation: groundingSources.length > 0
                    ? 'Quellen gefunden, aber keine explizite Analyse von Gemini.'
                    : 'Could not parse response',
                sources: []
            };
        }

        // V3.2: Merge grounding sources into parsed result
        if (groundingSources.length > 0) {
            parsed._groundingSources = groundingSources;
        }

        const validated = validateVerification(parsed, claimType);
        await setCache(claimText, validated);
        console.log('[FAKTCHECK BG v3.3] ✅ Verdict:', validated.verdict, '| Confidence:', validated.confidence, '| Quality:', validated.source_quality);
        return validated;
    } catch (error) {
        console.error('[FAKTCHECK BG v3.3] Verify failed:', error.message);
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

console.log('[FAKTCHECK BG] Ready and listening for messages (v3.3)');
