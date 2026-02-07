# Testing Guide

> FAKTCHECK v2.0.0 — Quality assurance, golden tests, and release criteria.

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

# 2. Golden Tests
GEMINI_API_KEY=AIza... node test-dryrun.js

# 3. Verify output
# ✅ STABILITY CHECK PASSED (≥20/22)
```

---

## LLM Non-Determinism

Some claims (especially #13: Scholz) may fluctuate between runs due to LLM non-determinism. This is expected behavior — the Assessment Ratio accounts for it by requiring ≥90% rather than 100%.

If a claim consistently fails across 3+ runs, it indicates a real pipeline issue.
