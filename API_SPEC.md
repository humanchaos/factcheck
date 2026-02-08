# API Specification

> FAKTCHECK v2.1.0 — Structured JSON output schema and pipeline reference.

## Judge Response Schema

Stage 3 (`judgeEvidence`) returns this JSON via `response_mime_type: "application/json"`:

```json
{
  "verdict": "true | false | partially_true | opinion | unverifiable",
  "confidence": 0.85,
  "math_outlier": false,
  "reasoning": "The evidence from WIFO confirms GDP growth of 1.2%, not 5%.",
  "primary_source": "https://wifo.ac.at/...",
  "quote": "WIFO projects a GDP growth of 1.2% for Austria in 2026.",
  "confidence_basis": "direct_match | paraphrase | insufficient_data",
  "evidence_chain": [
    {
      "source_name": "WIFO",
      "url": "https://wifo.ac.at/report-2026",
      "quote": "GDP growth for Austria is projected at 1.2% in 2026.",
      "tier": 1,
      "sentiment": "contradicting"
    }
  ]
}
```

### Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `verdict` | string | ✅ | One of: `true`, `false`, `partially_true`, `opinion`, `unverifiable` |
| `confidence` | number | ✅ | 0.0–1.0, calculated by `validateVerification()` |
| `math_outlier` | boolean | ✅ | `true` if the Math Guardrail (10× rule) was triggered |
| `reasoning` | string | ✅ | Human-readable explanation of the verdict |
| `primary_source` | string | | URL of the most relevant source |
| `quote` | string | | Exact sentence from the snippet justifying the verdict |
| `confidence_basis` | string | | One of: `direct_match`, `paraphrase`, `insufficient_data` |
| `evidence_chain` | array | | Attributed evidence items (see below) |

### Evidence Chain Item

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `source_name` | string | ✅ | Human-readable source name (e.g., "WIFO", "ORF") |
| `url` | string | | Full URL to the source |
| `quote` | string | ✅ | Exact attributed quote from the source |
| `tier` | integer | | Source tier (1–5), see below |
| `sentiment` | string | ✅ | One of: `supporting`, `contradicting` |

---

## Source Tier Classification

Sources are classified using the [global registry](assets/registry/sources-global.json) (57+ domains):

| Tier | Icon | Category | Authority Level |
|------|------|----------|-----------------|
| **1** | 🏛️ | Government / Official | Highest — `.gov`, `.gv.at`, UN, WHO, central banks |
| **1** | 🌍 | Wire Agencies | Highest — Reuters, AP, AFP, APA |
| **2** | 📰 | Public Broadcasters | High — BBC, ORF, Tagesschau, PBS |
| **2** | 📡 | News of Record | High — NYT, Der Standard, Die Presse |
| **3** | ✅ | Fact-Checkers | Specialized — Snopes, PolitiFact, Mimikama |
| **4** | 📄 | General / Unclassified | Default — unknown domains |
| **5** | ⚠️ | Unreliable | Flagged — RT, InfoWars, Sputnik |

### Tier in Confidence Calculation

```
Confidence = Base × SourceTierMultiplier × AgreementFactor
```

| Tier | Multiplier |
|------|------------|
| 1 | 1.0 |
| 2 | 0.85 |
| 3 | 0.75 |
| 4 | 0.5 |
| 5 | 0.2 |

### v5.4 Confidence Modifiers

| Modifier | Effect | Trigger |
|----------|--------|---------|
| **Tier-1 Boost** | ×1.5 | Top source is Tier 1 |
| **Self-Referential Malus** | ×0.2 (max 0.1) | Only sources are YouTube/video origin |
| **Tier-1 Override** | Force `false` | Tier-1 contradicts positive LLM verdict |
| **Self-Ref Auto-Downgrade** | Verdict → `unverifiable` | Only self-referential sources exist |

---

## Pipeline Stages

### Tier 0 — `searchFactChecks(claim, apiKey, lang)`

Checks the [Google Fact Check Tools API](https://developers.google.com/fact-check/reference/rest) for existing professional fact-checks.

- **Cost:** Free (no Gemini API call)
- **Returns:** Array of `{ claim, reviews: [{ publisher, rating, url }] }`
- **If match found:** Result passed directly to UI as `🏆 Professional Fact-Check`

### Tier 1A — `queryWikidata(entityName)`

Resolves entity names to Wikidata QIDs and official properties.

- **Cost:** Free
- **API:** `wbsearchentities` + `wbgetentities`
- **Properties:** P39 (position held), P580 (start date)
- **Example:** `"Christian Stocker"` → `Q114834789`, Bundeskanzler since 2025-03-03

### Tier 1B — `queryEurostat(indicator, geo, year)`

Fetches hard economic data from the EU statistics bureau.

- **Cost:** Free
- **Supported indicators:** `gdp_growth`, `inflation`, `population`, `unemployment`
- **Supported countries:** AT, DE, FR, IT, EU27
- **Example:** `queryEurostat("gdp_growth", "AT", "2026")` → `{ value: 1.2, unit: "%" }`

### Tier 2 — `searchOnly(claim, apiKey)`

Gemini 2.0 Flash with Google Search grounding. Returns raw snippets and `groundingMetadata`.

- **Cost:** 1 Gemini API call
- **Returns:** `{ rawText, sources, groundingSupports, groundingChunks }`

### Local — `mapEvidence(groundingSupports, sources)`

Maps `groundingSupports` to source URLs. Zero API calls, zero cost.

- **Returns:** Array of `{ quote, source, url, tier, icon, sourceType }`
- **Key property:** Hallucination-proof — quotes come from Google grounding, not LLM generation

### Judge — `judgeEvidence(claim, snippets, sources, apiKey, lang, claimType, facts)`

Gemini 2.0 Flash in JSON mode (`response_mime_type: application/json`). No search grounding.

- **Cost:** 1 Gemini API call
- **Input:** Claim + attributed evidence + Tier 1 structured data + fact-check context
- **Output:** Structured JSON (see schema above)
- **System Prompt:** "Unbestechlicher Faktenprüfer" with BEWERTUNGS-LOGIK:
  1. Realitäts-Primat — Video ≠ evidence
  2. Tier-1 Dominanz — Official data overrides assertions
  3. Confidence-Malus — Video-only → 0.1
  4. Metaphern-Erkennung — Check factual core, not rhetoric
  5–8. Verdict rules + Math Guardrail + Causality check
  - **ABSCHLUSS-PRÜFUNG:** "Is there official data contradicting this core claim?"
- **Fallback:** If JSON mode fails, falls back to text mode with regex parsing

### Stage 2 — `extractClaims(transcript, metadata, apiKey, lang)`

Extracts atomic factual claims from a video transcript.

- **Cost:** 1 Gemini API call
- **Processing Steps:**
  1. **Semantic Stripping** — Removes attribution shells (prompt + `stripAttribution()` post-processing)
  2. **Entity Hydration** — Resolves partial names and pronouns from context
  3. **Atomisierung** — One fact per entry, opinions get `type: "opinion"`
- **Output schema:**

```json
[
  {
    "claim": "Österreich liegt beim Wirtschaftswachstum auf Platz 185 von 191.",
    "type": "statistic",
    "speaker": "Herbert Kickl",
    "checkable": true,
    "search_queries": ["Österreich Wirtschaftswachstum Ranking IMF 2024"]
  }
]
```

### `stripAttribution(claimText)`

Code-level post-processor for removing attribution shells.

- **Patterns:** 11 regex (8 DE + 3 EN)
- **Validation:** `test-stage2-validation.js` — 10/10 (100%)
- **Example:** `"Laut FPÖ TV liegt Österreich auf Platz 185"` → `"Österreich auf Platz 185"`

---

## Math Guardrail

Hard code-level safeguard in `validateVerification()`:

```
Ratio = ClaimValue / EvidenceValue

If Ratio ≥ 10 or Ratio ≤ 0.1:
  verdict = "false"
  math_outlier = true
```

This fires **after** the judge returns its verdict and can override AI output.
