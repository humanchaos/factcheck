#!/usr/bin/env node
/* global process */
// ============================================================================
// FAKTCHECK Dry-Run Test Suite
// Tests 10 claims against the verification logic to catch hallucinations
// and confidence calibration issues before deployment.
//
// Usage: GEMINI_API_KEY=AIza... node test-dryrun.js
// ============================================================================

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
    console.error('❌ Missing GEMINI_API_KEY environment variable');
    console.error('Usage: GEMINI_API_KEY=AIza... node test-dryrun.js');
    process.exit(1);
}

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-2.0-flash';

// ─── Source Tier Logic (mirrors background.js) ──────────────
const SOURCE_TIERS = {
    tier1: ['parlament.gv.at', 'ris.bka.gv.at', 'orf.at', 'bundeskanzleramt.gv.at',
        'bmj.gv.at', 'bmi.gv.at', 'rechnungshof.gv.at', 'bka.gv.at'],
    tier2: ['derstandard.at', 'diepresse.com', 'wienerzeitung.at', 'profil.at',
        'falter.at', 'kurier.at', 'kleinezeitung.at', 'news.at', 'apa.at']
};

function getSourceTier(url) {
    if (!url) return 3;
    try {
        const hostname = new URL(url).hostname.replace(/^www\./, '');
        if (SOURCE_TIERS.tier1.some(d => hostname.endsWith(d))) return 1;
        if (SOURCE_TIERS.tier2.some(d => hostname.endsWith(d))) return 2;
        return 3;
    } catch { return 3; }
}

// ─── R2.3: Reproducible Confidence Scoring ──────────────────
function calculateConfidence(matchType, topTier, allSourcesAgree) {
    const baseMap = { direct: 0.9, paraphrase: 0.7, none: 0.0 };
    const tierMap = { 1: 1.0, 2: 0.85, 3: 0.7, 4: 0.4, 5: 0.1 };
    const base = baseMap[matchType] || 0.0;
    const sourceMult = tierMap[topTier] || 0.5;
    const agreementMult = allSourcesAgree ? 1.0 : 0.7;
    return parseFloat((base * sourceMult * agreementMult).toFixed(2));
}

// ─── API Helpers ────────────────────────────────────────────
async function callGemini(prompt) {
    const url = `${GEMINI_API_BASE}/${DEFAULT_MODEL}:generateContent?key=${API_KEY}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
        })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function callGeminiWithSearch(prompt) {
    const url = `${GEMINI_API_BASE}/${DEFAULT_MODEL}:generateContent?key=${API_KEY}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            tools: [{ google_search: {} }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
        })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const groundingMeta = data.candidates?.[0]?.groundingMetadata;
    let sources = [];
    if (groundingMeta?.groundingChunks) {
        sources = groundingMeta.groundingChunks
            .filter(c => c.web?.uri)
            .map(c => ({ title: c.web.title || 'Source', url: c.web.uri, tier: getSourceTier(c.web.uri) }));
    }
    return { text, sources };
}

// ─── Two-Step Verification (mirrors background.js) ──────────
async function searchOnly(claim) {
    const prompt = `Find factual sources for the following claim. Return ONLY the evidence you find.

CLAIM: "${claim}"

RESPONSE FORMAT (start DIRECTLY, no introduction):
SNIPPET_1: [Quote or key fact from source]
SNIPPET_2: [Quote or key fact from source]
SNIPPET_3: [Quote or key fact from source]
SOURCES: [URL1; URL2; URL3]

RULES:
- Search for this claim using Google
- Return only factual snippets and source URLs
- Do NOT render a verdict or opinion
- If no sources found, respond with: SNIPPET_1: No sources found\\nSOURCES: none`;

    const result = await callGeminiWithSearch(prompt);
    const snippetMatches = result.text.match(/SNIPPET_\d+:\s*(.+)/gi) || [];
    const snippets = snippetMatches
        .map(s => s.replace(/SNIPPET_\d+:\s*/i, '').trim())
        .filter(s => s && s !== 'No sources found');
    return { snippets, sources: result.sources };
}

async function judgeEvidence(claim, snippets, sources) {
    const evidenceBlock = snippets.length > 0
        ? snippets.map((s, i) => `SEARCH_SNIPPET_${i + 1}: ${s}`).join('\n')
        : 'NO SEARCH SNIPPETS AVAILABLE';
    const sourceList = sources.length > 0
        ? sources.map(s => s.url || s).join('; ')
        : 'none';

    const prompt = `You are a strictly grounded Verification Judge. You will be given a CLAIM and a set of SEARCH_SNIPPETS.

CRITICAL RULES:

1. Zero External Knowledge: You are forbidden from using your internal training data. If the snippets don't mention the claim, you MUST return 'UNVERIFIED'.

2. Direct Contradiction: If the snippets explicitly deny the claim, return 'FALSE'.

3. Direct Support: Only return 'TRUE' if a Tier 1 or Tier 2 source explicitly confirms the specific numbers, dates, or names in the claim.

4. Partial Match: If the snippets support part of the claim but omit a key detail, return 'MISLEADING'.

5. Opinion: If the claim is a value judgment or personal opinion and contains NO verifiable factual assertion, return 'OPINION'.

CLAIM: "${claim}"

SEARCH_SNIPPETS:
${evidenceBlock}
SOURCE_URLS: ${sourceList}

MANDATORY OUTPUT FORMAT (start DIRECTLY, no introduction):
VERDICT: [true | false | misleading | opinion | unverified]
PRIMARY_SOURCE: [URL of the most relevant source]
QUOTE: [The exact sentence from the snippet that justifies your verdict]
CONFIDENCE_BASIS: [direct_match | paraphrase | insufficient_data]`;

    return await callGemini(prompt);
}

function parseVerdict(text) {
    const verdictMatch = text.match(/VERDICT:\s*(true|false|partially_true|deceptive|opinion|unverifiable|unverified|misleading|mostly_true|mostly_false)/i);
    const basisMatch = text.match(/CONFIDENCE_BASIS:\s*(direct_match|paraphrase|insufficient_data)/i);
    const quoteMatch = text.match(/QUOTE:\s*(.+)/i);
    const primaryMatch = text.match(/PRIMARY_SOURCE:\s*(https?:\/\/\S+)/i);
    let verdict = verdictMatch ? verdictMatch[1].toLowerCase() : 'unknown';
    // Normalize to existing system
    if (verdict === 'unverified') verdict = 'unverifiable';
    if (verdict === 'misleading') verdict = 'partially_true';
    return {
        verdict,
        confidenceBasis: basisMatch ? basisMatch[1].toLowerCase() : null,
        quote: quoteMatch ? quoteMatch[1].trim() : '',
        primarySource: primaryMatch ? primaryMatch[1] : '',
        explanation: quoteMatch ? quoteMatch[1].trim() : text.slice(0, 200)
    };
}

// ─── Test Claims ────────────────────────────────────────────
const TEST_CLAIMS = [
    { claim: "Austria's population is 20 million.", expectedTier: '1', expectedVerdict: 'false', notes: 'Pop. is ~9.1M' },
    { claim: "The Earth is flat.", expectedTier: '3-5', expectedVerdict: 'false', notes: 'Classic disinfo' },
    { claim: "Karl Nehammer is Chancellor of Austria.", expectedTier: '1', expectedVerdict: 'false', notes: 'Resigned Dec 2024' },
    { claim: "Water boils at 100°C at sea level.", expectedTier: '3', expectedVerdict: 'true', notes: 'Basic physics' },
    { claim: "COVID vaccines contain microchips.", expectedTier: '3-5', expectedVerdict: 'false', notes: 'Conspiracy theory' },
    { claim: "The EU has 27 member states.", expectedTier: '1-2', expectedVerdict: 'true', notes: 'Post-Brexit fact' },
    { claim: "I think pineapple belongs on pizza.", expectedTier: '—', expectedVerdict: 'opinion', notes: 'Pure opinion' },
    { claim: "Climate change is caused by solar cycles.", expectedTier: '2-3', expectedVerdict: 'false', notes: 'Debunked claim' },
    { claim: "Austria joined the EU in 1995.", expectedTier: '1', expectedVerdict: 'true', notes: 'Historical fact' },
    { claim: "Vienna is the capital of Switzerland.", expectedTier: '1', expectedVerdict: 'false', notes: 'It is Bern' },
];

// ─── Run Tests ──────────────────────────────────────────────
async function runTest(testCase, index) {
    const label = `[${index + 1}/10]`;
    console.log(`\n${label} Testing: "${testCase.claim}"`);
    console.log(`${label} Expected: ${testCase.expectedVerdict.toUpperCase()} (tier ${testCase.expectedTier})`);

    try {
        // Step 1: Search
        const evidence = await searchOnly(testCase.claim);
        console.log(`${label} Step 1: ${evidence.snippets.length} snippets, ${evidence.sources.length} grounding sources`);

        const topTier = evidence.sources.length > 0
            ? Math.min(...evidence.sources.map(s => s.tier))
            : 5;

        // Step 2: Judge
        const judgeResponse = await judgeEvidence(testCase.claim, evidence.snippets, evidence.sources);
        const parsed = parseVerdict(judgeResponse);

        // Calculate deterministic confidence using judge's CONFIDENCE_BASIS
        const tier1Count = evidence.sources.filter(s => s.tier === 1).length;
        const tier2Count = evidence.sources.filter(s => s.tier === 2).length;
        const totalSources = evidence.sources.length;
        // Prefer judge's basis, fall back to source-tier inference
        const rawMatchType = parsed.confidenceBasis
            || (tier1Count >= 1 ? 'direct'
                : (tier2Count >= 1 || totalSources >= 2) ? 'paraphrase'
                    : 'none');
        const matchType = rawMatchType === 'insufficient_data' ? 'none' : rawMatchType;
        const allSourcesAgree = !(['true', 'mostly_true'].includes(parsed.verdict) && totalSources === 0);
        const calibrated = calculateConfidence(matchType, topTier, allSourcesAgree);

        // Verdict match check (accept partially_true for opinion-like claims)
        const verdictOk = parsed.verdict === testCase.expectedVerdict
            || (testCase.expectedVerdict === 'false' && ['false', 'deceptive'].includes(parsed.verdict))
            || (testCase.expectedVerdict === 'true' && ['true', 'mostly_true'].includes(parsed.verdict));

        const status = verdictOk ? '✅ PASS' : '❌ FAIL';
        console.log(`${label} ${status} → ${parsed.verdict.toUpperCase()} (basis: ${parsed.confidenceBasis || 'inferred'}, calibrated: ${calibrated}, tier: ${topTier})`);
        console.log(`${label} Quote: ${parsed.quote.slice(0, 120) || parsed.explanation.slice(0, 120)}`);

        // Flag hallucinated confidence — judge says direct_match but no quality sources
        if (parsed.confidenceBasis === 'direct_match' && matchType === 'none') {
            console.log(`${label} ⚠️  HALLUCINATED BASIS: Judge says direct_match but no quality sources found`);
        }

        return { ...testCase, actual: parsed.verdict, basis: parsed.confidenceBasis, calibrated, topTier, pass: verdictOk };
    } catch (error) {
        console.error(`${label} ❌ ERROR: ${error.message}`);
        return { ...testCase, actual: 'error', basis: null, calibrated: 0, topTier: 0, pass: false };
    }
}

async function main() {
    console.log('═══════════════════════════════════════════════════');
    console.log('  FAKTCHECK Dry-Run Stability Check');
    console.log('  Model:', DEFAULT_MODEL);
    console.log('  Claims:', TEST_CLAIMS.length);
    console.log('═══════════════════════════════════════════════════');

    const results = [];
    for (const [i, tc] of TEST_CLAIMS.entries()) {
        const result = await runTest(tc, i);
        results.push(result);
        // Rate limit: 1.5s between claims (2 API calls each = 20 calls for 10 claims)
        if (i < TEST_CLAIMS.length - 1) await new Promise(r => setTimeout(r, 1500));
    }

    // Summary
    console.log('\n═══════════════════════════════════════════════════');
    console.log('  RESULTS SUMMARY');
    console.log('═══════════════════════════════════════════════════');

    const passed = results.filter(r => r.pass).length;
    const failed = results.filter(r => !r.pass).length;
    const hallucinated = results.filter(r => r.basis === 'direct_match' && r.calibrated < 0.3).length;

    console.log(`\n  Passed:        ${passed}/10`);
    console.log(`  Failed:        ${failed}/10`);
    console.log(`  Hallucinated:  ${hallucinated}/10`);

    console.log('\n  ┌─────┬────────────────────────────────────────┬──────────┬──────────┬──────────┬──────┐');
    console.log('  │  #  │ Claim                                  │ Expected │ Actual   │ Cal.Conf │ Tier │');
    console.log('  ├─────┼────────────────────────────────────────┼──────────┼──────────┼──────────┼──────┤');
    for (const [i, r] of results.entries()) {
        const status = r.pass ? '✅' : '❌';
        const claim = r.claim.slice(0, 38).padEnd(38);
        const expected = r.expectedVerdict.padEnd(8);
        const actual = r.actual.padEnd(8);
        console.log(`  │ ${status}${String(i + 1).padStart(2)} │ ${claim} │ ${expected} │ ${actual} │ ${String(r.calibrated).padEnd(8)} │ ${String(r.topTier).padEnd(4)} │`);
    }
    console.log('  └─────┴────────────────────────────────────────┴──────────┴──────────┴──────────┴──────┘');

    console.log(`\n${passed >= 7 ? '✅' : '❌'} ${passed >= 7 ? 'STABILITY CHECK PASSED' : 'STABILITY CHECK FAILED'} (${passed}/10, threshold: 7)`);
    process.exit(passed >= 7 ? 0 : 1);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
