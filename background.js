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

// Sanitization
function sanitize(text, maxLen = 5000) {
    if (typeof text !== 'string') return '';
    return text.replace(/[\x00-\x1F\x7F]/g, '').slice(0, maxLen).trim();
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
        category: String(item.category || 'UNKNOWN')
    }));
    console.log('[FAKTCHECK BG] Validated claims:', valid.length);
    return valid;
}

function validateVerification(data) {
    const validVerdicts = ['true', 'mostly_true', 'partially_true', 'mostly_false', 'false', 'unverifiable', 'misleading', 'opinion'];
    if (typeof data !== 'object' || !data) {
        return { verdict: 'unverifiable', displayVerdict: 'unverifiable', confidence: 0, explanation: 'Invalid response', sources: [] };
    }
    const verdict = validVerdicts.includes(data.verdict) ? data.verdict : 'unverifiable';
    const displayMap = {
        'true': 'true', 'mostly_true': 'true',
        'false': 'false', 'mostly_false': 'false',
        'partially_true': 'partially_true', 'misleading': 'partially_true',
        'unverifiable': 'unverifiable', 'opinion': 'opinion'
    };
    return {
        verdict,
        displayVerdict: displayMap[verdict] || 'unverifiable',
        confidence: Math.max(0, Math.min(1, Number(data.confidence) || 0.5)),
        explanation: sanitize(String(data.explanation || ''), 500),
        key_facts: Array.isArray(data.key_facts) ? data.key_facts.filter(f => typeof f === 'string').slice(0, 5) : [],
        sources: Array.isArray(data.sources) ? data.sources.filter(s => s && s.url).slice(0, 5).map(s => ({
            title: String(s.title || 'Source').slice(0, 100),
            url: s.url,
            tier: 3
        })) : []
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

    // ✅ FIX: Removed broken googleSearch tool that was causing errors
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
        `# Rolle: Senior Information Auditor (Context-First)
${groundingContext}

## SCHRITT 1: KONTEXT-PROFIL (Zwingend vor Extraktion)
Bevor du Fakten suchst, erstelle intern ein Profil des Videos:
- **Geografie:** Welches Land wird adressiert? (Österreich, Deutschland, USA, etc.)
- **Sprecher:** Wer spricht? (Name, Rolle).
- **Genre:** NEWS | SATIRE | TALK | SPEECH.
- **Bias-Check:** Ist der Ton neutral, polemisch oder ironisch? Marker: "Operettenstaat", "Beste Regierung aller Zeiten".

## STRENGER CLAIM-FILTER (Schritt 2)
**KEINE MEINUNGEN:** Verwerfe Sätze, die Motivation oder Unvermögen von Gruppen beschreiben (z.B. "Journalisten wollen nicht verstehen", "Politiker können nicht rechnen").

**KEINE METAPHERN:** Verwerfe Sätze mit subjektiven Adjektiven wie "enorm", "großartig", "dramatisch", sofern sie nicht an eine konkrete Zahl gebunden sind.

**NUR HARTE FAKTEN:** Extrahiere NUR Sätze mit:
- Zahlen, Daten, Gesetze, spezifische Handlungen
- Vollständiges Subjekt + Prädikat + Objekt

## SCHRITT 3: NEUTRALISIERUNGS-GEBOT
Wandle jede polemische Aussage in einen neutralen Prüfsatz um.
- "Witzekanzler liest Einkaufsliste vor" → "Vizekanzler Babler präsentiert Liste zur MwSt-Senkung"

## SCHRITT 4: GROUNDING (Realität Februar 2026)
- Aktuelles Datum: 5. Februar 2026
- Österreich: Bundeskanzler Christian Stocker, Vizekanzler Andreas Babler
- Wirtschaft: MwSt auf Grundnahrungsmittel beträgt 4,9%

## SATIRE-ERKENNUNG (Verdict-Logik)
Wenn Genre = SATIRE und Claim faktisch falsch ist:
→ Verwende "verdict": "satirical_hyperbole" statt "false"
→ Dies sind bewusste Übertreibungen, keine Desinformation

## Text:
"${sanitized.slice(0, 4000)}"

## Output (NUR JSON-Array):
[{"claim": "Neutraler, prüfbarer Fakt", "speaker": "Name", "checkability": 1-5, "importance": 1-5, "category": "STATISTIK|WIRTSCHAFT|POLITIK|GESETZ", "is_satire_context": false}]

Keine prüfbaren Claims? Antworte: []` :
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

// Verify Claim
async function verifyClaim(claimText, apiKey, lang = 'de') {
    console.log('[FAKTCHECK BG] ========== VERIFY CLAIM ==========');
    console.log('[FAKTCHECK BG] Claim:', claimText.slice(0, 80) + '...');

    const cached = await getCached(claimText);
    if (cached) return cached;

    const sanitized = sanitize(claimText, 1000);

    const prompt = lang === 'de' ?
        `Verifiziere diese Behauptung: "${sanitized}"

Bewerte ob die Behauptung wahr, falsch oder nicht überprüfbar ist.

Antworte NUR mit JSON (KEIN Markdown):
{"verdict": "true", "confidence": 0.8, "explanation": "Kurze Erklärung", "key_facts": ["Fakt 1"], "sources": [{"title": "Quelle", "url": "https://example.com"}]}

Mögliche Verdicts: true, false, partially_true, unverifiable, opinion` :
        `Verify this claim: "${sanitized}"

Evaluate if the claim is true, false, or unverifiable.

Respond ONLY with JSON (NO markdown):
{"verdict": "true", "confidence": 0.8, "explanation": "Brief explanation", "key_facts": ["Fact 1"], "sources": [{"title": "Source", "url": "https://example.com"}]}

Possible verdicts: true, false, partially_true, unverifiable, opinion`;

    try {
        const result = await callGemini(apiKey, prompt);

        let parsed;
        try {
            parsed = JSON.parse(result);
        } catch {
            const match = result.match(/\{[\s\S]*\}/);
            parsed = match ? JSON.parse(match[0]) : { verdict: 'unverifiable' };
        }

        const validated = validateVerification(parsed);
        await setCache(claimText, validated);
        console.log('[FAKTCHECK BG] Verdict:', validated.verdict, '| Confidence:', validated.confidence);
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
                const verification = await verifyClaim(message.claim, geminiApiKey, message.lang || 'de');
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
