// ============================================================
// FAKTCHECK v3.0 — PHASE 2: VERIFICATION PROMPT (Gemini-optimized)
// ============================================================
// Key changes from v2:
// - Search queries come pre-decomposed from extraction phase
// - CONTRADICTION query only fires for causal claims
// - Source tier detection built into prompt
// - Gemini google_search tool integration via function calling
// - Explicit instruction to DECIDE (not default to unverifiable)

/**
 * Builds the verification prompt for a given claim.
 * @param {Object} claim - Extracted claim object from Phase 1
 * @param {string} claim.claim - The hydrated claim text
 * @param {string[]} claim.search_queries - Pre-decomposed search queries
 * @param {string[]} claim.anchors - Entity anchors
 * @param {string} claim.type - factual|causal|opinion|satire
 * @returns {string} The verification prompt
 */
function buildVerificationPrompt(claim) {
    const basePrompt = `
Du bist ein investigativer Faktenprüfer. Verifiziere den folgenden Claim.

## CLAIM
"${claim.claim}"

## CLAIM-TYP: ${claim.type}

## SUCHSTRATEGIE
Verwende das google_search Tool mit folgenden Queries (nacheinander):

### Query 1 (STATUS): "${claim.search_queries[0]}"
### Query 2 (KONTEXT): "${claim.search_queries[1] || claim.anchors.join(' ')}"
`;

    // Only add contradiction query for causal claims
    const causalAddition = claim.type === 'causal' ? `
### Query 3 (TIMELINE-WIDERSPRUCH): "${claim.search_queries[2] || claim.anchors[0] + ' Datum Timeline'}"

## TIMELINE-PRÜFUNG (nur für kausale Claims!)
Wenn du Datumsangaben findest:
- Notiere intent_date: Wann wurde die angebliche FOLGE geplant/angekündigt?
- Notiere trigger_date: Wann passierte die angebliche URSACHE?
- Wenn intent_date VOR trigger_date → Die Kausalität ist falsch
` : '';

    const verdictInstructions = `

## QUELLEN-BEWERTUNG
Bewerte jede gefundene Quelle:
- Tier 1 (Offizielle Quelle): parlament.gv.at, ris.bka.gv.at, orf.at, 
  bundeskanzleramt.gv.at, bmj.gv.at — EINE Tier-1 Quelle reicht für "true"
- Tier 2 (Qualitätsmedien): derstandard.at, diepresse.com, wienerzeitung.at,
  profil.at, falter.at — ZWEI Tier-2 Quellen reichen für "true"
- Tier 3 (Sonstige): Alle anderen — ZWEI Tier-3 + keine Widersprüche für "true"

## ENTSCHEIDUNGSREGELN
Du MUSST eine Entscheidung treffen. "unverifiable" ist NUR erlaubt wenn
NULL relevante Quellen gefunden wurden.

${claim.type === 'factual' ? `
### Für faktische Claims:
- Quelle bestätigt → "true" (confidence basierend auf Quellen-Tier)
- Quelle widerspricht → "false"
- Kern stimmt, Details weichen ab → "partially_true"
- Keine Quellen → "unverifiable"
` : ''}
${claim.type === 'causal' ? `
### Für kausale Claims:
- Kausalität belegt → "true" (max confidence 0.70)
- Fakten stimmen, aber Kausalität unbewiesen → "partially_true"
- Timeline-Widerspruch → "deceptive"
- Kausalität widerlegt → "false"
` : ''}
${claim.type === 'opinion' ? `
### Für Meinungen:
- Prüfe ob die Person das tatsächlich gesagt hat
- Wenn belegt → "opinion" mit Quellenangabe
- Wenn nicht belegt → "unverifiable"
` : ''}

## OUTPUT FORMAT
Antworte NUR mit JSON. Kein Markdown, keine Backticks.

{
  "verdict": "true|false|partially_true|deceptive|unverifiable|opinion",
  "confidence": 0.85,
  "explanation": "Kurze Begründung mit Verweis auf Quellen.",
  "key_facts": ["Fakt 1", "Fakt 2"],
  "sources": [
    {"title": "Quellentitel", "url": "https://...", "tier": 1}
  ]${claim.type === 'causal' ? `,
  "timeline": {
    "intent_date": "YYYY-MM-DD oder null",
    "trigger_date": "YYYY-MM-DD oder null"
  }` : ''}
}`;

    return basePrompt + causalAddition + verdictInstructions;
}

export { buildVerificationPrompt };
