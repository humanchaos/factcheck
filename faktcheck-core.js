// ============================================================
// FAKTCHECK v3.2 — VERIFIED FIX
// ============================================================
//
// EVIDENCE FROM USER'S DATA:
//   Sources ARE populated, but text response is EMPTY.
//   ✅ google_search tool IS firing
//   ✅ groundingMetadata.groundingChunks extracted
//   ❌ Text field empty → "Could not parse response"
//
// FIX: Plain-text prompts (no JSON request), then regex parsing.
// ============================================================

const CONFIG = {
    model: 'gemini-2.0-flash',
    fallbackModel: 'gemini-1.5-flash-latest',
    maxRetries: 2,
    temperature: 0.1,
    maxOutputTokens: 2048,
    getApiKey: async () => {
        const { geminiApiKey } = await chrome.storage.local.get(['geminiApiKey']);
        return geminiApiKey || '';
    }
};

// ─── SOURCE TIERS ───────────────────────────────────────────

const TIER_1 = ['parlament.gv.at', 'ris.bka.gv.at', 'orf.at', 'bundeskanzleramt.gv.at', 'bmj.gv.at', 'bmi.gv.at', 'rechnungshof.gv.at'];
const TIER_2 = ['derstandard.at', 'diepresse.com', 'wienerzeitung.at', 'profil.at', 'falter.at', 'kurier.at', 'kleinezeitung.at', 'news.at', 'apa.at'];

function getSourceTier(url) {
    if (!url) return 3;
    const u = url.toLowerCase();
    if (TIER_1.some(d => u.includes(d))) return 1;
    if (TIER_2.some(d => u.includes(d))) return 2;
    return 3;
}

// ─── UTILITIES ──────────────────────────────────────────────

function fixMojibake(text) {
    if (!text || !text.includes('Ã')) return text;
    try {
        const bytes = new Uint8Array([...text].map(c => c.charCodeAt(0)));
        const decoded = new TextDecoder('utf-8').decode(bytes);
        return (decoded.includes('Ã') && decoded.length >= text.length) ? text : decoded;
    } catch { return text; }
}

function sanitize(str, max = 500) {
    return String(str || '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim().slice(0, max);
}

// ─── JSON EXTRACTION (with fallback) ────────────────────────

function tryExtractJSON(raw) {
    if (!raw) return null;
    if (typeof raw === 'object') return raw;
    let text = String(raw).trim();
    text = text.replace(/^```(?:json|JSON)?\s*\n?/gm, '').replace(/\n?\s*```\s*$/gm, '').trim();

    const start = text.search(/[\[{]/);
    if (start === -1) return null;
    text = text.substring(start);

    const open = text[0], close = open === '[' ? ']' : '}';
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (esc) { esc = false; continue; }
        if (c === '\\' && inStr) { esc = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === open) depth++;
        if (c === close) depth--;
        if (depth === 0) { end = i; break; }
    }
    if (end === -1) {
        let repaired = text;
        while (depth-- > 0) repaired += close;
        try { return JSON.parse(repaired); } catch { return null; }
    }
    try { return JSON.parse(text.substring(0, end + 1)); } catch { return null; }
}

// ─── PLAIN TEXT VERDICT PARSER ──────────────────────────────

function parseVerdictFromText(text) {
    if (!text || typeof text !== 'string') return null;
    const t = text.toLowerCase();

    // Try JSON first
    const jsonResult = tryExtractJSON(text);
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

    return { verdict, confidence, explanation, key_facts: [] };
}

/**
 * Parse structured VERDICT/CONFIDENCE/EXPLANATION format
 */
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

    return {
        verdict,
        confidence: Math.max(0, Math.min(1, confidence)),
        explanation: explMatch ? explMatch[1].trim() : '',
        key_facts: keyFacts,
        sources
    };
}

// ─── GEMINI CALLER ──────────────────────────────────────────

async function callGemini(prompt, options = {}) {
    const {
        model = CONFIG.model,
        useSearch = true,
        forceJSON = false,
        apiKey = await CONFIG.getApiKey()
    } = options;

    if (!apiKey) throw new Error('No API key');

    // NEVER combine google_search with response_mime_type
    const tools = useSearch ? [{ google_search: {} }] : [];
    const isV2Plus = model.includes('2.0') || model.includes('2.5');
    const canForceJSON = forceJSON && !useSearch && isV2Plus;

    const requestBody = {
        contents: [{ parts: [{ text: prompt }] }],
        ...(tools.length ? { tools } : {}),
        generationConfig: {
            temperature: CONFIG.temperature,
            maxOutputTokens: CONFIG.maxOutputTokens,
            ...(canForceJSON ? { response_mime_type: 'application/json' } : {})
        }
    };

    let lastError;
    const models = [model];
    if (model !== CONFIG.fallbackModel) models.push(CONFIG.fallbackModel);

    for (const m of models) {
        for (let attempt = 0; attempt < CONFIG.maxRetries; attempt++) {
            try {
                const response = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`,
                    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) }
                );

                if (response.status === 429) {
                    await new Promise(r => setTimeout(r, Math.pow(2, attempt + 1) * 1000));
                    continue;
                }
                if (!response.ok) throw new Error(`${m}: HTTP ${response.status}`);

                const result = await response.json();
                const candidate = result.candidates?.[0];
                if (!candidate) throw new Error('No candidates');

                const textParts = (candidate.content?.parts || []).filter(p => p.text).map(p => p.text);
                const fullText = textParts.join('');

                const groundingSources = [];
                const chunks = candidate.groundingMetadata?.groundingChunks || [];
                for (const c of chunks) {
                    if (c.web?.uri) {
                        groundingSources.push({
                            title: c.web.title || 'Source',
                            url: c.web.uri,
                            tier: getSourceTier(c.web.uri)
                        });
                    }
                }

                console.log(`[FAKTCHECK v3.2] ${m} success, text: ${fullText.length} chars, sources: ${groundingSources.length}`);
                return { text: fullText, groundingSources, raw: result };

            } catch (err) {
                lastError = err;
                console.warn(`[FAKTCHECK v3.2] ${m}#${attempt}:`, err.message);
            }
        }
    }
    throw lastError;
}

// ─── PHASE 1: EXTRACTION ────────────────────────────────────

async function extractClaims(text, videoTitle = '') {
    const clean = fixMojibake(text);

    const prompt = `Du bist ein Informations-Auditor für österreichische politische Inhalte.

Video-Titel: "${videoTitle}"

TRANSCRIPT:
"${clean}"

Extrahiere überprüfbare Claims:
1. HYDRATION: Ersetze alle Pronomen durch Namen. Ergänze Kontext aus Titel.
2. SEARCH QUERIES: 2-3 kurze Google-Suchbegriffe pro Claim (3-6 Wörter)
3. TYPE: factual, causal (nur wenn Kausalität der Kern ist), opinion, procedural
4. Lösche reine Befindlichkeiten.

Antworte NUR mit JSON-Array, kein anderer Text:
[{"claim":"...","search_queries":["..."],"anchors":["..."],"type":"factual","speaker":"Name","checkability":3,"importance":3}]
Keine Claims? Antworte: []`;

    try {
        // Extraction: NO search, YES forceJSON
        const { text: responseText } = await callGemini(prompt, { useSearch: false, forceJSON: true });
        const parsed = tryExtractJSON(responseText);
        if (!Array.isArray(parsed)) return fallbackExtraction(clean);

        return parsed.filter(c => c?.claim).map(c => ({
            claim: sanitize(c.claim, 500),
            originalClaim: sanitize(c.claim, 500),
            search_queries: Array.isArray(c.search_queries) ? c.search_queries.map(q => sanitize(q, 100)).slice(0, 3) : [],
            anchors: Array.isArray(c.anchors) ? c.anchors.slice(0, 5) : [],
            type: ['factual', 'causal', 'opinion', 'procedural'].includes(c.type) ? c.type : 'factual',
            speaker: c.speaker || null,
            checkability: Math.max(1, Math.min(5, Number(c.checkability) || 3)),
            importance: Math.max(1, Math.min(5, Number(c.importance) || 3))
        }));
    } catch (e) {
        console.error('[FAKTCHECK v3.2] Extraction failed:', e.message);
        return fallbackExtraction(clean);
    }
}

function fallbackExtraction(text) {
    return text.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 20 && /[A-ZÄÖÜ]/.test(s))
        .slice(0, 5).map(s => ({
            claim: s, originalClaim: s,
            search_queries: s.split(/\s+/).filter(w => /^[A-ZÄÖÜ]/.test(w) && w.length > 2).slice(0, 4),
            anchors: [], type: 'factual', speaker: null,
            checkability: 2, importance: 2, _fallback: true
        }));
}

// ─── PHASE 2: VERIFICATION (PLAIN TEXT!) ────────────────────

async function verifyClaim(claim, videoTitle = '') {
    if (claim.type === 'opinion') {
        return {
            verdict: 'opinion', displayVerdict: 'opinion', confidence: 0.80,
            explanation: 'Meinungsäußerung.', key_facts: [], sources: [], is_causal: false
        };
    }
    if (claim.type === 'procedural') {
        return {
            verdict: 'unverifiable', displayVerdict: 'unverifiable', confidence: 0.50,
            explanation: 'Ankündigung, nicht überprüfbar.', key_facts: [], sources: [], is_causal: false
        };
    }

    const queries = claim.search_queries?.length > 0
        ? claim.search_queries.map((q, i) => `Suche ${i + 1}: "${q}"`).join('\n')
        : `Suche: "${(claim.anchors || []).join(' ') || claim.claim.split(' ').slice(0, 6).join(' ')}"`;

    // V3.2: PLAIN TEXT prompt — NO JSON requested!
    const prompt = `Faktenprüfer für österreichische Politik. Prüfe diesen Claim mit Google Search.

CLAIM: "${claim.claim}"
TYP: ${claim.type}
KONTEXT: ${videoTitle}

Suche mit:
${queries}

Quellen-Tiers:
- parlament.gv.at, orf.at → 1 Quelle reicht
- derstandard.at, diepresse.com → 2 Quellen nötig

Antwort-Format (EXAKT so, jede Zeile einzeln):

VERDICT: [true/false/partially_true/deceptive/unverifiable]
CONFIDENCE: [0.0-1.0]
EXPLANATION: [Ein bis zwei Sätze Begründung]
KEY_FACTS: [Fakt 1; Fakt 2]
SOURCES: [URL1; URL2]`;

    try {
        const { text: responseText, groundingSources } = await callGemini(prompt, {
            useSearch: true,
            forceJSON: false  // CRITICAL: plain text mode
        });

        console.log('[FAKTCHECK v3.2] Raw response:', responseText?.slice(0, 200) || 'EMPTY');

        // Parse structured plain text OR free text
        const parsed = parseStructuredText(responseText) || parseVerdictFromText(responseText);

        if (!parsed) {
            console.warn('[FAKTCHECK v3.2] Could not parse, using grounding sources only');
            return {
                verdict: groundingSources.length > 0 ? 'partially_true' : 'unverifiable',
                displayVerdict: groundingSources.length > 0 ? 'partially_true' : 'unverifiable',
                confidence: groundingSources.length > 0 ? 0.50 : 0.30,
                explanation: groundingSources.length > 0
                    ? `Quellen gefunden, aber keine explizite Analyse von Gemini.`
                    : 'Keine Antwort von Gemini erhalten.',
                key_facts: [],
                sources: groundingSources || [],
                is_causal: false,
                _emptyResponse: true
            };
        }

        // Merge sources: from text + from grounding metadata
        let sources = parsed.sources || [];
        if (groundingSources?.length > 0) {
            const existing = new Set(sources.map(s => s.url));
            for (const gs of groundingSources) {
                if (!existing.has(gs.url)) sources.push(gs);
            }
        }

        return normalizeVerdict({ ...parsed, sources }, claim);

    } catch (error) {
        console.error('[FAKTCHECK v3.2] Verification error:', error.message);
        return {
            verdict: 'unverifiable', displayVerdict: 'unverifiable', confidence: 0.3,
            explanation: `Fehler: ${error.message}`,
            key_facts: [], sources: [], is_causal: false, _error: error.message
        };
    }
}

// ─── VERDICT NORMALIZATION ──────────────────────────────────

const VALID = ['true', 'mostly_true', 'partially_true', 'mostly_false', 'false', 'unverifiable', 'misleading', 'opinion', 'deceptive'];
const DISPLAY = {
    true: 'true', mostly_true: 'true', false: 'false', mostly_false: 'false',
    deceptive: 'deceptive', partially_true: 'partially_true', misleading: 'partially_true',
    unverifiable: 'unverifiable', opinion: 'opinion'
};

function normalizeVerdict(data, claim = {}) {
    let verdict = VALID.includes(data.verdict) ? data.verdict : 'unverifiable';
    let confidence = Math.max(0, Math.min(1, Number(data.confidence) || 0.5));
    let explanation = sanitize(data.explanation || '', 500);

    const sources = (data.sources || []).filter(s => s?.url).slice(0, 8)
        .map(s => ({ title: sanitize(s.title || 'Quelle', 150), url: String(s.url), tier: s.tier || getSourceTier(s.url) }));

    const bestTier = sources.length > 0 ? Math.min(...sources.map(s => s.tier)) : 99;

    if (verdict === 'true' || verdict === 'mostly_true') {
        if (bestTier === 1) confidence = Math.max(confidence, 0.85);
        else if (bestTier === 2 && sources.length >= 2) confidence = Math.max(confidence, 0.80);
        else if (sources.length < 2 && bestTier === 3) {
            verdict = 'partially_true'; confidence = Math.min(confidence, 0.60);
        }
    }

    if (claim.type === 'causal') {
        confidence = Math.min(confidence, 0.70);
        const tl = data.timeline || {};
        if (tl.intent_date && tl.trigger_date && new Date(tl.intent_date) < new Date(tl.trigger_date)) {
            verdict = 'deceptive'; confidence = 0.90;
        }
    }

    return {
        verdict, displayVerdict: DISPLAY[verdict] || 'unverifiable',
        confidence: Math.round(confidence * 100) / 100,
        explanation, key_facts: data.key_facts || [],
        sources, is_causal: claim.type === 'causal'
    };
}

// ─── DISPLAY CONFIG ─────────────────────────────────────────

const DISPLAY_CONFIG = {
    true: { label: 'Bestätigt', color: '#22c55e', icon: '✅' },
    false: { label: 'Falsch', color: '#ef4444', icon: '❌' },
    deceptive: { label: 'Irreführend', color: '#f97316', icon: '⚠️' },
    partially_true: { label: 'Teilweise wahr', color: '#eab308', icon: '⚡' },
    unverifiable: { label: 'Nicht überprüfbar', color: '#6b7280', icon: '❓' },
    opinion: { label: 'Meinung', color: '#8b5cf6', icon: '💬' }
};

// ─── EXPORTS ────────────────────────────────────────────────
// These are used by background.js
