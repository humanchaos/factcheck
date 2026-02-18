# Testing Guide

> FAKTCHECK v2.3.0 — Quality assurance, golden tests, Quality Gate, and release criteria.

## The 22 Golden Tests

Every release must pass this test suite. A test is **PASS** only when the verdict matches the expected result. The **Assessment Ratio** must be **≥90%** (≥20/22).

### Running the Tests

```bash
GEMINI_API_KEY=your_key_here node test-dryrun.js
```

### Test Matrix

| # | Domain | Claim | Expected Verdict | Key Source |
|---|--------|-------|-----------------|------------|
| 1 | 🇦🇹 AT | Christian Stocker ist der aktuelle Bundeskanzler Österreichs | `true` | bundeskanzleramt.gv.at |
| 2 | 🇦🇹 AT | Österreichs BIP wächst 2026 um 5% | `false` | wifo.ac.at |
| 3 | 🇦🇹 AT | Die Inflation in Österreich lag 2025 bei 2.4% | `any` | statistik.at |
| 4 | 🇦🇹 AT | FPÖ Neujahrstreffen 2026 fand in Wien statt | `false` | — |
| 5 | 🇦🇹 AT | Der ORF-Beitrag beträgt ab 2026 15,30€ pro Monat | `true` | orf.at |
| 6 | 🇦🇹 AT | Österreich hat 10 Millionen Einwohner | `any` | statistik.at |
| 7 | 🇦🇹 AT | Die österreichische Nationalbank wurde 1816 gegründet | `true` | oenb.at |
| 8 | 🇦🇹 AT | Graz ist die Hauptstadt der Steiermark | `true` | — |
| 9 | 🇦🇹 AT | Wien ist die lebenswerteste Stadt der Welt 2025 | `any` | — |
| 10 | 🇦🇹 AT | Austria's population is 20 million | `false` | — |
| 11 | 🇪🇺 EU | Das Mercosur-Abkommen wurde 2025 final ratifiziert | `false`/`partially_true` | — |
| 12 | 🇪🇺 EU | Die EZB-Leitzinsen liegen bei 0% | `false` | ecb.europa.eu |
| 13 | 🇩🇪 DE | Olaf Scholz ist noch Bundeskanzler | `false` | bundesregierung.de |
| 14 | 🇺🇸 US | Joe Biden is the current US President | `false` | whitehouse.gov |
| 15 | 💰 ECO | U.S. tariff revenue reached $18 trillion | `false` | — |
| 16 | 🔬 SCI | Die globale Durchschnittstemperatur stieg 2024 um 1,5°C | `true` | — |
| 17 | 🔬 SCI | COVID-19 Impfungen verursachen Autismus | `false` | — |
| 18 | 🔬 SCI | Water boils at 100°C at sea level | `true` | — |
| 19 | 💰 ECO | Novo Nordisk Wegovy price is $199 | `true` | — |
| 20 | 📈 VOL | Bitcoin ist aktuell über $100,000 wert | `any` | — |
| 21 | 💬 OPN | I think pineapple belongs on pizza | `opinion` | — |
| 22 | 🔬 SCI | The Earth is flat | `false` | — |

> **`any`** = `true`, `false`, or `partially_true` all count as PASS (volatile/ambiguous claims).

---

## Stage 2: Attribution Stripping Validation (v5.4)

The `test-stage2-validation.js` script tests `stripAttribution()` against 24 input phrases (10 with attribution, 14 clean). All 11 regex patterns (8 DE + 3 EN) must strip correctly without over-stripping clean inputs.

```bash
node test-stage2-validation.js
```

| Pattern Type | Count | Examples |
|-------------|-------|----------|
| `Laut X, ...` (with comma) | 2 | "Laut ORF beträgt..." |
| `Laut X verb...` (no comma) | 3 | "Laut Prognosen wächst..." |
| `Laut dem/der X verb...` | 1 | "Laut dem Sprecher wurde..." |
| `XY sagt/behauptet, dass...` | 2 | "Kickl sagt, ..." |
| `Im Video wird erklärt...` | 1 | "Im Video wird erklärt, dass..." |
| `According to X, ...` | 1 | "According to official data, ..." |
| `X claims that...` | 1 | "He claims that..." |

**Current status: 10/10 (100%)**

---

## FAKTCHECK Quality Gate (v2.3.0)

The Quality Gate is a **zero-LLM, deterministic** output validation system that runs 20 checks across 4 categories against exported JSON. Think of it as **ESLint for fact-checking output**.

### Running the Quality Gate

```bash
# Standard report
python3 faktcheck_quality_gate.py tests/golden/<file>.json

# Strict mode (exit code 1 on critical issues)
python3 faktcheck_quality_gate.py tests/golden/<file>.json --strict

# JSON output (for CI/CD)
python3 faktcheck_quality_gate.py tests/golden/<file>.json --json

# Auto-fix (repairs fixable violations, writes to --output)
python3 faktcheck_quality_gate.py tests/golden/<file>.json --fix --output fixed.json
```

### Check Categories

| Category | Checks | What It Catches |
|----------|:------:|----------------|
| **Structural (S1-S5)** | 5 | Missing fields, invalid verdicts, untyped sources, no `cleanedClaim` |
| **Semantic (M1-M5)** | 5 | YouTube as evidence, wrong language, circular references, polluted searches |
| **Consistency (C1-C5)** | 5 | Duplicate claims, contradictory verdicts, confidence incoherence |
| **Extraction (E1-E5)** | 5 | Speaker-action leaks, opinion leaks, over-atomization, future-tense claims |

### Scoring

| Grade | Score | Meaning |
|:-----:|:-----:|---------|
| A | 90-100 | ✅ Production ready |
| B | 80-89 | ⚠️ Minor issues only |
| C | 70-79 | 🔴 Critical issues present |
| D | <70 | 🔴 Major rework needed |

### CI/CD Integration

The Quality Gate runs automatically via GitHub Actions (`.github/workflows/faktcheck-quality-gate.yml`):
- **On push** to `background.js`, `content.js`, or gate files
- **Nightly** against the golden test corpus in `tests/golden/`

### Golden Test Corpus

Save real extension exports to `tests/golden/` for regression testing:
```bash
# In the browser console on a YouTube video:
FAKTCHECK_EXPORT_CHUNKS()
# Move the downloaded file to tests/golden/
```

---

## Pass Criteria

### Assessment Ratio

```
Assessment Ratio = Passed Tests / Total Tests
```

| Threshold | Status | Action |
|-----------|--------|--------|
| ≥ 90% (≥20/22) | ✅ PASS | Release allowed |
| 85–89% | ⚠️ WARNING | Investigate failures, release with caution |
| < 85% | ❌ FAIL | Block release, debug required |

### Definition of Done

A feature/release is considered complete when:

- [ ] Assessment Ratio ≥ 90%
- [ ] ESLint: 0 errors
- [ ] Jest: 9/9 confidence calibration tests pass
- [ ] Quality Gate: ≥ 90/100 on `sample_clean.json`
- [ ] Math Guardrail catches 10× deviations (test #15)
- [ ] Opinion detection works (test #21 = `opinion`)
- [ ] No hallucinated sources (Kill Switch #1)

---

## Kill Switches (Abort Criteria)

The pipeline must **immediately fail** if any of these occur:

| # | Kill Switch | Description |
|---|-------------|-------------|
| 1 | **Hallucinated Quote** | `mapEvidence` invents a quote not present in `groundingSupports` |
| 2 | **Geographic Cross-Contamination** | System uses Austrian sources for a purely US-specific claim |
| 3 | **Math Guardrail Bypass** | A 10× outlier claim returns `true` |
| 4 | **Judge Preamble** | Judge starts with "Okay, ich werde..." instead of structured output |

Kill Switches 1–3 indicate architectural bugs. Kill Switch 4 is handled by the preamble detection fallback.

---

## Pre-Commit Checklist

Before pushing to `main`, run:

```bash
# 1. Lint
npx eslint background.js content.js

# 2. Unit Tests
npx jest --no-coverage

# 3. Quality Gate
python3 faktcheck_quality_gate.py tests/golden/sample_clean.json --strict

# 4. Golden Tests (requires API key)
GEMINI_API_KEY=AIza... node test-dryrun.js

# 5. Stage 2 Stripping Validation
node test-stage2-validation.js

# Expected results:
# ✅ ESLint: 0 errors
# ✅ Jest: 9/9 passed
# ✅ Quality Gate: ≥ 90/100 [A]
# ✅ STABILITY CHECK PASSED (≥20/22)
# ✅ Stripping accuracy: 10/10
```

---

## LLM Non-Determinism

Some claims (especially #13: Scholz) may fluctuate between runs due to LLM non-determinism. This is expected behavior — the Assessment Ratio accounts for it by requiring ≥90% rather than 100%.

If a claim consistently fails across 3+ runs, it indicates a real pipeline issue.

