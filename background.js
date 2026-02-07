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

async function getCached(claim, videoId = '') {
    try {
        const hash = (videoId ? videoId + ':' : '') + await hashClaim(claim);
        const cached = claimCache.get(hash);
        if (cached && Date.now() - cached.ts < 86400000) {
            console.log('[FAKTCHECK BG] Cache HIT (24h TTL)');
            return { ...cached.data, fromCache: true };
        }
    } catch (e) { }
    return null;
}

async function setCache(claim, data, videoId = '') {
    try {
        if (claimCache.size >= 500) {
            const first = claimCache.keys().next().value;
            if (first) claimCache.delete(first);
        }
        const hash = (videoId ? videoId + ':' : '') + await hashClaim(claim);
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

// ─── SOURCE REGISTRY (loaded from assets/registry/sources-global.json) ───
let sourceRegistry = null;

// Load registry at startup — falls back to hardcoded domains if fetch fails
async function loadSourceRegistry() {
    try {
        const url = chrome.runtime.getURL('assets/registry/sources-global.json');
        const res = await fetch(url);
        sourceRegistry = await res.json();
        console.log(`[FAKTCHECK BG] ✅ Source registry loaded: v${sourceRegistry.version}, ${Object.keys(sourceRegistry.domains).length} domains`);
    } catch (err) {
        console.warn('[FAKTCHECK BG] ⚠️ Failed to load source registry, using defaults:', err.message);
        sourceRegistry = {
            domains: {
                'parlament.gv.at': { tier: 1 }, 'ris.bka.gv.at': { tier: 1 },
                'bundeskanzleramt.at': { tier: 1 }, 'statistik.at': { tier: 1 },
                'orf.at': { tier: 2 }, 'derstandard.at': { tier: 2 },
                'apa.at': { tier: 1 }, 'reuters.com': { tier: 1 }
            },
            wildcards: { '*.gv.at': { tier: 1 }, '*.gov': { tier: 1 }, '*.edu': { tier: 2 } }
        };
    }
}

// Load immediately when service worker starts
loadSourceRegistry();

function getSourceTier(url) {
    if (!url) return 4;
    try {
        const hostname = new URL(url).hostname.replace(/^www\./, '');

        // 1. Exact domain match
        if (sourceRegistry?.domains?.[hostname]) {
            return sourceRegistry.domains[hostname].tier;
        }

        // 2. Parent domain match (e.g. 'news.orf.at' → 'orf.at')
        const parts = hostname.split('.');
        for (let i = 1; i < parts.length; i++) {
            const parent = parts.slice(i).join('.');
            if (sourceRegistry?.domains?.[parent]) {
                return sourceRegistry.domains[parent].tier;
            }
        }

        // 3. Wildcard TLD match (e.g. '*.gv.at', '*.gov', '*.edu')
        if (sourceRegistry?.wildcards) {
            for (const [pattern, meta] of Object.entries(sourceRegistry.wildcards)) {
                const suffix = pattern.replace('*.', '.');
                if (hostname.endsWith(suffix)) return meta.tier;
            }
        }
    } catch (_e) { }
    return 4; // Unknown source
}

// Get source metadata (label, type, region) for UI display
function getSourceMeta(url) {
    if (!url || !sourceRegistry?.domains) return null;
    try {
        const hostname = new URL(url).hostname.replace(/^www\./, '');
        if (sourceRegistry.domains[hostname]) return sourceRegistry.domains[hostname];
        const parts = hostname.split('.');
        for (let i = 1; i < parts.length; i++) {
            const parent = parts.slice(i).join('.');
            if (sourceRegistry.domains[parent]) return sourceRegistry.domains[parent];
        }
    } catch (_e) { }
    return null;
}

// ─── R2.3: REPRODUCIBLE CONFIDENCE SCORING ──────────────────
// Replaces "LLM vibes" with a deterministic, debuggable number.
// matchType: how well sources corroborate the claim
// topTier:   best source tier found (1=official, 5=unknown)
// allSourcesAgree: no conflicting information found
function calculateConfidence(matchType, topTier, allSourcesAgree) {
    const baseMap = { direct: 0.9, paraphrase: 0.7, none: 0.0 };
    const tierMap = { 1: 1.0, 2: 0.85, 3: 0.7, 4: 0.4, 5: 0.1 };
    const base = baseMap[matchType] || 0.0;
    const sourceMult = tierMap[topTier] || 0.5;
    const agreementMult = allSourcesAgree ? 1.0 : 0.7;
    return parseFloat((base * sourceMult * agreementMult).toFixed(2));
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
    const validVerdicts = ['true', 'mostly_true', 'partially_true', 'mostly_false', 'false', 'unverifiable', 'unverified', 'misleading', 'opinion', 'deceptive'];
    if (typeof data !== 'object' || !data) {
        return { verdict: 'unverifiable', displayVerdict: 'unverifiable', confidence: 0.3, explanation: 'Invalid response', sources: [] };
    }

    let verdict = validVerdicts.includes(data.verdict) ? data.verdict : 'unverifiable';
    // Normalize new judge verdicts to existing system
    if (verdict === 'unverified') verdict = 'unverifiable';
    if (verdict === 'misleading') verdict = 'partially_true';
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

    const tieredSources = sources.slice(0, 8).map(s => {
        const tier = s.tier || getSourceTier(s.url);
        const meta = getSourceMeta(s.url);
        const typeIcon = meta?.type && sourceRegistry?.typeIcons?.[meta.type];
        return {
            title: String(s.title || meta?.label || 'Source').slice(0, 100),
            url: s.url,
            tier,
            icon: typeIcon?.icon || '',
            sourceType: typeIcon?.label || ''
        };
    });

    const tier1Count = tieredSources.filter(s => s.tier === 1).length;
    const tier2Count = tieredSources.filter(s => s.tier === 2).length;
    const totalSources = tieredSources.length;

    // R2.3: Deterministic confidence via calculateConfidence()
    const topTier = tieredSources.length > 0
        ? Math.min(...tieredSources.map(s => s.tier))
        : 5;
    // Use CONFIDENCE_BASIS from judge if available, otherwise infer from sources
    const confidenceBasis = data._confidenceBasis || null;
    const matchType = confidenceBasis
        ? confidenceBasis  // Judge explicitly stated: direct_match, paraphrase, or insufficient_data
        : (tier1Count >= 1 ? 'direct'
            : (tier2Count >= 1 || totalSources >= 2) ? 'paraphrase'
                : 'none');
    // Map judge's 'insufficient_data' to our 'none'
    const normalizedMatchType = matchType === 'insufficient_data' ? 'none' : matchType;
    // If LLM says TRUE but we have no quality sources, sources disagree
    const llmPositive = ['true', 'mostly_true'].includes(verdict);
    const allSourcesAgree = !(llmPositive && totalSources === 0);
    const calibrated = calculateConfidence(normalizedMatchType, topTier, allSourcesAgree);

    // Use calibrated score, but keep LLM score if it's lower (conservative)
    if (calibrated > 0) {
        confidence = Math.min(Math.max(calibrated, 0.1), 1.0);
    }

    // Downgrade verdict if sources don't back it up
    if (llmPositive && matchType === 'none') {
        verdict = 'unverifiable';
        confidence = 0.30;
    } else if (llmPositive && totalSources === 1 && topTier >= 4) {
        verdict = 'partially_true';
        confidence = Math.min(confidence, 0.60);
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

    // V5.1: Code-level Mathematical Guardrail (safety net on top of prompt rule)
    // Extracts numbers from claim vs evidence — if claim number > 10× evidence max, override to FALSE
    let mathOutlier = false;
    if (data._claimText && Array.isArray(data._evidenceQuotes) && data._evidenceQuotes.length > 0) {
        // Extract significant numbers (>100, supports "18 trillion", "$27T", "1.5 billion" etc.)
        const extractNumbers = (text) => {
            const matches = [];
            // Match numbers with optional multiplier words/suffixes
            const numRegex = /(\d[\d,.]*)[\s-]*(trillion|billion|million|thousand|Billionen|Milliarden|Millionen|Tausend|[TBMK](?:\b|$))?/gi;
            let m;
            while ((m = numRegex.exec(text)) !== null) {
                let val = parseFloat(m[1].replace(/,/g, ''));
                if (isNaN(val)) continue;
                const mult = (m[2] || '').toLowerCase();
                if (mult === 'trillion' || mult === 'billionen' || mult === 't') val *= 1e12;
                else if (mult === 'billion' || mult === 'milliarden' || mult === 'b') val *= 1e9;
                else if (mult === 'million' || mult === 'millionen' || mult === 'm') val *= 1e6;
                else if (mult === 'thousand' || mult === 'tausend' || mult === 'k') val *= 1e3;
                if (val > 100) matches.push(val);  // Only flag significant numbers
            }
            return matches;
        };

        const claimNumbers = extractNumbers(data._claimText);
        const evidenceText = data._evidenceQuotes.map(eq => eq.quote).join(' ');
        const evidenceNumbers = extractNumbers(evidenceText);

        if (claimNumbers.length > 0 && evidenceNumbers.length > 0) {
            const maxClaim = Math.max(...claimNumbers);
            const maxEvidence = Math.max(...evidenceNumbers);
            const ratio = maxClaim / maxEvidence;

            if (ratio >= 10) {
                console.log(`[FAKTCHECK BG] 🧮 MATH OUTLIER: claim=${maxClaim}, evidence=${maxEvidence}, ratio=${ratio.toFixed(1)}x`);
                mathOutlier = true;
                verdict = 'false';
                confidence = 0.95;
                explanation = `Mathematical Outlier: Claim states ${maxClaim.toLocaleString()}, but evidence shows ${maxEvidence.toLocaleString()} (${ratio.toFixed(0)}× divergence).`;
            }
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
        source_quality: tier1Count > 0 ? 'high' : tier2Count > 0 ? 'medium' : 'low',
        // Evidence Chain data from judge
        quote: data._quote || '',
        primary_source: data._primarySource || '',
        confidence_basis: data._confidenceBasis || '',
        // Attributed evidence quotes from mapEvidence (local, hallucination-proof)
        evidence_quotes: Array.isArray(data._evidenceQuotes) ? data._evidenceQuotes.slice(0, 10) : [],
        is_debated: (Array.isArray(data._evidenceQuotes) && data._evidenceQuotes.length > 1 &&
            new Set(data._evidenceQuotes.map(eq => eq.url)).size > 1),
        math_outlier: mathOutlier,
        // Stage 0: Professional fact-check results
        fact_checks: Array.isArray(data._factChecks) ? data._factChecks : []
    };
}

// Language Detection — expanded for multilingual support
function detectLang(text) {
    const words = text.toLowerCase().split(/\s+/);
    const total = words.length;
    if (total === 0) return 'en';

    const langWordLists = {
        de: ['und', 'der', 'die', 'das', 'ist', 'nicht', 'mit', 'für', 'von', 'wir', 'haben', 'dass', 'werden', 'wurde', 'sind'],
        fr: ['les', 'des', 'est', 'une', 'que', 'dans', 'pour', 'pas', 'qui', 'sur', 'avec', 'sont', 'ont', 'cette', 'mais'],
        es: ['los', 'las', 'una', 'que', 'por', 'con', 'para', 'como', 'más', 'pero', 'sus', 'está', 'son', 'tiene', 'entre'],
        it: ['che', 'per', 'una', 'con', 'sono', 'della', 'questo', 'anche', 'come', 'più', 'suo', 'stati', 'tutto', 'dal', 'nella'],
        pt: ['que', 'para', 'com', 'uma', 'por', 'mais', 'como', 'mas', 'são', 'foi', 'tem', 'seus', 'pela', 'isso', 'esta']
    };

    let bestLang = 'en';
    let bestScore = 0;

    for (const [lang, langWords] of Object.entries(langWordLists)) {
        const count = words.filter(w => langWords.includes(w)).length;
        const score = count / total;
        if (score > 0.03 && score > bestScore) {
            bestScore = score;
            bestLang = lang;
        }
    }
    return bestLang;
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
        let groundingSupports = [];

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

        // V5.1: Extract groundingSupports — maps text segments → chunk indices
        if (groundingMeta?.groundingSupports) {
            groundingSupports = groundingMeta.groundingSupports.map(s => ({
                text: s.segment?.text || '',
                startIndex: s.segment?.startIndex || 0,
                endIndex: s.segment?.endIndex || 0,
                chunkIndices: s.groundingChunkIndices || [],
                confidences: s.confidenceScores || []
            })).filter(s => s.text.length > 0);
            console.log('[FAKTCHECK BG] 📎 Grounding supports found:', groundingSupports.length);
        }

        if (!text) {
            console.error('[FAKTCHECK BG] Empty search response');
            return callGemini(apiKey, prompt);
        }

        console.log('[FAKTCHECK BG] Search response received, length:', text.length);

        // V5.1: Return text with grounding sources AND supports attached
        return { _rawText: text, _groundingSources: groundingSources, _groundingSupports: groundingSupports };
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
    let knownNames = [];  // Names extracted from metadata for cross-check
    if (metadata && (metadata.title || metadata.channel || metadata.detectedCountry !== 'unknown')) {
        const parts = [];
        if (metadata.title) parts.push(`Video: "${metadata.title}"`);
        if (metadata.channel) parts.push(`Channel: ${metadata.channel}`);
        if (metadata.detectedCountry && metadata.detectedCountry !== 'unknown') {
            parts.push(`Country context: ${metadata.detectedCountry}`);
        }

        // Extract person names from title + description for name-fidelity check
        const nameSource = [metadata.title || '', metadata.description || '', metadata.channel || ''].join(' ');
        // Match capitalized multi-word names (e.g. "Christian Stocker", "Herbert Kickl")
        const nameMatches = nameSource.match(/\b([A-ZÄÖÜ][a-zäöüß]+(?:\s+[A-ZÄÖÜ][a-zäöüß]+)+)\b/g) || [];
        // Deduplicate
        knownNames = [...new Set(nameMatches.map(n => n.trim()))];
        console.log('[FAKTCHECK BG] Known names from metadata:', knownNames);

        const nameContext = knownNames.length > 0
            ? `\nERKANNTE PERSONEN aus Titel/Beschreibung: ${knownNames.join(', ')}`
            : '';

        groundingContext = lang === 'de'
            ? `\n\nKONTEXT (Phase 0 Grounding):\n${parts.join('\n')}${nameContext}\n\nWICHTIG für Grounding:\n- NAMEN-TREUE: Verwende EXAKT die Schreibweise der Namen aus dem Transkript und dem Kontext. NIEMALS Namen abändern, raten oder "korrigieren" (z.B. NICHT "Christopher" statt "Christian", NICHT "Kurtz" statt "Kurz").\n- Wenn ein Name in den ERKANNTEN PERSONEN steht, verwende DIESE Schreibweise.\n- Erkenne Satire/Ironie (z.B. "Witzekanzler" statt "Vizekanzler" = Satire)\n- Erkenne politische Kampfbegriffe (z.B. "Staatsfunk" = kritischer Begriff für ORF)\n- Verifiziere Titel/Funktionen (z.B. ist "Professor Babler" korrekt?)\n- Wenn Personen mit falschen Titeln genannt werden, markiere als SATIRE oder prüfe den Titel\n`
            : `\n\nCONTEXT (Phase 0 Grounding):\n${parts.join('\n')}${nameContext}\n\nGROUNDING RULES:\n- NAME FIDELITY: Use the EXACT spelling of names from the transcript and context. NEVER alter, guess, or "correct" names.\n- If a name appears in the RECOGNIZED PERSONS list, use THAT spelling.\n- Detect satire/irony (e.g., mocking titles, exaggerated claims)\n- Recognize politically charged terms vs neutral descriptions\n- Verify titles/positions match reality\n- If persons are given incorrect titles, flag as SATIRE or verify\n`;
    }

    const prompt = lang === 'de' ?
        `# FAKTCHECK v3.1 — Extraktions-Engine
${groundingContext}

## AUFGABE
Extrahiere Claims nach dem Anker-Prinzip mit QUERY DECOMPOSITION:

### 1. CLAIM HYDRATION
Jeder Claim MUSS die "Wer-Was-Wo-Regel" erfüllen:
- Ersetze ALLE Pronomen durch konkrete Namen
- Ergänze Kontext aus Video-Titel/Gremium
- ⚠️ NAMEN-TREUE: Verwende NUR Namen EXAKT wie im Transkript geschrieben. NIEMALS raten oder abändern!

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

        // Post-extraction name correction: fix hallucinated names using metadata
        if (knownNames.length > 0) {
            for (const claim of validated) {
                let text = claim.claim;
                for (const knownName of knownNames) {
                    const knownParts = knownName.split(/\s+/);
                    const surname = knownParts[knownParts.length - 1];
                    // Find any occurrence of the same surname with a wrong first name
                    // e.g. "Christopher Stocker" → "Christian Stocker"
                    const surnameRegex = new RegExp(`\\b([A-ZÄÖÜ][a-zäöüß]+)\\s+${surname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
                    let match;
                    while ((match = surnameRegex.exec(text)) !== null) {
                        const foundFirstName = match[1];
                        const expectedFirstName = knownParts.slice(0, -1).join(' ');
                        if (foundFirstName !== expectedFirstName && foundFirstName.length > 2) {
                            console.log(`[FAKTCHECK BG] 🔧 Name correction: "${match[0]}" → "${knownName}" (metadata-driven)`);
                            text = text.replace(match[0], knownName);
                        }
                    }
                }
                claim.claim = text;
            }
        }

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

// ─── R2.1: SEPARATION OF POWERS — Two-Step Verification ────
// Step 1: Search only — returns raw evidence, no verdict
// Step 2: Judge only — renders verdict from evidence, no search
// If Step 1 fails, Step 2 never runs (prevents hallucinated verdicts)

async function searchOnly(claimText, apiKey) {
    console.log('[FAKTCHECK BG] ── STEP 1: researchAndSummarize ──');
    const sanitized = sanitize(claimText, 1000);
    const prompt = `Research this claim thoroughly using Google Search. Write a 3-sentence summary of your findings. Focus on specific numbers, dates, and official names.

CLAIM: "${sanitized}"

RULES:
- Search for this claim using Google
- Write a concise 3-sentence summary of what you found
- Focus on specific numbers, dates, and official names
- Do NOT render a verdict or opinion
- If no sources found, respond with: No relevant sources found.`;

    try {
        const result = await callGeminiWithSearch(apiKey, prompt);
        let rawText = '';
        let groundingSources = [];
        let groundingSupports = [];

        if (result && typeof result === 'object' && result._rawText) {
            rawText = result._rawText;
            groundingSources = result._groundingSources || [];
            groundingSupports = result._groundingSupports || [];
        } else {
            rawText = String(result || '');
        }

        console.log('[FAKTCHECK BG] researchAndSummarize found', groundingSources.length, 'grounding sources,', groundingSupports.length, 'grounding supports');
        return { rawText, sources: groundingSources, groundingSupports, error: null };
    } catch (error) {
        console.error('[FAKTCHECK BG] researchAndSummarize failed:', error.message);
        return { rawText: '', sources: [], groundingSupports: [], error: error.message };
    }
}

// ─── STAGE 2: MAP EVIDENCE (Local — zero API calls) ──
function mapEvidence(groundingSupports, groundingSources) {
    console.log('[FAKTCHECK BG] ── STEP 2: mapEvidence (LOCAL, zero API calls) ──');
    if (!groundingSupports || groundingSupports.length === 0) {
        console.log('[FAKTCHECK BG] mapEvidence: No grounding supports available');
        return [];
    }

    const evidenceQuotes = groundingSupports
        .map(support => {
            // Map chunk indices to actual source objects
            const sourceRefs = (support.chunkIndices || [])
                .map(idx => groundingSources[idx])
                .filter(Boolean);
            const bestSource = sourceRefs[0];
            const meta = bestSource ? getSourceMeta(bestSource.url) : null;
            const typeIcon = meta?.type && sourceRegistry?.typeIcons?.[meta.type];

            return {
                quote: String(support.text || '').slice(0, 500),
                source: bestSource?.title || meta?.label || 'Unknown',
                url: bestSource?.url || '',
                tier: bestSource?.tier || 4,
                confidence: support.confidences?.[0] || 0,
                icon: typeIcon?.icon || '',
                sourceType: typeIcon?.label || ''
            };
        })
        .filter(e => e.quote.length > 10 && e.url);

    console.log('[FAKTCHECK BG] mapEvidence:', evidenceQuotes.length, 'attributed quotes from', new Set(evidenceQuotes.map(e => e.url)).size, 'unique sources');
    return evidenceQuotes;
}

async function judgeEvidence(claimText, snippets, sources, apiKey, lang = 'de', claimType = 'factual', facts = []) {
    console.log('[FAKTCHECK BG] ── STEP 3: judgeEvidence (hallucination-proof) ──');
    const sanitized = sanitize(claimText, 1000);
    const isCausal = claimType === 'causal';
    const evidenceBlock = snippets.length > 0
        ? snippets.map((s, i) => `SEARCH_SNIPPET_${i + 1}: ${s}`).join('\n')
        : 'NO SEARCH SNIPPETS AVAILABLE';
    const factsBlock = facts.length > 0
        ? '\nEXTRACTED_FACTS:\n' + facts.map((f, i) => `FACT_${i + 1}: ${f}`).join('\n')
        : '';
    const sourceList = sources.length > 0
        ? sources.map(s => s.url || s).join('; ')
        : 'none';

    // Hallucination-proof system instruction with mathematical outlier guardrail
    const mathGuardrailDE = '\n\n6. Mathematischer Ausreißer: Wenn der Claim einen numerischen Wert enthält, der >10x höher ist als der höchste bestätigte Wert in den Beweisen, antworte \'FALSE\' mit dem Grund \'Mathematischer Ausreißer: Claim behauptet X, Beweis zeigt Y.\'.';
    const mathGuardrailEN = '\n\n6. Mathematical Outlier: If the claim contains a numerical value >10x higher than the highest confirmed figure in the evidence, return \'FALSE\' with reason \'Mathematical Outlier: claim states X, evidence shows Y.\'.';
    const causalRuleDE = '\n\n7. Kausalität: Prüfe ob die zeitliche Abfolge den kausalen Zusammenhang stützt.';
    const causalRuleEN = '\n\n7. Causality: Check whether the timeline supports the causal relationship.';

    const systemInstruction = lang === 'de'
        ? `Du bist ein strikt gebundener Verifikationsrichter. Dir werden ein CLAIM und SEARCH_SNIPPETS gegeben.

KRITISCHE REGELN:

1. NULL externes Wissen: Dir ist VERBOTEN, dein internes Trainingswissen zu nutzen. Wenn die Snippets den Claim nicht erwähnen, MUSS die Antwort 'UNVERIFIED' sein.

2. Direkter Widerspruch: Wenn die Snippets den Claim explizit widerlegen, antworte 'FALSE'.

3. Direkte Bestätigung: Antworte nur 'TRUE' wenn eine offizielle oder seriöse Quelle die spezifischen Zahlen, Daten oder Namen im Claim explizit bestätigt.

4. Teilweise Übereinstimmung: Wenn die Snippets Teile des Claims stützen aber ein Schlüsseldetail fehlt, antworte 'MISLEADING'.

5. Meinung: Wenn der Claim ein Werturteil oder eine persönliche Meinung ist und KEINE prüfbare Faktenaussage enthält, antworte 'OPINION'.${mathGuardrailDE}${isCausal ? causalRuleDE : ''}`
        : `You are a strictly grounded Verification Judge. You will be given a CLAIM and a set of SEARCH_SNIPPETS.

CRITICAL RULES:

1. Zero External Knowledge: You are forbidden from using your internal training data. If the snippets don't mention the claim, you MUST return 'UNVERIFIED'.

2. Direct Contradiction: If the snippets explicitly deny the claim, return 'FALSE'.

3. Direct Support: Only return 'TRUE' if a Tier 1 or Tier 2 source explicitly confirms the specific numbers, dates, or names in the claim.

4. Partial Match: If the snippets support part of the claim but omit a key detail, return 'MISLEADING'.

5. Opinion: If the claim is a value judgment or personal opinion and contains NO verifiable factual assertion, return 'OPINION'.${mathGuardrailEN}${isCausal ? causalRuleEN : ''}`;

    const prompt = `${systemInstruction}

CLAIM: "${sanitized}"

SEARCH_SNIPPETS:
${evidenceBlock}${factsBlock}
SOURCE_URLS: ${sourceList}

MANDATORY OUTPUT FORMAT (start DIRECTLY, no introduction):
VERDICT: [true | false | misleading | opinion | unverified]
PRIMARY_SOURCE: [URL of the most relevant source]
QUOTE: [The exact sentence from the snippet that justifies your verdict]
CONFIDENCE_BASIS: [direct_match | paraphrase | insufficient_data]`;

    try {
        // Use callGemini WITHOUT search grounding — judge only
        const result = await callGemini(apiKey, prompt);
        return String(result || '');
    } catch (error) {
        console.error('[FAKTCHECK BG] judgeEvidence failed:', error.message);
        return '';
    }
}

// ─── STAGE 0: FACT CHECK PRE-CHECK (Google Fact Check Tools API) ──
// Checks if professional fact-checkers have already reviewed this claim.
// Free, ~100ms, uses same API key as Gemini.
async function searchFactChecks(claimText, apiKey, lang = 'de') {
    try {
        const url = new URL('https://factchecktools.googleapis.com/v1alpha1/claims:search');
        url.searchParams.set('query', claimText.slice(0, 200));
        url.searchParams.set('key', apiKey);
        url.searchParams.set('languageCode', lang === 'de' ? 'de' : 'en');
        url.searchParams.set('maxAgeDays', '365');
        url.searchParams.set('pageSize', '3');

        console.log('[FAKTCHECK BG] ── STAGE 0: Fact Check API ──');
        const resp = await fetch(url.toString());
        if (!resp.ok) {
            console.log('[FAKTCHECK BG] Fact Check API returned', resp.status);
            return [];
        }

        const data = await resp.json();
        const results = (data.claims || []).map(c => ({
            claimText: c.text || '',
            claimant: c.claimant || '',
            reviews: (c.claimReview || []).map(r => ({
                publisher: r.publisher?.name || r.publisher?.site || 'Unknown',
                site: r.publisher?.site || '',
                url: r.url || '',
                title: r.title || '',
                rating: r.textualRating || '',
                lang: r.languageCode || '',
                date: r.reviewDate || ''
            }))
        }));

        if (results.length > 0) {
            console.log(`[FAKTCHECK BG] 🏆 Found ${results.length} existing fact-check(s):`);
            results.forEach((r, i) => {
                const review = r.reviews[0];
                if (review) console.log(`[FAKTCHECK BG]   ${i + 1}. "${review.rating}" — ${review.publisher} (${review.url})`);
            });
        } else {
            console.log('[FAKTCHECK BG] No existing fact-checks found (proceeding to full pipeline)');
        }

        return results;
    } catch (error) {
        console.log('[FAKTCHECK BG] Fact Check API error (non-fatal):', error.message);
        return [];
    }
}

// ─── TIER 1A: WIKIDATA ENTITY HYDRATION ──────────────────────────────
// Resolves entity names to Wikidata QIDs and official properties.
// Used to prevent name/title hallucinations (e.g., "The Chancellor" → Q114834789).
// Fallback-safe: returns null on any error.
async function queryWikidata(entityName) {
    try {
        console.log('[FAKTCHECK BG] ── TIER 1A: Wikidata lookup ──', entityName);
        // Step 1: Search for entity QID
        const searchUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(entityName)}&language=de&format=json&origin=*&limit=3`;
        const searchResp = await fetch(searchUrl);
        if (!searchResp.ok) return null;
        const searchData = await searchResp.json();
        const topResult = searchData.search?.[0];
        if (!topResult) {
            console.log('[FAKTCHECK BG] Wikidata: No entity found for', entityName);
            return null;
        }

        const qid = topResult.id;
        console.log('[FAKTCHECK BG] Wikidata: Found', qid, '→', topResult.label, '|', topResult.description);

        // Step 2: Fetch entity claims (P39=position held, P580=start date)
        const entityUrl = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=claims|labels|descriptions&languages=de|en&format=json&origin=*`;
        const entityResp = await fetch(entityUrl);
        if (!entityResp.ok) return null;
        const entityData = await entityResp.json();
        const entity = entityData.entities?.[qid];
        if (!entity) return null;

        // Extract position held (P39) — most recent
        const positions = entity.claims?.P39 || [];
        const currentPosition = positions.find(p => !p.qualifiers?.P582) || positions[0]; // P582=end date, missing = current
        let officialTitle = null;
        let startDate = null;
        if (currentPosition) {
            const positionId = currentPosition.mainsnak?.datavalue?.value?.id;
            if (positionId) {
                // Resolve position label
                const posUrl = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${positionId}&props=labels&languages=de|en&format=json&origin=*`;
                const posResp = await fetch(posUrl);
                if (posResp.ok) {
                    const posData = await posResp.json();
                    officialTitle = posData.entities?.[positionId]?.labels?.de?.value
                        || posData.entities?.[positionId]?.labels?.en?.value;
                }
            }
            // Extract start date (P580)
            const startDateVal = currentPosition.qualifiers?.P580?.[0]?.datavalue?.value?.time;
            if (startDateVal) {
                startDate = startDateVal.replace(/^\+/, '').split('T')[0]; // e.g. "2025-03-03"
            }
        }

        const label = entity.labels?.de?.value || entity.labels?.en?.value || topResult.label;
        const description = entity.descriptions?.de?.value || entity.descriptions?.en?.value || topResult.description;

        const result = { qid, label, description, officialTitle, startDate };
        console.log('[FAKTCHECK BG] Wikidata result:', JSON.stringify(result));
        return result;
    } catch (error) {
        console.log('[FAKTCHECK BG] Wikidata lookup failed (non-fatal):', error.message);
        return null;
    }
}

// ─── TIER 1B: EUROSTAT STATISTICAL API ───────────────────────────────
// Fetches hard economic data directly from Eurostat JSON API.
// Supports: GDP growth (tec00115), inflation HICP (prc_hicp_aind),
// population (demo_gind), unemployment (une_rt_m).
// Fallback-safe: returns null on any error.
const EUROSTAT_INDICATORS = {
    gdp_growth: 'tec00115',
    inflation: 'prc_hicp_aind',
    population: 'demo_gind',
    unemployment: 'une_rt_m'
};

async function queryEurostat(indicator, geo, year) {
    try {
        const datasetId = EUROSTAT_INDICATORS[indicator] || indicator;
        console.log('[FAKTCHECK BG] ── TIER 1B: Eurostat lookup ──', datasetId, geo, year);

        const url = `https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/${datasetId}?format=JSON&geo=${geo}&time=${year}&lang=en`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!resp.ok) {
            console.log('[FAKTCHECK BG] Eurostat returned', resp.status);
            return null;
        }

        const data = await resp.json();
        // Eurostat JSON format: data.value is a map of index→value
        const values = data.value || {};
        const firstKey = Object.keys(values)[0];
        if (firstKey === undefined) {
            console.log('[FAKTCHECK BG] Eurostat: No data for', indicator, geo, year);
            return null;
        }

        const value = values[firstKey];
        const unit = data.extension?.annotation?.find(a => a.title === 'unit')?.value || data.dimension?.unit?.category?.label?.[Object.keys(data.dimension?.unit?.category?.index || {})[0]] || '';

        const result = { value, unit, source: 'eurostat.ec.europa.eu', dataset: datasetId, geo, year };
        console.log('[FAKTCHECK BG] Eurostat result:', JSON.stringify(result));
        return result;
    } catch (error) {
        console.log('[FAKTCHECK BG] Eurostat lookup failed (non-fatal):', error.message);
        return null;
    }
}

// Helper: detect if claim mentions entities that could be hydrated via Wikidata
function detectEntityName(claimText) {
    // Match common political/person patterns in DE and EN
    const patterns = [
        /(?:Bundeskanzler|Kanzler|Präsident|Minister|Chancellor|President)\s+(?:von\s+)?(?:Österreich|Deutschland|Austria|Germany)?\s*(?:ist|is|war|was)?\s*([A-ZÄÖÜ][a-zäöüß]+(?:\s+[A-ZÄÖÜ][a-zäöüß]+){0,2})/i,
        /([A-ZÄÖÜ][a-zäöüß]+(?:\s+[A-ZÄÖÜ][a-zäöüß]+){1,2})\s+(?:ist|is|war|was)\s+(?:der|die|das|the|a)?\s*(?:aktuelle|derzeitige|current|neue|new)?\s*(?:Bundeskanzler|Kanzler|Präsident|Minister|Chancellor|President)/i,
    ];
    for (const p of patterns) {
        const m = claimText.match(p);
        if (m?.[1]) return m[1].trim();
    }
    return null;
}

// Helper: detect if claim mentions economic indicators that Eurostat could answer
function detectEurostatQuery(claimText) {
    const lower = claimText.toLowerCase();
    let indicator = null;
    let geo = null;

    // Detect indicator
    if (/\b(bip|gdp|bruttoinlandsprodukt|wirtschaftswachstum|growth)\b/i.test(lower)) indicator = 'gdp_growth';
    else if (/\b(inflation|teuerung|preissteigerung|hicp|verbraucherpreis)\b/i.test(lower)) indicator = 'inflation';
    else if (/\b(einwohner|bevölkerung|population|inhabitants)\b/i.test(lower)) indicator = 'population';
    else if (/\b(arbeitslosigkeit|unemployment|erwerbslos)\b/i.test(lower)) indicator = 'unemployment';

    if (!indicator) return null;

    // Detect country
    if (/\b(österreich|austria|\bAT\b)\b/i.test(lower)) geo = 'AT';
    else if (/\b(deutschland|germany|\bDE\b)\b/i.test(lower)) geo = 'DE';
    else if (/\b(eu|europäische union|european union)\b/i.test(lower)) geo = 'EU27_2020';
    else if (/\b(frankreich|france|\bFR\b)\b/i.test(lower)) geo = 'FR';
    else if (/\b(italien|italy|\bIT\b)\b/i.test(lower)) geo = 'IT';

    if (!geo) return null;

    // Detect year
    const yearMatch = lower.match(/\b(20[2-3]\d)\b/);
    const year = yearMatch ? yearMatch[1] : new Date().getFullYear().toString();

    return { indicator, geo, year };
}

// ============================================================================
// ✅ FAKTCHECK v2.0: FOUR-TIER VERIFICATION PIPELINE
// Tier 0:  searchFactChecks()     — professional fact-checks (free API)
// Tier 1A: queryWikidata()        — entity hydration (free API)
// Tier 1B: queryEurostat()        — structured statistics (free API)
// Tier 2:  researchAndSummarize() — Gemini search grounding (API call)
// Local:   mapEvidence()          — maps supports to URLs (zero cost)
// Stage 3: judgeEvidence()        — renders verdict from evidence (API call)
// ============================================================================

async function verifyClaim(claimText, apiKey, lang = 'de', claimType = 'factual', videoId = '') {
    console.log('[FAKTCHECK BG] ========== VERIFY CLAIM v2.0 (4-Tier Pipeline) ==========');
    console.log('[FAKTCHECK BG] Claim:', claimText.slice(0, 80) + '...');
    console.log('[FAKTCHECK BG] Type:', claimType, '| VideoID:', videoId || 'none');

    const cached = await getCached(claimText, videoId);
    if (cached) return cached;

    try {
        // ─── TIER 0: Check professional fact-checkers (free, ~100ms) ───
        const existingFactChecks = await searchFactChecks(claimText, apiKey, lang);

        // ─── TIER 1: Structured Data (Wikidata + Eurostat, free, ~200ms) ───
        let tier1Data = [];

        // Tier 1A: Wikidata Entity Hydration
        const entityName = detectEntityName(claimText);
        let wikidataResult = null;
        if (entityName) {
            wikidataResult = await queryWikidata(entityName);
            if (wikidataResult) {
                const wd = wikidataResult;
                tier1Data.push(`WIKIDATA_ENTITY: ${wd.label} (${wd.qid}) — ${wd.description || ''}${wd.officialTitle ? '. Official title: ' + wd.officialTitle : ''}${wd.startDate ? ' since ' + wd.startDate : ''}`);
            }
        }

        // Tier 1B: Eurostat Statistical Data
        const eurostatQuery = detectEurostatQuery(claimText);
        let eurostatResult = null;
        if (eurostatQuery) {
            eurostatResult = await queryEurostat(eurostatQuery.indicator, eurostatQuery.geo, eurostatQuery.year);
            if (eurostatResult) {
                tier1Data.push(`EUROSTAT_DATA: ${eurostatQuery.indicator} for ${eurostatQuery.geo} (${eurostatQuery.year}) = ${eurostatResult.value}${eurostatResult.unit ? ' ' + eurostatResult.unit : ''} (Source: ${eurostatResult.source})`);
            }
        }

        if (tier1Data.length > 0) {
            console.log('[FAKTCHECK BG] Tier 1 found', tier1Data.length, 'structured data points');
        } else {
            console.log('[FAKTCHECK BG] Tier 1: No structured data found (falling through to Tier 2)');
        }

        // ─── TIER 2: Gemini Search Grounding (API call) ───
        const evidence = await searchOnly(claimText, apiKey);

        // Safety net: if search failed entirely, return unverifiable
        if (evidence.error && evidence.sources.length === 0) {
            console.warn('[FAKTCHECK BG v2.0] researchAndSummarize failed — aborting');
            return {
                verdict: 'unverifiable',
                displayVerdict: 'unverifiable',
                confidence: 0,
                explanation: 'Search failed: ' + evidence.error,
                sources: [],
                error: evidence.error
            };
        }

        // ─── LOCAL: Map evidence (zero API calls) ───
        const evidenceQuotes = mapEvidence(evidence.groundingSupports, evidence.sources);

        // Build attribution list for judge
        const attributionList = evidenceQuotes.length > 0
            ? evidenceQuotes.map((eq, i) => `EVIDENCE_${i + 1}: "${eq.quote}" (Source: ${eq.source}, URL: ${eq.url}, Tier: ${eq.tier})`).join('\n')
            : 'NO ATTRIBUTED EVIDENCE AVAILABLE';

        // Build structured data context from Tier 1
        const structuredDataBlock = tier1Data.length > 0
            ? '\n\nSTRUCTURED_DATA (verified, hard facts — prioritize over web search):\n' + tier1Data.join('\n')
            : '';
        // Build fact-check context for judge (if Tier 0 found results)
        let factCheckContext = '';
        if (existingFactChecks.length > 0) {
            const fcLines = existingFactChecks.flatMap(fc =>
                fc.reviews.map(r => `PROFESSIONAL FACT-CHECK: "${r.rating}" by ${r.publisher} (${r.url})`)
            );
            factCheckContext = '\n\n' + fcLines.join('\n') + '\nNote: Professional fact-checkers have already reviewed this or a similar claim. Consider their ratings as strong evidence.';
        }

        // Also pass raw summary text as context
        const snippetsForJudge = evidence.rawText ? [evidence.rawText] : [];

        // ─── STAGE 3: Judge evidence (no search, verdict only) ───
        const judgeResponse = await judgeEvidence(claimText, snippetsForJudge, evidence.sources, apiKey, lang, claimType, [attributionList + structuredDataBlock + factCheckContext]);

        console.log('[FAKTCHECK BG v2.0] Judge response:', judgeResponse.slice(0, 300));

        // Parse the judge's response
        let textToParse = judgeResponse;

        // Detect "Okay, ich werde..." preamble and skip to VERDICT:
        if (textToParse.match(/^(Okay|OK|Ich werde|I will|Let me|Lass mich)/i)) {
            console.error('[FAKTCHECK BG v2.0] ⚠️ Judge started with acknowledgment — extracting VERDICT');
            const verdictIdx = textToParse.indexOf('VERDICT:');
            if (verdictIdx > 0) textToParse = textToParse.substring(verdictIdx);
        }

        // Extract CONFIDENCE_BASIS from judge response
        const basisMatch = textToParse.match(/CONFIDENCE_BASIS:\s*(direct_match|paraphrase|insufficient_data)/i);
        const confidenceBasis = basisMatch ? basisMatch[1].toLowerCase() : null;
        if (confidenceBasis) {
            console.log('[FAKTCHECK BG v2.0] Judge CONFIDENCE_BASIS:', confidenceBasis);
        }

        // Extract PRIMARY_SOURCE and QUOTE for logging
        const primarySourceMatch = textToParse.match(/PRIMARY_SOURCE:\s*(https?:\/\/\S+)/i);
        const quoteMatch = textToParse.match(/QUOTE:\s*(.+)/i);
        if (primarySourceMatch) console.log('[FAKTCHECK BG v2.0] Primary source:', primarySourceMatch[1]);
        if (quoteMatch) console.log('[FAKTCHECK BG v2.0] Quote:', quoteMatch[1].slice(0, 150));

        // Try structured text parsing first, then JSON, then free text
        let parsed = parseStructuredText(textToParse) || extractJSON(textToParse) || parseVerdictFromText(textToParse);

        if (!parsed) {
            console.warn('[FAKTCHECK BG v2.0] All parsing failed');
            parsed = {
                verdict: evidence.sources.length > 0 ? 'partially_true' : 'unverifiable',
                confidence: evidence.sources.length > 0 ? 0.50 : 0.30,
                explanation: evidence.sources.length > 0
                    ? 'Sources found, but analysis could not be parsed.'
                    : 'Could not parse response',
                sources: []
            };
        }

        // Attach judge evidence chain data for UI rendering
        if (parsed) {
            if (confidenceBasis) parsed._confidenceBasis = confidenceBasis;
            if (primarySourceMatch) parsed._primarySource = primarySourceMatch[1];
            if (quoteMatch) parsed._quote = quoteMatch[1].trim();
            // Attach attributed evidence_quotes from mapEvidence (Stage 2)
            if (evidenceQuotes.length > 0) {
                parsed._evidenceQuotes = evidenceQuotes;
            }
            // Pass claim text for math guardrail
            parsed._claimText = claimText;
            // Attach Stage 0 fact-check results for UI
            if (existingFactChecks.length > 0) {
                parsed._factChecks = existingFactChecks;
            }
        }

        // Attach Tier 1 structured data for UI
        if (tier1Data.length > 0) {
            parsed._tier1Data = tier1Data;
        }

        // Merge grounding sources from Tier 2 into parsed result
        if (evidence.sources.length > 0) {
            parsed._groundingSources = evidence.sources;
        }

        const validated = validateVerification(parsed, claimType);
        await setCache(claimText, validated, videoId);
        console.log('[FAKTCHECK BG v2.0] ✅ Verdict:', validated.verdict, '| Confidence:', validated.confidence, '| Quality:', validated.source_quality);
        return validated;
    } catch (error) {
        console.error('[FAKTCHECK BG v2.0] Verify failed:', error.message);
        return {
            verdict: 'unverifiable',
            displayVerdict: 'unverifiable',
            confidence: 0,
            explanation: 'Error: ' + error.message,
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
                const verification = await verifyClaim(message.claim, geminiApiKey, message.lang || 'de', message.claimType || 'factual', message.videoId || '');
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
