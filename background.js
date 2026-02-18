// FAKTCHECK v3.3 - FIXED Background Service Worker
// FIX: Prompt rewrite to force immediate structured output (no "Okay, ich werde...")

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// ✅ FIX #1: Use correct, stable model name
const DEFAULT_MODEL = 'gemini-2.0-flash';  // Stable and fast

console.log('[FAKTCHECK BG] ====================================');
console.log('[FAKTCHECK BG] Service worker started v3.3');
console.log('[FAKTCHECK BG] Model:', DEFAULT_MODEL);
console.log('[FAKTCHECK BG] ====================================');

// ─── MV3 KEEPALIVE: Prevent service worker termination during API calls ───
let _activeApiCalls = 0;
let _keepAliveInterval = null;

function apiCallStart() {
    _activeApiCalls++;
    if (!_keepAliveInterval) {
        _keepAliveInterval = setInterval(() => {
            if (_activeApiCalls > 0) {
                // chrome.storage.local.get forces the worker to stay alive
                chrome.storage.local.get(['_keepalive'], () => { });
            } else {
                clearInterval(_keepAliveInterval);
                _keepAliveInterval = null;
            }
        }, 25000); // Every 25s (Chrome kills after 30s of inactivity)
    }
}

function apiCallEnd() {
    _activeApiCalls = Math.max(0, _activeApiCalls - 1);
}

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

// V5.5+: Global IFCN cache (cross-video, 24h TTL)
// Key: SHA256(cleanedClaim + lang), Value: { result, ts }
const ifcnCache = new Map();

async function hashClaim(claim) {
    try {
        // V5.4 STABLE MODULE 3: Enhanced normalization for semantic deduplication
        // Strips punctuation + collapses whitespace so "Platz 185." == "platz 185"
        const normalized = claim.toLowerCase().trim()
            .replace(/[^\w\s\u00C0-\u017F]/g, '')  // Strip punctuation, keep umlauts
            .replace(/\s+/g, ' ');
        const encoder = new TextEncoder();
        const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(normalized));
        return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch {
        return claim.toLowerCase().replace(/[^\w\s]/g, '').slice(0, 50);
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
    const valid = data
        // v5.4+: Binary filter — drop SKIP claims
        .filter(item => {
            if (typeof item !== 'object' || item === null) return false;
            if (item.status === 'SKIP') {
                console.log('[FAKTCHECK BG] ⏭️ SKIP (binary filter):', (item.factual_core || item.claim || '').slice(0, 60));
                return false;
            }
            // Accept both new schema (factual_core) and old (claim)
            const text = item.factual_core || item.claim;
            return typeof text === 'string' && text.length > 5;
        })
        .map(item => {
            const factualCore = sanitize(item.factual_core || item.claim, 1000);
            return {
                claim: factualCore,  // Backward compat: downstream uses .claim
                factual_core: factualCore,
                speaker: item.speaker ? String(item.speaker).slice(0, 100) : null,
                checkability: Number(item.checkability) || 3,
                importance: Number(item.importance) || 3,
                category: String(item.category || 'UNKNOWN'),
                type: ['factual', 'causal', 'opinion'].includes(item.type) ? item.type : 'factual',
                search_queries: Array.isArray(item.search_queries) ? item.search_queries.slice(0, 3) : [],
                anchors: Array.isArray(item.anchors) ? item.anchors.slice(0, 5) : [],
                is_satire_context: Boolean(item.is_satire_context),
                // v5.4+ nested fields
                occurrences: Array.isArray(item.occurrences) ? item.occurrences.slice(0, 10).map(o => ({
                    timestamp_hint: String(o.timestamp_hint || o.timestamp || ''),
                    rhetorical_framing: String(o.rhetorical_framing || ''),
                    raw_snippet: String(o.raw_snippet || '').slice(0, 500)
                })) : [],
                phonetic_repairs: Array.isArray(item.phonetic_repairs) ? item.phonetic_repairs.slice(0, 10).map(r => ({
                    original: String(r.original || ''),
                    corrected: String(r.corrected || '')
                })) : [],
                status: 'PROCESS'
            };
        });
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

// ─── V5.4 STABLE: DETERMINISTIC CONFIDENCE SCORING ──────────────────
// Formula: Confidence = min(0.95, Σ(S_i × W_i) × V_c)
// S_i = Source Score (Tier-1: 0.5, Tier-2: 0.3, Tier-3+: 0.1)
// W_i = Recency Weight (≤24mo: 1.0, >24mo: 0.5)
// V_c = Verdict Consistency (unanimous: 1.0, conflicting: 0.5)
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
        // A. Source Score (S_i) based on tier
        const S_i = source.tier === 1 ? 0.5
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

// V5.4: SEMANTIC CORE EXTRACTION — Strip attribution shells at code level
// Removes "Laut...", "XY sagt...", "...behauptet" etc. to extract atomic factual core
function stripAttribution(claimText) {
    if (!claimText || typeof claimText !== 'string') return claimText;
    let text = claimText.trim();

    // German attribution patterns (ordered from most specific to broadest)
    const dePatterns = [
        // "Laut X, ..." or "Laut X: ..." — with explicit delimiter (non-greedy to prevent over-strip on numbers with commas)
        /^Laut\s+\S+(?:\s+\S+){0,3}[,:]\s*/i,
        // "Laut dem/der/des X, ..." — with article + delimiter
        /^Laut\s+(?:dem|der|des|einem|einer)\s+\S+(?:\s+\S+){0,3}[,:]\s*/i,
        // "Laut X verb..." — NO comma, verb acts as boundary (e.g., "Laut Prognosen wächst...")
        /^Laut\s+\S+(?:\s+\S+){0,3}\s+(?:ist|sind|war|wird|wächst|liegt|beträgt|hat|haben|wurde|soll|steigt|sinkt|fällt|verursachen|zeigen)\s+/i,
        // "Laut dem/der X verb..." — with article, NO comma
        /^Laut\s+(?:dem|der|des|einem|einer)\s+\S+(?:\s+\S+){0,3}\s+(?:ist|sind|war|wird|wächst|liegt|beträgt|hat|haben|wurde|soll|steigt|sinkt|fällt|verursachen|zeigen)\s+/i,
        // "Gemäß/Wie X sagt/behauptet..." — with speech verb
        /^(?:Laut|Gemäß|Wie)\s+\S+(?:\s+\S+){0,4}\s+(?:sagt|behauptet|erklärt|meint|betont|argumentiert|stellt fest)[,:]?\s*/i,
        // "XY sagt/behauptet, dass..." — speaker + speech verb
        /^\S+(?:\s+\S+){0,3}\s+(?:sagt|behauptet|erklärt|meint|betont|argumentiert|stellt fest|weiß|wissen|findet|glaubt)[,:]?\s+(?:dass\s+)?/i,
        // "Es wird behauptet / Man sagt / Es heißt..."
        /^(?:Es\s+(?:ist|wird)\s+behauptet|Man\s+sagt|Es\s+heißt)[,:]?\s+(?:dass\s+)?/i,
        // "Im Video wird gesagt/behauptet/erklärt, dass..."
        /^(?:Im\s+Video\s+(?:wird\s+)?(?:gesagt|behauptet|erklärt))[,:]?\s+(?:dass\s+)?/i,
    ];

    // English attribution patterns
    const enPatterns = [
        // "According to X, ..." — with comma
        /^According\s+to\s+[^,]+[,:]\s*/i,
        // "X says/claims/states that..." — speaker + speech verb
        /^\S+(?:\s+\S+){0,3}\s+(?:says|claims|states|argues|asserts|maintains|believes)[,:]?\s+(?:that\s+)?/i,
        // "It is said/claimed/alleged/reported that..."
        /^(?:It\s+is\s+(?:said|claimed|alleged|reported))[,:]?\s+(?:that\s+)?/i,
    ];

    const allPatterns = [...dePatterns, ...enPatterns];
    for (const pattern of allPatterns) {
        const stripped = text.replace(pattern, '');
        if (stripped !== text && stripped.length > 10) {
            console.log(`[FAKTCHECK BG] ✂️ Attribution stripped: "${text.slice(0, 60)}" → "${stripped.slice(0, 60)}"`);
            text = stripped;
            // Capitalize first letter after stripping
            text = text.charAt(0).toUpperCase() + text.slice(1);
            break;  // Only strip once
        }
    }

    return text;
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
    } else if (/\b(verdict|urteil|ergebnis)\s*[:=]\s*"?(missing_context|fehlender[_ ]kontext|whataboutism)/i.test(t)) {
        verdict = 'missing_context'; confidence = 0.75;
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


function validateVerification(data, claimType = 'factual', claimText = '') {
    const validVerdicts = ['true', 'mostly_true', 'partially_true', 'mostly_false', 'false', 'unverifiable', 'unverified', 'misleading', 'opinion', 'deceptive', 'missing_context'];
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
        // Use resolved domain (from redirect resolution) for tier/meta lookup
        const lookupUrl = s.domain ? `https://${s.domain}` : s.url;
        const tier = s.tier || getSourceTier(lookupUrl);
        const meta = getSourceMeta(lookupUrl);
        const typeIcon = meta?.type && sourceRegistry?.typeIcons?.[meta.type];
        return {
            title: String(s.title || meta?.label || 'Source').slice(0, 100),
            url: s.url,
            domain: s.domain || '',
            tier,
            icon: typeIcon?.icon || '',
            sourceType: typeIcon?.label || ''
        };
    });

    const tier1Count = tieredSources.filter(s => s.tier === 1).length;
    const tier2Count = tieredSources.filter(s => s.tier === 2).length;
    const totalSources = tieredSources.length;

    // V5.4 STABLE: Build evidence chain for deterministic confidence
    // Sources found by Google Search SUPPORT the verdict — they don't contradict it.
    // V_c conflict detection is separate (from evidence_quotes debate analysis, not verdict polarity)
    const evidenceChain = tieredSources.map(s => ({
        url: s.url,
        tier: s.tier,
        timestamp: s.timestamp || null,
        sentiment: 'supporting'  // Grounding sources back the verdict by definition
    }));
    const calibrated = calculateConfidence(evidenceChain);

    // V5.4 STABLE MODULE 2: Source Sanitization — remove YouTube + Wikipedia from confidence/counting
    // Use resolved domain field (handles Vertex AI redirect URLs correctly)
    const sanitizedSources = tieredSources.filter(s => {
        const host = (s.domain || '').toLowerCase();
        if (host) {
            return !host.includes('youtube.com') && !host.includes('youtu.be')
                && !host.includes('wikipedia.org');
        }
        // Fallback to URL parsing if no domain field
        try {
            const urlHost = new URL(s.url).hostname.toLowerCase();
            return !urlHost.includes('youtube.com') && !urlHost.includes('youtu.be')
                && !urlHost.includes('wikipedia.org');
        } catch { return true; }
    });

    // ─── V5.5+: IFCN NUANCED CONFIDENCE — temporal decay + relevance ───
    const factChecks = Array.isArray(data._factChecks) ? data._factChecks : [];
    const ifcnReviews = factChecks.flatMap(fc => (fc.reviews || []).filter(r => r.url));
    let ifcnOverrideApplied = false;
    let ifcnConflict = false;
    let ifcnConfidence = 0;
    let ifcnVerdict = null;
    let ifcnStale = false;

    if (ifcnReviews.length > 0) {
        const review = ifcnReviews[0];

        // ─ Temporal Decay λ(t) ─
        const reviewDate = review.date ? new Date(review.date) : null;
        const monthsAgo = reviewDate ? (Date.now() - reviewDate.getTime()) / (1000 * 60 * 60 * 24 * 30) : 12;
        let lambda = 1.0;
        if (monthsAgo > 18) { lambda = 0.3; ifcnStale = true; }
        else if (monthsAgo > 6) { lambda = 0.7; }

        // ─ Match Relevance ρ ─
        // Check if IFCN claimText closely matches our claim (from parent factCheck object)
        const ifcnClaimText = (factChecks[0]?.claimText || '').toLowerCase();
        const ourClaim = (data._claim || '').toLowerCase();
        const rho = (ifcnClaimText && ourClaim && ifcnClaimText.includes(ourClaim.slice(0, 40))) ? 1.0 : 0.7;

        // ─ Dynamic IFCN Score ─
        ifcnConfidence = 0.95 * rho * lambda;
        console.log(`[FAKTCHECK BG] 🏆 IFCN: C=${ifcnConfidence.toFixed(2)} (ρ=${rho}, λ=${lambda}, age=${monthsAgo.toFixed(0)}mo, stale=${ifcnStale})`);

        // Map textual IFCN rating to verdict
        const ifcnRating = (review.rating || '').toLowerCase();
        if (/false|falsch|fake|wrong|pants on fire|unwahr|incorrect/i.test(ifcnRating)) {
            ifcnVerdict = 'false';
        } else if (/true|wahr|correct|richtig|accurate/i.test(ifcnRating)) {
            ifcnVerdict = 'true';
        } else if (/half|partly|teilw|mixture|gemischt|misleading/i.test(ifcnRating)) {
            ifcnVerdict = 'partially_true';
        }

        // ─ Conflict Detection: AI vs IFCN ─
        if (ifcnVerdict && verdict && ifcnVerdict !== verdict) {
            // Verdicts disagree — flag conflict, do NOT override
            ifcnConflict = true;
            console.log(`[FAKTCHECK BG] ⚠️ IFCN CONFLICT: AI says "${verdict}" but IFCN says "${ifcnVerdict}"`);
            explanation = `[⚠️ Conflict: IFCN rated "${review.rating}" (${review.publisher}), AI verdict: "${verdict}"] ${explanation || ''}`;
            // Take the higher confidence but keep AI verdict when conflict
            if (ifcnConfidence > confidence) confidence = ifcnConfidence;
        } else if (!ifcnStale) {
            // Non-stale, non-conflicting IFCN — apply override
            ifcnOverrideApplied = true;
            confidence = ifcnConfidence;
            if (ifcnVerdict) verdict = ifcnVerdict;
            explanation = `[IFCN: "${review.rating}" — ${review.publisher}] ${explanation || ''}`;
        } else {
            // Stale IFCN (>18mo) — context only, no override
            console.log('[FAKTCHECK BG] 📅 IFCN STALE (>18mo): context only, no override');
            explanation = `[📅 IFCN (Context Only, ${monthsAgo.toFixed(0)}mo old): "${review.rating}" — ${review.publisher}] ${explanation || ''}`;
        }
    }

    // Use calibrated confidence (only if IFCN didn't already set it)
    const llmPositive = ['true', 'mostly_true'].includes(verdict);
    const originalLlmPositive = llmPositive; // Preserve BEFORE any downgrades
    if (!ifcnOverrideApplied && calibrated > 0) {
        confidence = Math.min(Math.max(calibrated, 0.1), 0.95);
    }

    // ─── C3 VERDICT-CONFIDENCE COHERENCE GUARDRAIL ───
    // A definitive verdict with very low confidence is an oxymoron.
    // Floor: if verdict is true/false, confidence must be ≥ 0.4
    // Ceiling: if verdict is unverifiable, confidence must be ≤ 0.4
    if (!ifcnOverrideApplied) {
        if (['true', 'false'].includes(verdict) && confidence < 0.4) {
            console.log(`[FAKTCHECK BG] 📐 C3 COHERENCE: ${verdict.toUpperCase()} with conf=${confidence} → floor to 0.4`);
            confidence = 0.4;
        }
        if (verdict === 'unverifiable' && confidence > 0.4) {
            console.log(`[FAKTCHECK BG] 📐 C3 COHERENCE: UNVERIFIABLE with conf=${confidence} → cap to 0.4`);
            confidence = 0.4;
        }
    }

    // Downgrade verdict if sources don't back it up (skip if IFCN override)
    if (!ifcnOverrideApplied) {
        if (llmPositive && sanitizedSources.length === 0 && tier1Count === 0) {
            verdict = 'unverifiable';
            confidence = 0.10;
        } else if (llmPositive && sanitizedSources.length === 1 && sanitizedSources[0]?.tier >= 4) {
            verdict = 'partially_true';
            confidence = Math.min(confidence, 0.60);
        }
    }

    // Self-referential source malus — party/propaganda sites only (skip if IFCN override)
    const partyPatterns = /fpoe\.at|fpö|fpoetv|tv\.at\/fpoe|social[-\s]?media/i;
    const externalSources = sanitizedSources.filter(s => !partyPatterns.test(s.url || ''));
    const onlySelfRef = totalSources > 0 && externalSources.length === 0;

    if (onlySelfRef && !ifcnOverrideApplied) {
        console.log('[FAKTCHECK BG] ⚠️ GROUND TRUTH: Only self-referential sources — penalty');
        confidence = 0.10;
        verdict = 'unverifiable';
        explanation = (explanation || '') + ' [Ground Truth: Keine unabhängigen externen Quellen.]';
    }

    // TIER-1 OVERRIDE (skip if IFCN override already took priority)
    const tier1Sources = tieredSources.filter(s => s.tier === 1);
    if (!ifcnOverrideApplied && tier1Sources.length > 0 && originalLlmPositive && verdict !== 'false') {
        console.log('[FAKTCHECK BG] 🏛️ TIER-1 OVERRIDE: Official sources contradict claim — forcing FALSE');
        verdict = 'false';
        confidence = Math.max(confidence, 0.85);
        explanation = (explanation || '') + ' [Tier-1 Übersteuerung: Offizielle Quelle widerspricht der Behauptung.]';
    }

    // V5.4: CONTRADICTION OVERRIDE (Math Guardrail)
    // When judge says "unverifiable" but external sources exist AND claim contains specific numbers,
    // sources found different data → that's a contradiction, not "insufficient data"
    const hasSpecificNumbers = /\b(Platz|Rang|Stelle|place|rank)\s+\d+|\b\d+[.,]\d+\s*%|\b\d+\s*(Milliarden|Mrd|Billionen|trillion|billion|million|Millionen)|\bPlatz\s+\d+\s+von\s+\d+/i.test(claimText);
    if (verdict === 'unverifiable' && totalSources > 0 && externalSources.length > 0 && hasSpecificNumbers) {
        console.log('[FAKTCHECK BG] 📐 MATH GUARDRAIL: Numeric claim unverifiable with contradicting evidence — forcing FALSE');
        verdict = 'false';
        confidence = Math.max(confidence, 0.70);
        explanation = (explanation || '') + ' [Math Guardrail: Spezifische Zahlenangabe widerspricht den gefundenen Daten.]';
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

    // ─── V5.5: Build structured evidence_chain ───
    const evidenceQuoteMap = new Map();
    if (Array.isArray(data._evidenceQuotes)) {
        for (const eq of data._evidenceQuotes) {
            if (eq.url && !evidenceQuoteMap.has(eq.url)) evidenceQuoteMap.set(eq.url, eq.quote || '');
        }
    }

    const evidence_chain = sanitizedSources.map(s => ({
        url: s.url,
        source_name: s.title || '',
        is_ifcn: false,
        snippet: evidenceQuoteMap.get(s.url) || '',
        tier: s.tier,
        sentiment: 'supporting'
    }));

    // Prepend IFCN entries (pinned at top)
    for (const review of ifcnReviews) {
        evidence_chain.unshift({
            url: review.url,
            source_name: review.publisher || 'Fact-Checker',
            is_ifcn: true,
            snippet: review.title || review.rating || '',
            tier: 1,
            sentiment: /false|falsch|fake|wrong|unwahr/i.test(review.rating || '') ? 'contradicting' : 'supporting'
        });
    }

    return {
        verdict,
        displayVerdict: displayMap[verdict] || 'unverifiable',
        confidence,
        explanation,
        key_facts: Array.isArray(data.key_facts) ? data.key_facts.filter(f => typeof f === 'string').slice(0, 5) : [],
        sources: sanitizedSources,         // backward compat
        evidence_chain,                    // V5.5: structured format
        timeline: timeline,
        is_causal: isCausalClaim,
        source_quality: ifcnReviews.length > 0 ? 'ifcn' : tier1Count > 0 ? 'high' : tier2Count > 0 ? 'medium' : 'low',
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
        fact_checks: Array.isArray(data._factChecks) ? data._factChecks : [],
        ifcn_override: ifcnOverrideApplied,
        ifcn_conflict: ifcnConflict,
        ifcn_stale: ifcnStale,
        ifcn_confidence: ifcnConfidence > 0 ? ifcnConfidence : null,
        ifcn_verdict: ifcnVerdict
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

// ─── Gemini JSON Mode (for structured judge output) ───
// Same as callGemini but with response_mime_type: application/json
// Falls back to callGemini on failure for resilience.
async function callGeminiJSON(apiKey, prompt, responseSchema, retryAttempt = 0) {
    const url = `${GEMINI_API_BASE}/${DEFAULT_MODEL}:generateContent?key=${apiKey}`;

    console.log('[FAKTCHECK BG] ----------------------------------------');
    console.log('[FAKTCHECK BG] Calling Gemini API (JSON mode)');
    console.log('[FAKTCHECK BG] Prompt length:', prompt.length);

    const generationConfig = {
        temperature: 0.1,
        maxOutputTokens: 4096,
        response_mime_type: 'application/json'
    };
    if (responseSchema) {
        generationConfig.response_schema = responseSchema;
    }

    const body = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        // Retry on 503/429
        if (response.status === 503 || response.status === 429) {
            const retryCount = retryAttempt + 1;
            if (retryCount <= 3) {
                const delay = Math.pow(2, retryCount) * 1000;
                console.log(`[FAKTCHECK BG] JSON mode retry ${retryCount}/3 in ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
                return callGeminiJSON(apiKey, prompt, responseSchema, retryCount);
            }
        }

        if (!response.ok) {
            await response.text(); // consume body
            console.warn('[FAKTCHECK BG] JSON mode HTTP', response.status, '— falling back to text mode');
            // Fallback to regular callGemini
            return { _fallback: true, _text: await callGemini(apiKey, prompt) };
        }

        const data = await response.json();
        if (data.error) {
            console.warn('[FAKTCHECK BG] JSON mode API error — falling back to text mode');
            return { _fallback: true, _text: await callGemini(apiKey, prompt) };
        }

        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (!text) {
            console.warn('[FAKTCHECK BG] JSON mode empty response — falling back');
            return { _fallback: true, _text: await callGemini(apiKey, prompt) };
        }

        // Parse JSON response
        const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
        console.log('[FAKTCHECK BG] JSON mode response:', cleaned.slice(0, 200));

        try {
            return JSON.parse(cleaned);
        } catch {
            console.warn('[FAKTCHECK BG] JSON parse failed — falling back to text mode');
            return { _fallback: true, _text: cleaned };
        }
    } catch (error) {
        console.error('[FAKTCHECK BG] JSON mode fetch error:', error.message, '— falling back');
        try {
            return { _fallback: true, _text: await callGemini(apiKey, prompt) };
        } catch {
            return { _fallback: true, _text: '' };
        }
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
        // NOTE: Gemini's grounding API returns redirect URLs (vertexaisearch.cloud.google.com/grounding-api-redirect/...)
        // The actual source domain is in web.title (e.g. "britannica.com"). We resolve this for correct tier lookup.
        if (groundingMeta?.groundingChunks) {
            groundingSources = groundingMeta.groundingChunks
                .filter(c => c.web?.uri)
                .map(c => {
                    const rawUrl = c.web.uri;
                    const titleText = c.web.title || '';

                    // Detect Vertex AI redirect URLs and resolve real domain from title
                    let realDomain = '';
                    let isRedirect = false;
                    try {
                        const urlHost = new URL(rawUrl).hostname;
                        isRedirect = urlHost.includes('vertexaisearch.cloud.google.com') ||
                            urlHost.includes('googleapis.com');
                    } catch { /* not a valid URL */ }

                    if (isRedirect && titleText) {
                        // title contains the real domain (e.g. "britannica.com")
                        realDomain = titleText.replace(/^www\./, '').toLowerCase();
                    } else {
                        try { realDomain = new URL(rawUrl).hostname.replace(/^www\./, ''); } catch { realDomain = titleText; }
                    }

                    return {
                        title: titleText || 'Source',
                        url: rawUrl,
                        domain: realDomain,
                        tier: getSourceTier(isRedirect ? `https://${realDomain}` : rawUrl)
                    };
                });
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
        `# FAKTCHECK v5.4 — Stage 2: Semantic Core Extraction
${groundingContext}

## SYSTEM-PROMPT
Du bist ein Deterministischer Fakten-Extraktor. Du extrahierst NUR Aussagen, die den Zustand der Welt beschreiben — NICHT die Wünsche des Sprechers.

🔑 KERNEL-REGEL (Primäre Heuristik):
"Extrahiere NUR dann, wenn die Behauptung wahr bleibt, selbst wenn der Sprecher nie existiert hätte."
Wenn die Behauptung nur im Zusammenhang mit dem Sprecher Sinn ergibt → SKIP.

### 1. SEMANTIC STRIPPING (KRITISCH!)
Entferne ALLE Einleitungen wie "Laut...", "Der Sprecher sagt...", "Kickl behauptet...", "Im Video wird erwähnt...", "Wisst ihr, wo wir liegen?".
Wandle jede Aussage in eine neutrale, direkte Tatsachenbehauptung um.
Die Tatsache wird von der Propaganda-Hülle getrennt.

BEISPIELE FÜR STRIPPING:
- "Wisst ihr, wo wir liegen? Am sensationellen Platz 185." → "Österreich liegt beim Wirtschaftswachstum weltweit auf Platz 185 von 191."
- "Laut FPÖ TV liegt Österreich auf Platz 185" → "Österreich liegt beim Wirtschaftswachstum auf Platz 185 von 191 Ländern"
- "Kickl sagt, die Inflation beträgt 10%" → "Die Inflation in Österreich beträgt 10%"
- "Der Kanzler behauptet, die Arbeitslosigkeit sinkt" → "Die Arbeitslosigkeit in Österreich sinkt"

### 1.5 SARKASMUS-DETEKTOR (Inversionsregel)
Wenn ein Sprecher Sarkasmus verwendet, INVERTIERE die Aussage und extrahiere die implizierte Behauptung.
- Erkenne sarkastische Marker: übertriebene Zustimmung, offensichtliche Ironie, "Na klar", "Sicher doch", "Genau, weil..."
- INVERTIERE den Claim und extrahiere den faktischen Kern.

BEISPIELE:
- "Na klar, die Pharma will nur unsere Gesundheit" → factual_core: "Pharmaindustrie priorisiert Profit über Patientenwohl", type: "opinion"
- "Ja genau, die Regierung spart bei sich selbst" → factual_core: "Die Regierung spart nicht bei den eigenen Ausgaben", type: "factual"

### 1.6 ANTI-TAUTOLOGIE-FILTER (Selbstbehauptungen aussortieren)
Extrahiere KEINE Aussagen der folgenden Typen:

1. **Selbstbewertung / Branding:** "Dieses Treffen ist eine Machtdemonstration." / "Wir sind eine patriotische Bewegung." → SKIP (Selbstetikettierung)
2. **Subjektive Bewertung OHNE Daten:** "Die Regierung ist eine Fehlkonstruktion." → SKIP.
   ABER: "Fehlkonstruktion, weil die Schulden um 10% gestiegen sind" → Extrahiere NUR "Schulden sind um 10% gestiegen".
3. **Narrative Behauptungen:** "Jörg Haider war ein Schutzpatron." → SKIP (historische Meinung, nicht falsifizierbar)
4. **Meta-Kommentar / Populismus:** "Das Volk steht hinter uns." / "Wir sind die Stimme des Volkes." → SKIP (undefiniert, nicht verifizierbar)

REGEL: Extrahiere nur Behauptungen, die durch unabhängige Daten WIDERLEGT werden können.

### 1.7 KONTEXT-FENSTER
Wenn der Text einen [Context]-Block enthält, verwende diesen NUR zur Auflösung von Pronomen. Extrahiere NIEMALS Behauptungen aus dem [Context]-Block.

### 2. ENTITY HYDRATION
Korrigiere unvollständige oder falsche Eigennamen basierend auf dem Kontext:
- Ersetze ALLE Pronomen durch konkrete Namen
- Wenn von "Stocker" im Kontext des Bundeskanzleramts die Rede ist, verwende immer den vollen Namen "Christian Stocker"
- Ergänze Kontext aus Video-Titel/Gremium
- ⚠️ NAMEN-TREUE: Bevorzuge die Schreibweise aus den ERKANNTEN PERSONEN (Metadaten). Bei offensichtlichen ASR-Fehlern (z.B. "BIOS" → "Pius", "Christoph S." → "Christian Stocker") korrigiere den Namen basierend auf Kontext und Metadaten. NIEMALS Namen frei erfinden!

### 2.5 PHONETISCHE ASR-KORREKTUR (Intelligence-First)
Du erhältst fehlerhafte ASR-Transkripte (Automatic Speech Recognition). Identifiziere und repariere phonetische Fehlhörungen.

REGELN:
- Phonetische Ähnlichkeit: Erkenne Wörter, die phonetisch ähnlich zu kontextuell logischen Begriffen sind
- N-Gramm-Korrektur: Repariere geteilte Komposita (z.B. "Lohn stück kosten" → "Lohnstückkosten")
- Mehrdeutigkeit: Wenn ein Term mehrdeutig ist, prüfe den Satzkontext. NICHT korrigieren, wenn der Originalbegriff im Kontext gültig ist!

INTERNATIONALE KORREKTUR-TABELLE (NUR anwenden, wenn der Kontext es rechtfertigt):
| ASR-Fehler | Korrektur | Kontextueller Trigger |
| "Griech(ang/gang)" | Kriechgang | Wirtschaftswachstum, Tempo, Schneckentempo |
| "In flation" / "In relation" | Inflation | Geldpolitik, Preisanstieg |
| "A missionen" / "E mission" | Emissionen | Klimawandel, CO2, Umwelt |
| "Lohn stück..." | Lohnstückkosten | Arbeitsmarkt, industrieller Wettbewerb |
| "Statue" | Statut | Gesetzesrahmen, Gesetzgebung |
| "BIOS" + Nachname | Pius + Nachname | Person, religiöser Vorname, wenn Metadaten bestätigen |
| Vorname-Fehlhörung | Metadaten-Schreibweise | wenn ERKANNTE PERSONEN den korrekten Namen enthalten |

⚠️ GUARDRAIL: "Griechisch" im Kontext internationaler Politik → NICHT zu "Kriechgang" korrigieren!

### 3. FALSIFIZIERBARKEITSTEST (VOR dem Binärfilter!)
Frage dich bei JEDEM Claim: "Kann diese Aussage mit externen Daten widerlegt werden?"
- Enthält "soll/muss/sollte" (Soll/Muss) → Es ist eine FORDERUNG → SKIP
- Enthält "will/werde/werden" (Wollen/Werden) → Es ist ein VERSPRECHEN → SKIP
- Enthält "ist/war/hat/beträgt" (Ist/War) → Es ist eine FAKTENBEHAUPTUNG → WEITER PRÜFEN

| Verbale Kategorie | Beispiel | Aktion |
| Imperativ/Modal | "Steuern müssen runter" | SKIP (Forderung) |
| Optativ/Absicht | "Der Sektor soll wachsen" | SKIP (Wunsch) |
| Futur/Versprechen | "Wir werden das tun" | SKIP (Polit. Versprechen) |
| Indikativ (Präs./Verg.) | "Österreich hat ein Defizit von..." | PROCESS (Faktenbehauptung) |

### 4. BINÄRFILTER (Precision > Recall)
Klassifiziere JEDEN verbleibenden identifizierten Claim:
- **PROCESS**: Harte Fakten, Prozentsätze, Rankings, Gesetze, verifizierbare historische Ereignisse, Umfragedaten
- **SKIP**: Reine Metaphern, persönliche Anekdoten, subjektive Meinungen ohne Faktengehalt

🚫 HARTES DISCARD (immer SKIP):
- **Persona/Handlungen**: "Ich habe gesehen", "Ich fühle", "Ich habe angerufen", "Wir haben beschlossen"
- **Attributions-Hüllen**: "Der Sprecher behauptet", "Partei X sagt", "Der Präsident fordert"
- **Subjektive Adjektive als Kern**: "bürokratisch", "selbstgefällig", "freiheitsfeindlich", "volksfeindlich"
- **Modale Forderungen**: Jeder Satz mit "muss", "soll", "sollte", "müsste" als Kern

🚫 SELBSTREFERENZ-FILTER:
Wenn der factual_core den Sprecher als Subjekt hat → SKIP.
Muster: (Ich|Wir|Der Sprecher) + (habe|will|finde|bin|sehe|glaube|meine)
Beispiel: "Ich habe die Rede gesehen" → SKIP (Anekdote, kein Daten-Kernel)

🚫 KANAL/PLATFORM-SELBSTPROMO FILTER:
Wenn der Claim den eigenen Kanal, die eigene Sendung oder Plattform bewirbt → SKIP.
Muster: (Unser Kanal|Der Kanal|Die Sendung|Unsere Zuschauer|Unser Publikum) + (hat gewonnen|bietet|erreicht|hat Millionen|ist gewachsen)
Beispiel: "Unser Kanal hat Millionen Zuschauer gewonnen" → SKIP (Plattform-Eigenwerbung)
Beispiel: "Der Kanal bietet eine alternative Sichtweise" → SKIP (Selbsteinschätzung)

🚫 SPRECHER-BIOGRAFIE FILTER:
Wenn der Claim nur beschreibt WER der Sprecher ist/war (Titel, Rolle, Position) → SKIP.
Muster: (Der Sprecher|Die Sprecherin) + (war|ist|wurde) + (Direktor|Leiter|Chef|Vorsitzender|Mitglied)
Beispiel: "Der Sprecher war Anfang der 2000er im ORF-Kuratorium" → SKIP (Biografie, keine falsifizierbare Behauptung)
Beispiel: "Der Sprecher ist zum zweiten Mal im Stiftungsrat" → SKIP (persönliche Bio)

🚫 ABSICHTSERKLÄRUNGEN / POLITISCHE VERSPRECHEN FILTER:
Wenn der Claim ein Versprechen, eine Prognose oder Absichtserklärung des Sprechers über seine eigene Seite ist → SKIP.
Diese sind nicht falsifizierbar — der Sprecher erklärt was er/seine Seite TUN WIRD, nicht was IST.
Muster: (Wir werden|Russland wird|Die Ziele werden|Man wird) + (erreichen|befreien|siegen|durchsetzen|schaffen)
Beispiel: "Russland wird die Befreiung seiner historischen Länder erreichen" → SKIP (Absichtserklärung, keine Tatsache)
Beispiel: "Die Ziele der Militäroperation werden bedingungslos erreicht" → SKIP (Politisches Versprechen)
Beispiel: "Die strategische Parität bleibt erhalten" → SKIP (Selbstbehauptung über eigene Stärke)
Schlüssel: Wenn NUR der Sprecher selbst die Autorität für die Behauptung ist → SKIP.

⚠️ Es ist BESSER einen Claim zu SKIPPEN als metaphorischen Müll zu verarbeiten!

📊 AUDIT-BEISPIELE (Deterministischer Fakten-Extraktor):
| Snippet | Status | Grund |
| "FPÖ erlebt Aufschwung in Umfragen" | PROCESS | Externes Daten-Kernel (Umfragewerte) |
| "Steuern müssen gesenkt werden" | SKIP | Politische Forderung (Modalverb) |
| "Lohnnebenkosten müssen gesenkt werden" | SKIP | Politische Forderung (Modalverb) |
| "Der öffentliche Sektor muss kleiner werden" | SKIP | Ideologische Präferenz |
| "Österreich ist momentan ein Intensivpatient" | SKIP | Metapher |
| "Österreich hat ein Defizit von 3.7%" | PROCESS | Indikativ-Faktenbehauptung |
| "Ich habe die Rede des Präsidenten gesehen" | SKIP | Selbstreferenz |
| "EU-Genehmigung für Grenzkontrollen" | PROCESS | Institutioneller/rechtlicher Fakt |

### 5. FACTUAL CORE DEDUPLICATION (Stage 2 Dedup)
Extrahiere die **zugrundeliegende Tatsachenbehauptung** aus verschiedenen rhetorischen Framings.
Wenn der gleiche Fakt mehrmals mit unterschiedlicher Formulierung vorkommt → EINE ClaimObject mit mehreren Einträgen in "occurrences[]".

BEISPIEL:
- "Wir befinden uns im Kriechgang" (12:04) + "mickrige 1 Prozent Wachstum" (45:10)
  → factual_core: "Österreichs BIP-Wachstum beträgt ca. 1%."
  → occurrences: [{timestamp_hint: "12:04", rhetorical_framing: "Wirtschaftlicher Schneckengang"}, {timestamp_hint: "45:10", rhetorical_framing: "1% Wachstum"}]

### 6. ATOMISIERUNG
Erstelle für jede einzelne Fakten-Behauptung einen eigenen Eintrag.
Vermische KEINE Meinungen mit Fakten. Meinungen erhalten type: "opinion" UND status: "SKIP".
Forderungen ("muss", "soll") erhalten type: "opinion" UND status: "SKIP".

### 7. QUERY DECOMPOSITION
Für jeden PROCESS-Claim generiere 2-3 kurze Such-Queries (3-6 Wörter):
- PRIORISIERE offizielle Quellen: Statistik Austria, WIFO, IMF, Eurostat, Weltbank
- Kombiniere Schlüssel-Entitäten für Google-Suche

BEISPIEL:
factual_core: "Österreich liegt beim Wirtschaftswachstum auf Platz 185 von 191"
search_queries: ["IMF World Economic Outlook GDP growth ranking 2026", "WIFO Österreich BIP Wachstum Prognose 2026", "Statistik Austria Wirtschaftswachstum"]

### 8. TYPE DETECTION
- "factual": Reine Faktenbehauptung
- "causal": Enthält "weil/aufgrund/verursacht/führte zu"
- "opinion": Werturteil/Meinung einer Person (z.B. "X kritisiert", "Y fordert")

## Text:
"${sanitized.slice(0, 4000)}"

## Output (NUR JSON-Array):
[{
  "status": "PROCESS",
  "factual_core": "Atomare Fakten-Behauptung OHNE Sprecher-Attribution (phonetisch korrigiert)",
  "category": "ECONOMICS|POLITICS|SCIENCE|STATISTICS",
  "importance": 3,
  "occurrences": [{
    "timestamp_hint": "ungefähre Position im Transkript",
    "rhetorical_framing": "Wie der Sprecher es formuliert hat",
    "raw_snippet": "Originaltext aus dem ASR-Transkript"
  }],
  "phonetic_repairs": [{"original": "ASR-Fehler", "corrected": "Korrektur"}],
  "search_queries": ["Query1 3-6 Wörter", "Query2 3-6 Wörter"],
  "type": "factual|causal|opinion"
}]

Keine Claims? Antworte: []` :
        `# FAKTCHECK v5.4 — Stage 2: Semantic Core Extraction
${groundingContext}

## SYSTEM PROMPT
You are a Deterministic Fact-Extractor. You extract ONLY statements that describe the state of the world — NOT the desires of the speaker.

🔑 KERNEL RULE (Primary Heuristic):
"Extract ONLY if the claim remains true even if the speaker never existed."
If the claim only makes sense in the context of the speaker → SKIP.

### 1. SEMANTIC STRIPPING (CRITICAL!)
Remove ALL introductions like "According to...", "The speaker says...", "X claims...", "In the video it is mentioned...".
Convert every statement into a neutral, direct factual claim.
Separate the fact from the propaganda shell.

EXAMPLES:
- "According to the President, unemployment is at 3%" → "Unemployment in the US is at 3%"
- "The CEO claims revenue doubled" → "Company X revenue doubled"
- "Sources say the deal is worth $5B" → "The deal is worth $5 billion"

### 1.5 SARCASM DETECTOR (Inversion Rule)
If a speaker uses sarcasm, INVERT the statement and extract the implied accusation.
- Detect sarcastic markers: exaggerated agreement, obvious irony, "Oh sure", "Yeah right", "Of course, because..."
- INVERT the claim and extract the factual core.

EXAMPLES:
- "Oh sure, Pharma only wants our health" → factual_core: "Pharmaceutical industry prioritizes profit over patient health", type: "opinion"
- "Of course the government cuts its own spending" → factual_core: "The government does not cut its own spending", type: "factual"

### 1.6 ANTI-TAUTOLOGY FILTER (Reject Self-Asserting Claims)
Do NOT extract statements of the following types:

1. **Self-Assessments / Branding:** "This meeting is a demonstration of power." / "We are a patriotic movement." → SKIP (self-labeling)
2. **Subjective Labels WITHOUT Data:** "The government is a disaster." → SKIP.
   BUT: "Disaster because debt rose 10%" → Extract ONLY "Debt rose 10%".
3. **Narrative Assertions:** "Jörg Haider was a patron protector." → SKIP (historical opinion, not falsifiable)
4. **Meta-Commentary / Populism:** "The people stand behind us." / "We are the voice of the people." → SKIP (undefined, unverifiable)

RULE: Only extract claims that can be proven WRONG by independent data.

### 1.7 CONTEXT WINDOW
If the text contains a [Context] block, use it ONLY for pronoun resolution. NEVER extract claims from the [Context] block.

### 2. ENTITY HYDRATION
Fix incomplete or incorrect proper names based on context:
- Replace ALL pronouns with concrete names
- Complete partial names using context (e.g., "Biden" → "Joe Biden")
- Add context from video title/description
- NAME FIDELITY: Prefer the spelling from RECOGNIZED PERSONS (Metadata). For obvious ASR errors (e.g., "BIOS" → "Pius", "Christoph S." → "Christian Stocker"), correct the name based on context and metadata. NEVER invent names!

### 2.5 PHONETIC ASR CORRECTION (Intelligence-First)
You receive noisy ASR (Automatic Speech Recognition) transcripts. Identify and repair phonetic mis-hearings.

RULES:
- Phonetic Similarity: Identify words phonetically similar to contextually logical terms
- N-Gram Repair: Fix split compound nouns (e.g., "unit labor costs" → "unit labor costs")
- Ambiguity Handling: If a term is ambiguous, check sentence context. Do NOT correct if the original term is valid in context!

INTERNATIONAL CORRECTION GUIDE (apply ONLY when context justifies):
| ASR Error | Correction | Contextual Trigger |
| "in flation" / "in relation" | inflation | monetary policy, price increases |
| "a missions" / "e mission" | emissions | climate, CO2, environment |
| "statue" | statute | legal frameworks, legislation |
| "pre-seed-ent" | precedent | legal, judicial context |
| "BIOS" + surname | Pius + surname | person name, religious first name, when metadata confirms |
| first-name mismatch | metadata spelling | when RECOGNIZED PERSONS contain the correct name |

⚠️ GUARDRAIL: "Greek" in the context of international politics → Do NOT correct to "creeping"!

### 3. FALSIFIABILITY TEST (BEFORE the Binary Filter!)
For EVERY claim ask: "Can this statement be proven false using only external data?"
- Contains "should/must/ought" → It is a DEMAND → SKIP
- Contains "will/want to/going to" → It is a PROMISE → SKIP
- Contains "is/was/has/amounts to" → It is a FACTUAL ASSERTION → CONTINUE CHECKING

| Verbal Category | Example | Action |
| Imperative/Modal | "Taxes must be lowered" | SKIP (Demand) |
| Optative/Intent | "The sector should grow" | SKIP (Wish) |
| Future/Promise | "We will do that" | SKIP (Political promise) |
| Indicative (Pres./Past) | "The deficit is 3.7%" | PROCESS (Factual assertion) |

### 4. BINARY FILTER (Precision > Recall)
Classify EVERY remaining identified claim:
- **PROCESS**: Hard facts, percentages, rankings, legal statutes, verifiable historical events, polling data
- **SKIP**: Pure metaphors, personal anecdotes, subjective opinions without factual content

🚫 HARD DISCARD (always SKIP):
- **Persona/Actions**: "I watched", "I feel", "I called", "We decided"
- **Attribution Shells**: "The speaker claims", "Party X says", "The President demands"
- **Subjective Adjectives as Core**: "bureaucratic", "self-satisfied", "hostile to freedom"
- **Modal Demands**: Any sentence with "must", "should", "ought to", "needs to" as its core

🚫 SELF-REFERENTIAL FILTER:
If the factual_core has the speaker as its subject → SKIP.
Pattern: (I|We|The speaker) + (watched|want|feel|am|see|believe|think)
Example: "I watched the President's speech" → SKIP (Anecdote, not a data kernel)

🚫 CHANNEL/PLATFORM SELF-PROMOTION FILTER:
If the claim promotes the speaker's own channel, show, or platform → SKIP.
Pattern: (Our channel|The channel|The speaker's channel|Our audience|Our viewers) + (gained|offered|reached|has millions|grew|provides)
Example: "RT channel gained hundreds of millions of viewers" → SKIP (Platform self-promotion)
Example: "The speaker's channel offered an alternative truthful point of view" → SKIP (Self-assessment)
Example: "Channels projects on social media reached 24 billion views" → SKIP (Self-promotion metric)
Example: "The channel provides its platform for journalists from all over the world" → SKIP (Self-branding)

🚫 SPEAKER BIOGRAPHY FILTER:
If the claim only describes WHO the speaker is/was (title, role, position) → SKIP.
Pattern: (The speaker|The host) + (was|is|became) + (director|head|chief|chairman|member|editor)
Example: "The speaker was the director of the Federal Security Service" → SKIP (Biography, not a falsifiable claim)
Example: "Margarita Simonyan is the editor-in-chief of Russia Today" → SKIP (Identity statement, not fact-checkable)

🚫 DECLARATIONS OF INTENT / POLITICAL PROMISES FILTER:
If the claim is a promise, prediction, or declaration of intent by the speaker about their own side → SKIP.
These are NOT falsifiable — the speaker is declaring what they/their side WILL DO, not what IS.
Pattern: (We will|Russia will|The goals will|Our forces will) + (achieve|liberate|prevail|maintain|ensure)
Example: "Russia will achieve the liberation of its historical lands" → SKIP (Declaration of intent, not a fact)
Example: "The goals of the special military operation will unconditionally be achieved" → SKIP (Political promise)
Example: "Strategic parity remains Russia's armed forces" → SKIP (Self-assertion of own strength)
Key test: If ONLY the speaker themselves is the authority for the claim → SKIP.

⚠️ It is BETTER to SKIP a claim than to process metaphorical junk!

📊 AUDIT EXAMPLES (Deterministic Fact-Extractor):
| Snippet | Status | Reason |
| "Party experiencing a rise in polls" | PROCESS | External data kernel (polling) |
| "Taxes must be lowered" | SKIP | Political demand (modal verb) |
| "The public sector must shrink" | SKIP | Ideological preference |
| "The country is currently an intensive care patient" | SKIP | Metaphor |
| "The deficit is 3.7% of GDP" | PROCESS | Indicative factual assertion |
| "I watched the President's speech" | SKIP | Self-reference |
| "EU approval for border controls" | PROCESS | Institutional/legal fact |

### 5. FACTUAL CORE DEDUPLICATION (Stage 2 Dedup)
Extract the **underlying factual claim** from different rhetorical framings.
If the same fact appears multiple times with different wording → ONE ClaimObject with multiple entries in "occurrences[]".

EXAMPLE:
- "Economy is at a snail's pace" (12:04) + "mere 1 percent growth" (45:10)
  → factual_core: "GDP growth is approximately 1%."
  → occurrences: [{timestamp_hint: "12:04", rhetorical_framing: "Economic snail's pace"}, {timestamp_hint: "45:10", rhetorical_framing: "1% growth"}]

### 6. ATOMIZATION
Create a separate entry for each individual factual claim.
NEVER mix opinions with facts. Opinions get type: "opinion" AND status: "SKIP".
Demands ("must", "should") get type: "opinion" AND status: "SKIP".

### 7. QUERY DECOMPOSITION
For each PROCESS claim, generate 2-3 short search queries (3-6 words):
- PRIORITIZE official sources: national statistics offices, IMF, World Bank, Eurostat
- Combine key entities for Google search

Text: "${sanitized.slice(0, 4000)}"

Respond ONLY with JSON array:
[{
  "status": "PROCESS",
  "factual_core": "Atomic factual claim WITHOUT speaker attribution (phonetically corrected)",
  "category": "ECONOMICS|POLITICS|SCIENCE|STATISTICS",
  "importance": 3,
  "occurrences": [{
    "timestamp_hint": "approximate position in transcript",
    "rhetorical_framing": "How the speaker framed it",
    "raw_snippet": "Original ASR transcript text"
  }],
  "phonetic_repairs": [{"original": "ASR error", "corrected": "Correction"}],
  "search_queries": ["Query1", "Query2"],
  "type": "factual|causal|opinion"
}]

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
                claim.factual_core = text;  // v5.4+: keep in sync
            }
        }

        // V5.4: Post-extraction attribution stripping (code-level guarantee)
        for (const claim of validated) {
            claim.claim = stripAttribution(claim.claim);
            claim.factual_core = claim.claim;  // v5.4+: keep in sync
        }

        console.log('[FAKTCHECK BG] ========== RESULT ==========');
        console.log('[FAKTCHECK BG] Extracted', validated.length, 'claims');
        validated.forEach((c, i) => console.log(`[FAKTCHECK BG]   ${i + 1}. [${c.status}] ${c.claim.slice(0, 60)}...`));
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

async function searchOnly(claimText, apiKey, claimCategory = '', claimType = 'factual') {
    console.log('[FAKTCHECK BG] ── STEP 1: researchAndSummarize ──');
    const sanitized = sanitize(claimText, 1000);

    // V5.5: Category-specific search strategies
    let searchStrategy = '';
    if (claimCategory === 'SCIENCE') {
        searchStrategy = `\n- CONSENSUS CHECK: Search for "scientific consensus on [topic]" or "meta-analysis [topic]". Do NOT rely on single studies.`;
    }
    // Detect temporal/trend claims
    const hasTemporal = /\b(since|seit|yesterday|gestern|last (week|month|year)|letzte[ns]? (Woche|Monat|Jahr)|short-term|kurzfristig|recently|kürzlich|in den letzten)\b/i.test(claimText);
    if (hasTemporal) {
        searchStrategy += `\n- LONG-TERM TREND: This claim references a short-term change. Also search for the 5-10 year trend to provide context.`;
    }

    const prompt = `Research this claim thoroughly using Google Search. Write a 3-sentence summary of your findings. Focus on specific numbers, dates, and official names.

CLAIM: "${sanitized}"

RULES:
- Search for this claim using Google
- Write a concise 3-sentence summary of what you found
- Focus on specific numbers, dates, and official names
- Do NOT render a verdict or opinion
- If no sources found, respond with: No relevant sources found.${searchStrategy}`;

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
    console.log('[FAKTCHECK BG] ── STAGE 3: judgeEvidence (v5.4 Ground Truth) ──');
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

    const mathGuardrail = lang === 'de'
        ? '\n8. Mathematischer Ausreißer: Wenn der Claim einen numerischen Wert enthält, der >10x höher ist als der höchste bestätigte Wert in den Beweisen, setze verdict auf "false" und math_outlier auf true.'
        : '\n8. Mathematical Outlier: If the claim contains a numerical value >10x higher than the highest confirmed figure in the evidence, set verdict to "false" and math_outlier to true.';
    const causalRule = isCausal
        ? (lang === 'de' ? '\n9. Kausalität: Prüfe ob die zeitliche Abfolge den kausalen Zusammenhang stützt.' : '\n9. Causality: Check whether the timeline supports the causal relationship.')
        : '';


    const systemInstruction = lang === 'de'
        ? `Du bist ein unbestechlicher Faktenprüfer. Deine Aufgabe ist es, die Behauptungen aus Stage 2 gegen die recherchierten Beweise aus Stage 1 zu prüfen. Antworte NUR mit dem vorgegebenen JSON-Schema.

BEWERTUNGS-LOGIK:
1. REALITÄTS-PRIMAT: Die Tatsache, dass eine Aussage in einem Video getätigt wurde, ist kein Beweis für deren Richtigkeit. Prüfe, ob der INHALT der Aussage mit der Realität übereinstimmt.
2. TIER-1 DOMINANZ: Wenn offizielle Daten (WIFO, Statistik Austria, IMF, Weltbank, Eurostat) der Behauptung widersprechen, markiere sie als FALSCH, auch wenn der Sprecher sie als Fakt darstellt.
3. CONFIDENCE-MALUS: Wenn die einzige Quelle für eine Behauptung das Video selbst ist, setze die Confidence auf 0.1. Wenn externe Tier-1 Quellen fehlen, nutze das Label UNVERIFIABLE statt "Wahr".
4. METAPHERN-ERKENNUNG: Politische Übertreibungen und Metaphern (z.B. "Schneckentempo", "Rekordniveau", "Pleitewelle") sind KEINE Fakten. Prüfe den faktischen Kern gegen reale Daten.
5. Direkter Widerspruch durch Tier 1/2 Quelle → verdict: "false".
6. Direkte Bestätigung durch Tier 1/2 Quelle → verdict: "true".
7. Teilweise Übereinstimmung → verdict: "partially_true".
8. Meinung ohne prüfbaren Inhalt → verdict: "opinion".
9. DIKTATUR-FILTER: Wenn der Claim auf offiziellen Daten aus Ländern mit niedriger Pressefreiheit basiert (z.B. Russland, China, Nordkorea, Türkei, Iran), akzeptiere diese NICHT als Fakt. Vergleiche mit IMF/Weltbank-Daten. Wenn sie abweichen → verdict: "false", reasoning: Abweichung von unabhängigen Daten.
10. WHATABOUTISMUS: Wenn ein Fakt korrekt ist, aber offensichtlich verwendet wird, um von berechtigter Kritik abzulenken (z.B. "Aber China baut Kohlekraftwerke!"), markiere als "missing_context" und erkläre den fehlenden Kontext im reasoning.${mathGuardrail}${causalRule}

ABSCHLUSS-PRÜFUNG: Frage dich VOR der Antwort: "Gibt es offizielle Daten, die diesem Kern widersprechen?" Wenn ja → verdict: "false".

WICHTIG: Schreibe alle Antwortfelder (reasoning, quote) auf DEUTSCH.`
        : `You are an incorruptible fact-checker. Your task is to verify the claims from Stage 2 against the researched evidence from Stage 1. Respond ONLY with the required JSON schema.

EVALUATION LOGIC:
1. REALITY PRIMACY: The fact that a statement was made in a video is NOT evidence of its truth. Check whether the CONTENT of the statement matches reality.
2. TIER-1 DOMINANCE: If official data (IMF, World Bank, Eurostat, national statistics offices) contradicts the claim, mark it as FALSE, even if the speaker presents it as fact.
3. CONFIDENCE PENALTY: If the only source for a claim is the video itself, set confidence to 0.1. If external Tier-1 sources are missing, use UNVERIFIABLE instead of "True".
4. METAPHOR DETECTION: Political exaggerations and metaphors (e.g., "snail's pace", "record levels") are NOT facts. Check the factual core against real data.
5. Direct Contradiction by Tier 1/2 source → verdict: "false".
6. Direct Support by Tier 1/2 source → verdict: "true".
7. Partial Match → verdict: "partially_true".
8. Opinion with no verifiable assertion → verdict: "opinion".
9. DICTATOR FILTER: If the claim relies on official data from countries with low Press Freedom (e.g., Russia, China, North Korea, Turkey, Iran), do NOT accept it as fact. Compare with IMF/World Bank data. If they differ → verdict: "false", reasoning: Discrepancy with independent data.
10. WHATABOUTISM: If a fact is correct but is clearly used to deflect from legitimate criticism (e.g., "But China builds coal plants!"), mark as "missing_context" and explain the missing context in reasoning.${mathGuardrail}${causalRule}

FINAL CHECK: Before answering, ask: "Is there official data contradicting this core claim?" If yes → verdict: "false".

IMPORTANT: Write all response fields (reasoning, quote) in ENGLISH.`;

    const prompt = `${systemInstruction}

CLAIM: "${sanitized}"

SEARCH_SNIPPETS:
${evidenceBlock}${factsBlock}
SOURCE_URLS: ${sourceList}

Respond with JSON matching this schema exactly.`;

    // JSON schema for structured output
    const responseSchema = {
        type: 'object',
        properties: {
            verdict: { type: 'string', enum: ['true', 'false', 'partially_true', 'opinion', 'unverifiable', 'missing_context'] },
            confidence: { type: 'number' },
            math_outlier: { type: 'boolean' },
            reasoning: { type: 'string' },
            primary_source: { type: 'string' },
            quote: { type: 'string' },
            confidence_basis: { type: 'string', enum: ['direct_match', 'paraphrase', 'insufficient_data'] },
            evidence_chain: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        source_name: { type: 'string' },
                        url: { type: 'string' },
                        quote: { type: 'string' },
                        tier: { type: 'integer' },
                        sentiment: { type: 'string', enum: ['supporting', 'contradicting'] }
                    },
                    required: ['source_name', 'quote', 'sentiment']
                }
            }
        },
        required: ['verdict', 'confidence', 'math_outlier', 'reasoning']
    };

    try {
        const result = await callGeminiJSON(apiKey, prompt, responseSchema);

        // If JSON mode worked, return structured object directly
        if (result && !result._fallback) {
            console.log('[FAKTCHECK BG] ✅ Judge returned structured JSON:', result.verdict);
            return result;
        }

        // Fallback: return text for legacy regex parsing
        console.log('[FAKTCHECK BG] Judge fell back to text mode');
        return result._text || '';
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
        // V5.5+: Check IFCN cache first (cross-video, 24h TTL)
        const cacheKey = await hashClaim(claimText + ':' + lang);
        const cached = ifcnCache.get(cacheKey);
        if (cached && Date.now() - cached.ts < 86400000) {
            console.log('[FAKTCHECK BG] ── STAGE 0: IFCN Cache HIT ──');
            return cached.result;
        }

        const url = new URL('https://factchecktools.googleapis.com/v1alpha1/claims:search');
        url.searchParams.set('query', claimText.slice(0, 200));
        url.searchParams.set('key', apiKey);
        url.searchParams.set('languageCode', lang === 'de' ? 'de' : 'en');
        url.searchParams.set('maxAgeDays', '365');
        url.searchParams.set('pageSize', '3');

        console.log('[FAKTCHECK BG] ── STAGE 0: Fact Check API (cache MISS) ──');
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

        // Store in IFCN cache (evict oldest if >200 entries)
        if (ifcnCache.size >= 200) {
            const first = ifcnCache.keys().next().value;
            if (first) ifcnCache.delete(first);
        }
        ifcnCache.set(cacheKey, { result: results, ts: Date.now() });

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
        // ─── TIER 0 + TIER 2: Run in parallel (IFCN is free, ~100ms; search is ~1s) ───
        const [factCheckResult, evidenceResult] = await Promise.allSettled([
            searchFactChecks(claimText, apiKey, lang),
            searchOnly(claimText, apiKey)
        ]);
        const existingFactChecks = factCheckResult.status === 'fulfilled' ? factCheckResult.value : [];
        const evidence = evidenceResult.status === 'fulfilled' ? evidenceResult.value : { error: 'Search failed', sources: [], rawText: '' };

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

        // ─── STAGE 3: Judge evidence (JSON mode, no search) ───
        const judgeResponse = await judgeEvidence(claimText, snippetsForJudge, evidence.sources, apiKey, lang, claimType, [attributionList + structuredDataBlock + factCheckContext]);

        // ─── Parse judge response (JSON mode primary, text fallback) ───
        let parsed = null;
        let confidenceBasis = null;

        if (typeof judgeResponse === 'object' && judgeResponse.verdict) {
            // JSON mode succeeded — direct structured response
            console.log('[FAKTCHECK BG v2.0] ✅ JSON mode verdict:', judgeResponse.verdict);
            parsed = {
                verdict: judgeResponse.verdict,
                confidence: judgeResponse.confidence || 0.5,
                explanation: judgeResponse.reasoning || '',
                sources: [],
                math_outlier: judgeResponse.math_outlier || false
            };
            confidenceBasis = judgeResponse.confidence_basis || null;
            if (judgeResponse.primary_source) parsed._primarySource = judgeResponse.primary_source;
            if (judgeResponse.quote) parsed._quote = judgeResponse.quote;
            if (judgeResponse.math_outlier) parsed._mathOutlierFromJudge = true;
        } else {
            // Text fallback — legacy regex parsing
            let textToParse = String(judgeResponse || '');
            console.log('[FAKTCHECK BG v2.0] Text fallback, parsing:', textToParse.slice(0, 300));

            // Detect preamble and skip
            if (textToParse.match(/^(Okay|OK|Ich werde|I will|Let me|Lass mich)/i)) {
                console.error('[FAKTCHECK BG v2.0] ⚠️ Judge preamble detected');
                const verdictIdx = textToParse.indexOf('VERDICT:');
                if (verdictIdx > 0) textToParse = textToParse.substring(verdictIdx);
            }

            // Extract fields via regex
            const basisMatch = textToParse.match(/CONFIDENCE_BASIS:\s*(direct_match|paraphrase|insufficient_data)/i);
            confidenceBasis = basisMatch ? basisMatch[1].toLowerCase() : null;
            const primarySourceMatch = textToParse.match(/PRIMARY_SOURCE:\s*(https?:\/\/\S+)/i);
            const quoteMatch = textToParse.match(/QUOTE:\s*(.+)/i);

            parsed = parseStructuredText(textToParse) || extractJSON(textToParse) || parseVerdictFromText(textToParse);

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

            if (primarySourceMatch) parsed._primarySource = primarySourceMatch[1];
            if (quoteMatch) parsed._quote = quoteMatch[1].trim();
        }

        // Attach common data regardless of parse path
        if (confidenceBasis) parsed._confidenceBasis = confidenceBasis;
        if (evidenceQuotes.length > 0) parsed._evidenceQuotes = evidenceQuotes;
        parsed._claimText = claimText;
        if (existingFactChecks.length > 0) parsed._factChecks = existingFactChecks;

        // Attach Tier 1 structured data for UI
        if (tier1Data.length > 0) {
            parsed._tier1Data = tier1Data;
        }

        // Merge grounding sources from Tier 2 into parsed result
        if (evidence.sources.length > 0) {
            parsed._groundingSources = evidence.sources;
        }

        // ─── C5 VERDICT COHERENCE CHECK ───
        // Detect when explanation language contradicts the verdict and retry with a specific prompt.
        // Uses the same positive/negative signal matching as the Quality Gate's check_explanation_verdict_alignment().
        const explanationText = (parsed.explanation || parsed.reasoning || '').toLowerCase();
        const verdictCoherencePositive = ['confirmed', 'supported', 'is true', 'is correct', 'bestätigt', 'belegt', 'korrekt', 'stimmt', 'trifft zu',
            'evidence confirms', 'sources indicate', 'sources confirm', 'data supports', 'is supported'];
        const verdictCoherenceNegative = ['contradicted', 'not supported', 'nicht bestätigt', 'incorrect', 'not true',
            'no evidence', 'widerlegt', 'is false', 'is incorrect'];

        const hasPositive = verdictCoherencePositive.find(s => explanationText.includes(s));
        const hasNegative = verdictCoherenceNegative.find(s => explanationText.includes(s));

        const isC5Contradiction = (parsed.verdict === 'false' && hasPositive && !hasNegative) ||
            (parsed.verdict === 'true' && hasNegative && !hasPositive);

        if (isC5Contradiction) {
            const contradictPhrase = parsed.verdict === 'false' ? hasPositive : hasNegative;
            console.warn(`[FAKTCHECK BG] ⚠️ C5: Verdict "${parsed.verdict}" contradicts explanation phrase "${contradictPhrase}". Retrying...`);

            // Build specific retry prompt quoting the exact contradiction
            const retryPrompt = `You previously judged this claim and produced an INCOHERENT result.

CLAIM: "${sanitize(claimText, 500)}"

YOUR PREVIOUS VERDICT: "${parsed.verdict}"
YOUR PREVIOUS EXPLANATION: "${(parsed.explanation || parsed.reasoning || '').slice(0, 500)}"

CONTRADICTION: Your explanation contains "${contradictPhrase}" but your verdict is "${parsed.verdict}".
These are incompatible. Either:
- Change the verdict to match your evidence (e.g., if your evidence says "confirmed", the verdict should be "true")
- OR rewrite the explanation to justify why the verdict is "${parsed.verdict}"

Respond with the corrected JSON. Do NOT repeat the same contradiction.`;

            try {
                const retrySchema = {
                    type: 'object',
                    properties: {
                        verdict: { type: 'string', enum: ['true', 'false', 'partially_true', 'opinion', 'unverifiable'] },
                        confidence: { type: 'number' },
                        math_outlier: { type: 'boolean' },
                        reasoning: { type: 'string' }
                    },
                    required: ['verdict', 'confidence', 'reasoning']
                };
                const retryResult = await callGeminiJSON(apiKey, retryPrompt, retrySchema);

                if (retryResult && !retryResult._fallback && retryResult.verdict) {
                    // Check if retry resolved the contradiction
                    const retryExpl = (retryResult.reasoning || '').toLowerCase();
                    const retryHasPos = verdictCoherencePositive.some(s => retryExpl.includes(s));
                    const retryHasNeg = verdictCoherenceNegative.some(s => retryExpl.includes(s));
                    const stillContradicts = (retryResult.verdict === 'false' && retryHasPos && !retryHasNeg) ||
                        (retryResult.verdict === 'true' && retryHasNeg && !retryHasPos);

                    if (stillContradicts) {
                        // Retry also contradicts — override verdict to match evidence direction
                        const overrideVerdict = hasPositive ? 'true' : 'false';
                        console.warn(`[FAKTCHECK BG] ⚠️ C5: Retry still contradicts. Overriding verdict to "${overrideVerdict}"`);
                        parsed.verdict = overrideVerdict;
                        parsed.confidence = Math.min(parsed.confidence || 0.5, 0.5); // Cap confidence for overridden verdicts
                        parsed._c5Override = true;
                    } else {
                        // Retry resolved it — use the corrected result
                        console.log(`[FAKTCHECK BG] ✅ C5: Retry resolved contradiction. New verdict: "${retryResult.verdict}"`);
                        parsed.verdict = retryResult.verdict;
                        parsed.confidence = retryResult.confidence || parsed.confidence;
                        parsed.explanation = retryResult.reasoning || parsed.explanation;
                        parsed.reasoning = retryResult.reasoning || parsed.reasoning;
                        parsed.math_outlier = retryResult.math_outlier || false;
                        parsed._c5Retried = true;
                    }
                }
            } catch (retryError) {
                console.error('[FAKTCHECK BG] C5 retry failed:', retryError.message);
                // Don't block — proceed with original parsed result
            }
        }

        const validated = validateVerification(parsed, claimType, claimText);
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
            apiCallStart();
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
            } finally {
                apiCallEnd();
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
            apiCallStart();
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
            } finally {
                apiCallEnd();
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
