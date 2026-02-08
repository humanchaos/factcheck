# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.0] - 2026-02-08 — "v5.4 Stable" ✅

### Added
- **Deterministic Confidence Formula:** `Confidence = min(0.95, Σ(S_i × W_i) × V_c)` — per-source scoring based on source tier (S_i), recency weight (W_i), and verdict consistency (V_c). No LLM-generated confidence values.
- **Source Sanitization:** YouTube and Wikipedia sources automatically filtered from confidence calculation and source lists. YouTube-only claims → `unverifiable` at 0.1 confidence.
- **Semantic Deduplication:** `hashClaim()` now strips punctuation and preserves umlauts for SHA-256 hashing. "Platz 185." and "platz 185" now hit the same cache entry.
- **Always-Visible Feedback:** 👍/👎 buttons moved from hidden evidence chain to card surface — visible without expanding.
- **Standalone Test Module:** `calculateConfidence.js` extracted for Jest testing (9/9 green).
- **Global Wildcards:** Added `.gov.uk`, `.go.jp`, `.edu.au`, `.mil` to source registry.

### Fixed
- **Confidence Regression:** Two compounding bugs suppressed confidence to max 0.40:
  - Null timestamps defaulted to `currentYear-3` (W_i=0.5 for every source)
  - FALSE verdicts set all sources to 'contradicting' (V_c=0.5, halving again)
  - Combined: Tier-1 scored 0.125 instead of 0.50. Now fixed.

### Changed
- **Self-Referential Malus:** Simplified to party/propaganda domains only (YouTube handled upstream by sanitization).
- **Confidence Capping:** Hard cap at 0.95, floor at 0.10.

## [2.1.0] - 2026-02-08 — "The Ground Truth" (v5.4)

### Added
- **Stage 2: Semantic Core Extraction** — Complete prompt rewrite for `extractClaims()`:
  - **Semantic Stripping:** Removes attribution shells ("Laut...", "Kickl sagt...", "Im Video wird erklärt...") to isolate atomic factual cores. 11 regex patterns (8 DE + 3 EN) guaranteed at code level via `stripAttribution()`.
  - **Entity Hydration:** Resolves partial names and pronouns using transcript context (e.g., "Stocker" → "Christian Stocker").
  - **Atomisierung:** Separates facts from opinions, each as an individual entry with `type: "opinion"` where appropriate.
- **Stage 3: Reality-First Judging** — Hardened `judgeEvidence()` prompts:
  - **Realitäts-Primat:** Video transcript is NOT evidence — only external data counts.
  - **Tier-1 Dominanz:** Official sources (WIFO, Statistik Austria, IMF, Eurostat) override speaker assertions.
  - **Confidence-Malus:** Video-only sources → confidence capped at 0.1, verdict → `unverifiable`.
  - **Metaphern-Erkennung:** Political exaggerations checked against real data, not taken at face value.
  - **ABSCHLUSS-PRÜFUNG:** Final check: "Is there official data contradicting this core claim?"
- **`stripAttribution()` Function:** Code-level guarantee against attribution shells. Post-processes every extracted claim.
- **`test-stage2-validation.js`:** 22-claim validation script for attribution stripping accuracy (10/10 = 100%).

### Changed
- **Confidence Calculation:** `calculateConfidence()` now applies Tier-1 boost (×1.5), capped at 1.0. *(Superseded by v2.2.0 deterministic formula)*
- **Self-Referential Source Malus:** Hardened to ×0.2 penalty, confidence capped at ≤0.1, auto-downgrade to `unverifiable`.
- **Tier-1 Override:** If Tier-1 sources contradict a positive LLM verdict, verdict forced to `false`.
- **Judge Prompt:** "Unbestechlicher Faktenprüfer" with BEWERTUNGS-LOGIK (8 rules) replaces previous "strikt gebundener Verifikationsrichter".
- **Golden Tests:** 22/22 (100%) — up from 21/22.

## [2.0.0] - 2026-02-07

### Added
- **Tier 1A — Wikidata Entity Hydration:** `queryWikidata()` resolves entity names to Wikidata QIDs, fetches official position (P39) and start date (P580). Prevents name/title hallucinations.
- **Tier 1B — Eurostat Statistical API:** `queryEurostat()` fetches GDP growth, inflation, population, and unemployment directly from the EU statistics bureau. Hard numbers feed the Math Guardrail.
- **4-Tier Verification Pipeline:** `verifyClaim()` now cascades Tier 0 → Tier 1A → Tier 1B → Tier 2 → Judge. All Tier 1 calls are fallback-safe.
- **Structured JSON Judge:** `callGeminiJSON()` with `response_mime_type: application/json` and `response_schema`. Judge returns `{ verdict, confidence, math_outlier, reasoning, evidence_chain }` directly — eliminates regex parsing.
- **Math Outlier Warning Box:** Orange/red gradient alert in Evidence Chain when `math_outlier: true`.
- **Debate Mode UI:** 🟢 Bestätigend / 🔴 Widersprechend split view with keyword heuristics.
- **Feedback System:** 👍/👎 per claim + 🚩 Source Report per evidence quote, stored in `chrome.storage.local`.

### Changed
- **`judgeEvidence()`:** Now uses JSON mode primary with text fallback. Schema enforces structured output.
- **`verifyClaim()`:** Dual-path parsing — `typeof === 'object'` for JSON, regex chain for text fallback.
- **`manifest.json`:** Added `wikidata.org` and `ec.europa.eu` host permissions for Tier 1 APIs.

## [0.2.0] - 2026-02-07

### Added
- **Three-Stage Pipeline:** `searchOnly` → `extractFacts` → `judgeEvidence` — Separation of Powers ensures no single AI call does both retrieval and judgment.
- **Structured Fact Triplets:** `extractFacts()` now returns `{subject, relation, object, snippet, sentiment}` JSON objects, classified as `supporting`, `contradicting`, or `nuanced`.
- **Debate Mode UI:** When evidence conflicts, the sidebar evidence chain displays a 🟢/🔴 split view with *Evidence For* vs. *Evidence Against*.
- **Domain-Aware Authority Icons:** Source tier badges now show domain-type icons (🏛️ gov, 📰 psb, 🌍 agency, 📡 news, ✅ factcheck, ⚠️ disinfo) via `typeIcons` in `sources-global.json`.
- **Mathematical Outlier Guardrail:** `judgeEvidence` detects claims with numbers >10× higher than evidence and returns `FALSE` with a specific reason.
- **Source Click Tracking (v1):** Every source link click is logged to `chrome.storage.local` for future Source Decay weighting.
- **Deterministic Confidence:** `Confidence = Base × SourceTier × Agreement` — formula-based, no LLM scoring.
- **Evidence Chain UI:** Expandable proof cards with tier badges, smoking gun quotes, domain icons, and verification links.

### Changed
- **Source Tiers:** Expanded from 4-tier to 5-tier system. Tier 5 marks known unreliable sources (RT, InfoWars, Sputnik).
- **Source Registry:** Added `typeIcons` lookup table to `sources-global.json` for domain-aware iconography.
- **`validateVerification()`:** Now passes `evidence[]` and `is_debated` through to frontend.
- **`sanitizeClaim()`:** Whitelists `evidence`, `is_debated`, `icon`, `sourceType` with proper sanitization.
- **Test Runner:** `test-dryrun.js` updated to match structured triplet format.

## [0.1.0] - 2026-02-07

### Added
- **Multilingual i18n**: Full UI support for 6 languages (DE, EN, FR, ES, IT, PT) with browser auto-detection and live language switching via popup.
- **Sponsor/Support Links**: "Buy me a coffee" and "GitHub Sponsors" buttons in extension popup, `.github/FUNDING.yml` for repo Sponsor button.
- **Community Roadmap**: 3-phase roadmap (Foundation → Performance → Trust Engine) in README.
- **Social Preview**: Generated branded social preview image for GitHub link previews.
- **Good First Issue Template**: Reusable issue template for onboarding new contributors.

### Changed
- **Version aligned**: Manifest, popup, and CHANGELOG now all use `0.1.0`.
- **Expanded language detection**: `background.js` `detectLang()` now detects DE, FR, ES, IT, PT (was DE-only).

## [0.1.0-alpha] - 2026-02-06

### Added
- **Mission-Driven README**: Completely overhauled the project documentation to focus on democratic integrity and real-time YouTube fact-checking.
- **Project Governance**: Added `CODE_OF_CONDUCT.md` to ensure a professional and inclusive environment for all contributors.
- **Legal Foundation**: Established the MIT License to allow for maximum open-source growth and legal safety.
- **Developer Onboarding**: Created `CONTRIBUTING.md` with clear instructions for manual Chrome Extension installation and local development.
- **Safety Documentation**: Added `SECURITY.md` for vulnerability reporting and `PRIVACY.md` to define our privacy-first data handling.
- **The Trust Policy**: Created `SOURCES.md` to define the criteria for "Trusted Sources" within the tool's logic.
- **Automation**: Implemented a GitHub Actions CI/CD pipeline (`ci.yml`) to automatically check for code errors on every Pull Request.
- **Issue Templates**: Set up standardized templates for Bug Reports and Feature Requests to streamline feedback.

### Fixed
- **Repository Structure**: Organized core files and added `.gitignore` to prevent credential leakage.

### Challenged (Roadmap)
- **The API Key Problem**: Opened a major architectural issue to find ways to remove the requirement for individual user API keys.
- **The Trust Engine**: Initiated the design phase for the weighted consensus model for factual verification.
