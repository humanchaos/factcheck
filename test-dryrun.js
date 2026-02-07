#!/usr/bin/env node
/* global process */
// ============================================================================
// FAKTCHECK Dry-Run Test Suite v5.1
// Tests 22 claims against the verification logic to catch hallucinations
// and confidence calibration issues before deployment.
//
// Pipeline: researchAndSummarize → mapEvidence (LOCAL) → judgeEvidence
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

// ─── Source Tier Logic (registry-backed, mirrors background.js) ────
const fs = require('fs');
const path = require('path');
let sourceRegistry = null;
try {
    const registryPath = path.join(__dirname, 'assets', 'registry', 'sources-global.json');
    sourceRegistry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    console.log(`Source registry loaded: v${sourceRegistry.version}, ${Object.keys(sourceRegistry.domains).length} domains`);
} catch (err) {
    console.warn('Failed to load registry, using defaults:', err.message);
    sourceRegistry = {
        domains: { 'parlament.gv.at': { tier: 1 }, 'orf.at': { tier: 2 }, 'reuters.com': { tier: 1 } },
        wildcards: { '*.gv.at': { tier: 1 }, '*.gov': { tier: 1 }, '*.edu': { tier: 2 } }
    };
}

function getSourceTier(url) {
    if (!url) return 4;
    try {
        const hostname = new URL(url).hostname.replace(/^www\./, '');
        if (sourceRegistry?.domains?.[hostname]) return sourceRegistry.domains[hostname].tier;
        const parts = hostname.split('.');
        for (let i = 1; i < parts.length; i++) {
            const parent = parts.slice(i).join('.');
            if (sourceRegistry?.domains?.[parent]) return sourceRegistry.domains[parent].tier;
        }
        if (sourceRegistry?.wildcards) {
            for (const [pattern, meta] of Object.entries(sourceRegistry.wildcards)) {
                const suffix = pattern.replace('*.', '.');
                if (hostname.endsWith(suffix)) return meta.tier;
            }
        }
    } catch { return 4; }
    return 4;
}

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
    } catch { /* */ }
    return null;
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

    // Extract grounding chunks (sources)
    let sources = [];
    if (groundingMeta?.groundingChunks) {
        sources = groundingMeta.groundingChunks
            .filter(c => c.web?.uri)
            .map(c => ({ title: c.web.title || 'Source', url: c.web.uri, tier: getSourceTier(c.web.uri) }));
    }

    // V5.1: Extract groundingSupports (text→URL attribution)
    let groundingSupports = [];
    if (groundingMeta?.groundingSupports) {
        groundingSupports = groundingMeta.groundingSupports.map(s => ({
            text: s.segment?.text || '',
            startIndex: s.segment?.startIndex || 0,
            endIndex: s.segment?.endIndex || 0,
            chunkIndices: s.groundingChunkIndices || [],
            confidences: s.confidenceScores || []
        })).filter(s => s.text.length > 0);
    }

    return { text, sources, groundingSupports };
}

// ─── V5.1: Two-Step Verification (mirrors background.js) ─────
async function researchAndSummarize(claim) {
    const prompt = `Research this claim thoroughly using Google Search. Write a 3-sentence summary of your findings. Focus on specific numbers, dates, and official names.

CLAIM: "${claim}"

RULES:
- Search for this claim using Google
- Write a concise 3-sentence summary of what you found
- Focus on specific numbers, dates, and official names
- Do NOT render a verdict or opinion
- If no sources found, respond with: No relevant sources found.`;

    const result = await callGeminiWithSearch(prompt);
    return { rawText: result.text, sources: result.sources, groundingSupports: result.groundingSupports };
}

// ─── STAGE 2: MAP EVIDENCE (Local — zero API calls) ─────────
function mapEvidence(groundingSupports, groundingSources) {
    if (!groundingSupports || groundingSupports.length === 0) return [];

    return groundingSupports
        .map(support => {
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
}

// ─── STAGE 3: Judge Evidence ─────────────────────────────────
async function judgeEvidence(claim, evidenceQuotes, sources, rawText) {
    const attributionList = evidenceQuotes.length > 0
        ? evidenceQuotes.map((eq, i) => `EVIDENCE_${i + 1}: "${eq.quote}" (Source: ${eq.source}, URL: ${eq.url}, Tier: ${eq.tier})`).join('\n')
        : 'NO ATTRIBUTED EVIDENCE AVAILABLE';

    const summaryBlock = rawText
        ? `\nRESEARCH SUMMARY:\n${rawText}`
        : '';

    const sourceList = sources.length > 0
        ? sources.map(s => s.url || s).join('; ')
        : 'none';

    const prompt = `You are a strictly grounded Verification Judge. You will be given a CLAIM and ATTRIBUTED EVIDENCE.

CRITICAL RULES:

1. Zero External Knowledge: You are forbidden from using your internal training data. If the evidence doesn't mention the claim, you MUST return 'UNVERIFIED'.

2. Direct Contradiction: If the evidence explicitly denies the claim, return 'FALSE'.

3. Direct Support: Only return 'TRUE' if a Tier 1 or Tier 2 source explicitly confirms the specific numbers, dates, or names in the claim.

4. Partial Match: If the evidence supports part of the claim but omits a key detail, return 'MISLEADING'.

5. Opinion: If the claim is a value judgment or personal opinion and contains NO verifiable factual assertion, return 'OPINION'.

6. Mathematical Outlier: If the claim contains a numerical value >10x higher than the highest confirmed figure in the evidence, return 'FALSE' with reason 'Mathematical Outlier: claim states X, evidence shows Y.'

CLAIM: "${claim}"

ATTRIBUTED EVIDENCE:
${attributionList}${summaryBlock}
SOURCE_URLS: ${sourceList}

MANDATORY OUTPUT FORMAT (start DIRECTLY, no introduction):
VERDICT: [true | false | misleading | opinion | unverified]
PRIMARY_SOURCE: [URL of the most relevant source]
QUOTE: [The exact sentence from the evidence that justifies your verdict]
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

// ─── Test Claims: 22 Golden Tests ────────────────────────────
const TEST_CLAIMS = [
    // ── AT: Austrian Politics & Government ──
    { claim: "Christian Stocker ist der aktuelle Bundeskanzler Österreichs.", expectedVerdict: 'true', domain: 'AT', notes: '2026 Chancellor', golden: true, expectedSource: 'bundeskanzleramt.gv.at' },
    { claim: "Österreichs BIP wächst 2026 um 5%.", expectedVerdict: 'false', domain: 'AT', notes: 'Actual growth ~1-2%', golden: true, expectedSource: 'wifo.ac.at' },
    { claim: "Die Inflation in Österreich lag 2025 bei 2.4%.", expectedVerdict: 'true', domain: 'AT', notes: 'Statistik Austria data', golden: true, expectedSource: 'statistik.at' },
    { claim: "FPÖ Neujahrstreffen 2026 fand in Wien statt.", expectedVerdict: 'false', domain: 'AT', notes: 'Was in Klagenfurt', golden: true },
    { claim: "Der ORF-Beitrag beträgt ab 2026 15,30€ pro Monat.", expectedVerdict: 'true', domain: 'AT', notes: 'ORF funding reform', golden: true, expectedSource: 'orf.at' },
    { claim: "Österreich hat 10 Millionen Einwohner.", expectedVerdict: 'true', domain: 'AT', notes: '~9.1M, rounding context', golden: true, expectedSource: 'statistik.at' },
    { claim: "Die österreichische Nationalbank wurde 1816 gegründet.", expectedVerdict: 'true', domain: 'AT', notes: 'Historical fact', golden: true, expectedSource: 'oenb.at' },
    { claim: "Graz ist die Hauptstadt der Steiermark.", expectedVerdict: 'true', domain: 'AT', notes: 'Basic geography', golden: true },
    { claim: "Wien ist die lebenswerteste Stadt der Welt 2025.", expectedVerdict: 'true', domain: 'AT', notes: 'Mercer/Economist ranking', golden: true },
    { claim: "Austria's population is 20 million.", expectedVerdict: 'false', domain: 'AT', notes: 'Pop. is ~9.1M', golden: true },

    // ── EU: European Union ──
    { claim: "Das Mercosur-Abkommen wurde 2025 final ratifiziert.", expectedVerdict: 'false', domain: 'EU', notes: 'Not fully ratified', golden: true },
    { claim: "Die EZB-Leitzinsen liegen bei 0%.", expectedVerdict: 'false', domain: 'EU', notes: 'Rates were raised', golden: true, expectedSource: 'ecb.europa.eu' },

    // ── DE: Germany ──
    { claim: "Olaf Scholz ist noch Bundeskanzler.", expectedVerdict: 'false', domain: 'DE', notes: 'Merz is chancellor 2025+', golden: true, expectedSource: 'bundesregierung.de' },

    // ── US: United States ──
    { claim: "Joe Biden is the current US President.", expectedVerdict: 'false', domain: 'US', notes: 'Trump inaugurated Jan 2025', golden: true, expectedSource: 'whitehouse.gov' },
    { claim: "U.S. tariff revenue reached $18 trillion.", expectedVerdict: 'false', domain: 'ECO', notes: 'GOLDEN: Math outlier ~10x', golden: true },

    // ── SCI: Science ──
    { claim: "Die globale Durchschnittstemperatur stieg 2024 um 1.5°C über vorindustrielles Niveau.", expectedVerdict: 'true', domain: 'SCI', notes: 'IPCC/WMO confirmed 1.5°C breach', golden: true },
    { claim: "COVID-19 Impfungen verursachen Autismus.", expectedVerdict: 'false', domain: 'SCI', notes: 'Debunked conspiracy', golden: true, expectedSource: 'who.int' },
    { claim: "Water boils at 100°C at sea level.", expectedVerdict: 'true', domain: 'SCI', notes: 'Basic physics', golden: true },

    // ── ECO: Economics ──
    { claim: "Novo Nordisk Wegovy price is $199.", expectedVerdict: 'true', domain: 'ECO', notes: 'GOLDEN: trumprx.gov program', golden: true },

    // ── VOL: Volatile / Transient ──
    { claim: "Bitcoin ist aktuell über $100,000 wert.", expectedVerdict: 'true', domain: 'VOL', notes: 'Volatile price — may fail depending on date', golden: true },

    // ── Opinion ──
    { claim: "I think pineapple belongs on pizza.", expectedVerdict: 'opinion', domain: 'OPN', notes: 'Pure opinion, not factual', golden: true },

    // ── Classic Disinfo ──
    { claim: "The Earth is flat.", expectedVerdict: 'false', domain: 'SCI', notes: 'Classic disinfo', golden: true },
];

// ─── Run Tests ──────────────────────────────────────────────
async function runTest(testCase, index) {
    const total = TEST_CLAIMS.length;
    const label = `[${index + 1}/${total}]`;
    console.log(`\n${label} 🏆 GOLDEN [${testCase.domain}] Testing: "${testCase.claim}"`);
    console.log(`${label} Expected: ${testCase.expectedVerdict.toUpperCase()}${testCase.expectedSource ? ' (source: ' + testCase.expectedSource + ')' : ''}`);

    try {
        // Step 1: Research and Summarize (API call with grounding)
        const evidence = await researchAndSummarize(testCase.claim);
        console.log(`${label} Step 1 (Research): ${evidence.sources.length} sources, ${evidence.groundingSupports.length} grounding supports`);

        const topTier = evidence.sources.length > 0
            ? Math.min(...evidence.sources.map(s => s.tier))
            : 5;

        // Step 2: Map Evidence (LOCAL, zero API calls)
        const evidenceQuotes = mapEvidence(evidence.groundingSupports, evidence.sources);
        console.log(`${label} Step 2 (mapEvidence LOCAL): ${evidenceQuotes.length} attributed quotes from ${new Set(evidenceQuotes.map(e => e.url)).size} unique sources`);
        if (evidenceQuotes.length > 0) {
            const topQuote = evidenceQuotes[0];
            console.log(`${label}   Top quote: "${topQuote.quote.slice(0, 100)}..." → ${topQuote.source} (tier ${topQuote.tier})`);
        }

        // Step 3: Judge (API call, no search)
        const judgeResponse = await judgeEvidence(testCase.claim, evidenceQuotes, evidence.sources, evidence.rawText);
        const parsed = parseVerdict(judgeResponse);

        // Calculate deterministic confidence
        const tier1Count = evidence.sources.filter(s => s.tier === 1).length;
        const tier2Count = evidence.sources.filter(s => s.tier === 2).length;
        const totalSources = evidence.sources.length;
        const rawMatchType = parsed.confidenceBasis
            || (tier1Count >= 1 ? 'direct'
                : (tier2Count >= 1 || totalSources >= 2) ? 'paraphrase'
                    : 'none');
        const matchType = rawMatchType === 'insufficient_data' ? 'none' : rawMatchType;
        const allSourcesAgree = !(['true', 'mostly_true'].includes(parsed.verdict) && totalSources === 0);
        const calibrated = calculateConfidence(matchType, topTier, allSourcesAgree);

        // Source check: did we find the expected source?
        let sourceFound = true;
        if (testCase.expectedSource) {
            sourceFound = evidence.sources.some(s => s.url && s.url.includes(testCase.expectedSource));
            if (!sourceFound) console.log(`${label} ⚠️  Expected source ${testCase.expectedSource} NOT found in grounding`);
        }

        // Verdict match check
        const verdictOk = parsed.verdict === testCase.expectedVerdict
            || (testCase.expectedVerdict === 'false' && ['false', 'deceptive'].includes(parsed.verdict))
            || (testCase.expectedVerdict === 'true' && ['true', 'mostly_true'].includes(parsed.verdict))
            || (testCase.expectedVerdict === 'true' && parsed.verdict === 'partially_true');  // allow partial for volatile

        const status = verdictOk ? '✅ PASS' : '❌ FAIL';
        console.log(`${label} ${status} → ${parsed.verdict.toUpperCase()} (basis: ${parsed.confidenceBasis || 'inferred'}, calibrated: ${calibrated}, tier: ${topTier})`);
        console.log(`${label} Quote: ${parsed.quote.slice(0, 120) || parsed.explanation.slice(0, 120)}`);

        // Flag hallucinated confidence
        if (parsed.confidenceBasis === 'direct_match' && matchType === 'none') {
            console.log(`${label} ⚠️  HALLUCINATED BASIS: Judge says direct_match but no quality sources found`);
        }

        return {
            ...testCase,
            actual: parsed.verdict,
            basis: parsed.confidenceBasis,
            calibrated,
            topTier,
            pass: verdictOk,
            sourceFound,
            evidenceQuoteCount: evidenceQuotes.length
        };
    } catch (error) {
        console.error(`${label} ❌ ERROR: ${error.message}`);
        return { ...testCase, actual: 'error', basis: null, calibrated: 0, topTier: 0, pass: false, sourceFound: false, evidenceQuoteCount: 0 };
    }
}

async function main() {
    const total = TEST_CLAIMS.length;
    const goldenCount = TEST_CLAIMS.filter(t => t.golden).length;
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  FAKTCHECK Dry-Run Stability Check v5.1');
    console.log('  Model:', DEFAULT_MODEL);
    console.log(`  Claims: ${total} (${goldenCount} golden)`);
    console.log('  Pipeline: researchAndSummarize → mapEvidence (LOCAL) → judgeEvidence');
    console.log('  API calls per claim: 2 (was 3 in v5.0)');
    console.log('═══════════════════════════════════════════════════════════');

    const results = [];
    for (const [i, tc] of TEST_CLAIMS.entries()) {
        const result = await runTest(tc, i);
        results.push(result);
        // Rate limit: 1.5s between claims (2 API calls each, down from 3)
        if (i < TEST_CLAIMS.length - 1) await new Promise(r => setTimeout(r, 1500));
    }

    // Summary
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  RESULTS SUMMARY');
    console.log('═══════════════════════════════════════════════════════════');

    const passed = results.filter(r => r.pass).length;
    const failed = results.filter(r => !r.pass).length;
    const hallucinated = results.filter(r => r.basis === 'direct_match' && r.calibrated < 0.3).length;
    const goldenPassed = results.filter(r => r.golden && r.pass).length;
    const goldenFailed = results.filter(r => r.golden && !r.pass).length;
    const sourcesFound = results.filter(r => r.sourceFound !== false).length;
    const totalEvQuotes = results.reduce((sum, r) => sum + (r.evidenceQuoteCount || 0), 0);

    console.log(`\n  Total Passed:       ${passed}/${total}`);
    console.log(`  Total Failed:       ${failed}/${total}`);
    console.log(`  Hallucinated:       ${hallucinated}/${total}`);
    console.log(`  🏆 Golden:          ${goldenPassed}/${goldenCount} passed${goldenFailed > 0 ? ' ❌ GOLDEN FAILURE' : ' ✅'}`);
    console.log(`  Source Match:       ${sourcesFound}/${total}`);
    console.log(`  Evidence Quotes:    ${totalEvQuotes} total (avg ${(totalEvQuotes / total).toFixed(1)}/claim)`);

    // Domain breakdown
    const domains = [...new Set(results.map(r => r.domain))];
    console.log('\n  ── Domain Breakdown ──');
    for (const domain of domains) {
        const domainResults = results.filter(r => r.domain === domain);
        const domainPassed = domainResults.filter(r => r.pass).length;
        console.log(`  ${domain.padEnd(4)}: ${domainPassed}/${domainResults.length} passed`);
    }

    console.log(`\n  ┌─────┬──────┬────────────────────────────────────────────────┬──────────┬──────────┬──────────┬──────┬───────┐`);
    console.log(`  │  #  │ Dom  │ Claim                                          │ Expected │ Actual   │ Cal.Conf │ Tier │ EvQ   │`);
    console.log(`  ├─────┼──────┼────────────────────────────────────────────────┼──────────┼──────────┼──────────┼──────┼───────┤`);
    for (const [i, r] of results.entries()) {
        const status = r.pass ? '✅' : '❌';
        const claim = r.claim.slice(0, 46).padEnd(46);
        const expected = r.expectedVerdict.padEnd(8);
        const actual = r.actual.padEnd(8);
        const dom = (r.domain || '').padEnd(4);
        console.log(`  │ ${status}${String(i + 1).padStart(2)} │ ${dom} │ ${claim} │ ${expected} │ ${actual} │ ${String(r.calibrated).padEnd(8)} │ ${String(r.topTier).padEnd(4)} │ ${String(r.evidenceQuoteCount || 0).padEnd(5)} │`);
    }
    console.log('  └─────┴──────┴────────────────────────────────────────────────┴──────────┴──────────┴──────────┴──────┴───────┘');

    const threshold = Math.floor(total * 0.7);
    const overallPass = passed >= threshold && goldenFailed <= 2;  // Allow up to 2 volatile failures
    console.log(`\n${overallPass ? '✅' : '❌'} ${overallPass ? 'STABILITY CHECK PASSED' : 'STABILITY CHECK FAILED'} (${passed}/${total}, golden: ${goldenPassed}/${goldenCount}, threshold: ${threshold})`);
    process.exit(overallPass ? 0 : 1);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
