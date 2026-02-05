# FAKTCHECK v3.0 — Architecture & Migration Guide

## Summary of Changes

The v2 system had a structural bias toward "unverifiable" because three mechanisms
compounded to suppress verdicts:

1. **Causal over-triggering** — any timeline data activated the 0.70 confidence cap
2. **Strict source threshold** — 2+ independent sources required, but Austrian parliamentary
   sources rarely appear in more than 1-2 outlets
3. **Aggressive contradiction search** — the CONTRADICTION query fired on ALL claims,
   pulling in noise that confused the verdict logic

v3 fixes all three while adding source-tier intelligence and robust Gemini JSON handling.

---

## Architecture

```
┌──────────────┐    ┌──────────────────┐    ┌──────────────────┐    ┌──────────────┐
│  EXTRACTION  │ ─▶ │ QUERY DECOMPOSE  │ ─▶ │  VERIFICATION    │ ─▶ │   VERDICT    │
│  (Gemini)    │    │ (in prompt)      │    │  (Gemini+Search) │    │   ENGINE     │
└──────────────┘    └──────────────────┘    └──────────────────┘    └──────────────┘
                                                                          │
                                                                    ┌─────┴──────┐
                                                                    │  CAUSAL?   │
                                                                    │  (opt-in)  │
                                                                    └────────────┘
```

### What's new: Query Decomposition

The extraction prompt now outputs `search_queries[]` — short 3-6 word keyword
combinations optimized for Google Search. The full hydrated claim is kept as
internal reference but NOT sent to Google directly.

**Before (v2):**
```
Claim → Google: "Christian Hafenecker behauptet im Pilnacek-U-Ausschuss..."
Result: 0-1 relevant hits
```

**After (v3):**
```
Claim → Google: "Hafenecker Vorbereitungskurse Zeugen U-Ausschuss"
              → Google: "ÖVP Anwälte Auskunftspersonen Pilnacek"
Result: 3-5 relevant hits
```

---

## Decision Matrix v3

| Scenario | Condition | Verdict | Confidence | Change from v2 |
|---|---|---|---|---|
| Confirmed (Tier-1 source) | 1 source from parlament.gv.at, orf.at, etc. | `true` | ≥0.85 | **NEW** — 1 is enough |
| Confirmed (Tier-2 sources) | 2+ sources from Standard, Presse, etc. | `true` | ≥0.80 | **NEW** — tier-aware |
| Confirmed (Tier-3 only) | 2+ low-tier sources, no contradictions | `true` | 0.65-0.75 | Same as v2 |
| Weak confirmation | 1 low-tier source only | `partially_true` | ≤0.60 | **NEW** — auto-downgrade |
| Refuted | Official data contradicts | `false` | ≥0.80 | Same |
| Causal confirmed | A→B proven with evidence | `true` | ≤0.70 | Cap only for causal |
| Causal unproven | Facts true, link unproven | `partially_true` | ≤0.65 | **NEW** — not undecided |
| Timeline contradiction | Intent before Trigger | `deceptive` | 0.90 | Reduced from 0.95 |
| No sources | Zero relevant results | `unverifiable` | 0.30-0.50 | Same |
| Opinion/value judgment | Person stated opinion | `opinion` | 0.70+ | **NEW** category |

---

## Display Mapping v3

| Internal Verdict | Display | Color | Change |
|---|---|---|---|
| `true`, `mostly_true` | Bestätigt ✅ | 🟢 Green | Same |
| `false`, `mostly_false` | Falsch ❌ | 🔴 Red | Same |
| `deceptive` | Irreführend ⚠️ | 🟠 Orange | **NEW** — was Red |
| `partially_true`, `misleading` | Teilweise wahr ⚡ | 🟡 Yellow | Same |
| `unverifiable` | Nicht überprüfbar ❓ | ⚪ Gray | Same |
| `opinion` | Meinung 💬 | 🟣 Purple | **NEW** |

---

## Gemini-Specific Considerations

### JSON Response Handling

Gemini frequently wraps JSON in markdown code fences despite explicit instructions.
The `extractJSON()` utility handles:

- ` ```json\n{...}\n``` ` wrapping
- Preamble text before JSON (e.g., "Here is the result:\n{...}")
- Truncated JSON from max_tokens limits
- Nested bracket matching for reliable extraction

### Gemini 2.0 Flash `response_mime_type`

When using `gemini-2.0-flash`, we set `response_mime_type: "application/json"`
in `generationConfig`. This significantly reduces (but doesn't eliminate)
markdown wrapping. The `extractJSON` fallback remains essential.

### google_search Tool

The `tools: [{ google_search: {} }]` configuration enables Gemini's built-in
grounding with Google Search. Key behaviors:

- Gemini decides when to search based on the prompt
- Search results are included in the response's `groundingMetadata`
- We rely on the text response for verdicts, not raw search results
- The pre-decomposed `search_queries` in the prompt guide Gemini's searches

### Model Fallback

If `gemini-2.0-flash` returns a 4xx/5xx, we automatically retry with
`gemini-1.5-flash-latest`. Note that 1.5-flash does NOT support
`response_mime_type`, so JSON extraction is even more critical there.

---

## Source Tier Domains

### Tier 1 — Official/Parliamentary (1 source = sufficient)
- `parlament.gv.at` — Parliamentary protocols
- `ris.bka.gv.at` — Legal information system
- `orf.at` — Public broadcaster
- `bundeskanzleramt.gv.at` — Federal Chancellery
- `bmj.gv.at` — Ministry of Justice
- `bmi.gv.at` — Ministry of Interior
- `rechnungshof.gv.at` — Court of Audit

### Tier 2 — Quality Media (2 sources = sufficient)
- `derstandard.at`, `diepresse.com`, `wienerzeitung.at`
- `profil.at`, `falter.at`, `kurier.at`
- `kleinezeitung.at`, `news.at`, `apa.at`

### Tier 3 — All others (2+ with no contradictions)

---

## Migration Checklist

- [ ] Replace `extraction.js` prompt with v3 version (adds `search_queries` output)
- [ ] Replace `verification.js` prompt builder (conditional CONTRADICTION query)
- [ ] Replace `validateVerification()` with v3 verdict engine
- [ ] Add `display-config.js` with new color/label mapping
- [ ] Update UI to handle `deceptive` (orange) and `opinion` (purple) display verdicts
- [ ] Update localStorage cache key format (v3 adds `search_queries` to claim hash)
- [ ] Test with 10+ known Austrian parliamentary claims to validate source-tier logic
- [ ] Verify Gemini 2.0 flash `response_mime_type` works in your API version

---

## Files

| File | Purpose |
|---|---|
| `prompts/extraction.js` | Phase 1: Claim extraction & hydration with query decomposition |
| `prompts/verification.js` | Phase 2: Verification prompt builder (type-aware) |
| `verdict-engine.js` | Phase 3: Validation, source-tiering, causal pipeline, Gemini JSON parsing |
| `display-config.js` | UI display mapping with new deceptive/opinion categories |
| `FAKTCHECK_v3.md` | This document |
