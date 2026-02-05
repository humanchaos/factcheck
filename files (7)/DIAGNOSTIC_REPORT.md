# FAKTCHECK v3 — Diagnostic Report on Sample Data

## Input: `faktcheck_chunks_1770328299815.json`
**Source:** Pilnacek U-Ausschuss video (likely ORF/Puls4 discussion with Christian Hafenecker)

---

## What v2 produced (all 8 claims)

| # | Claim | Verdict | Why |
|---|---|---|---|
| 1 | Die StA Eisenstadt überprüft die Ergebnisse aus Krems | `unverifiable` | **Could not parse response** |
| 2 | StA Eisenstadt: Feuerwehrleute befragen | `unverifiable` | **Could not parse response** |
| 3 | StA Krems hat Feuerwehrleute nicht gefragt | `unverifiable` | **Could not parse response** |
| 4 | Zweck U-Ausschuss: Vertrauen wiederherstellen | `unverifiable` | **Could not parse response** |
| 5 | FPÖ: Infragestellung gefährdet Vertrauen | `unverifiable` | **Could not parse response** |
| 6 | FPÖ: Polizei war immer wichtig | `unverifiable` | **Could not parse response** |
| 7 | FPÖ: Nicht um einzelne Polizisten | `unverifiable` | **Could not parse response** |
| 8 | FPÖ: ÖVP hat Jahrzehnte Sagen im BMI | `unverifiable` | **Could not parse response** |

**100% failure rate.** Not a single verdict. Root cause: JSON parse failure, not decision logic.

---

## What v3 would produce

### Chunk 1 (6:33)

| # | Hydrated Claim | Type | Expected Verdict | Reasoning |
|---|---|---|---|---|
| 1 | "Die Staatsanwaltschaft Eisenstadt hat die Ermittlungen der Staatsanwaltschaft Krems im Fall Pilnacek zur Überprüfung übernommen." | factual | **true** (0.85) | ORF/APA reported the transfer of investigation. 1x Tier-1 source sufficient. |
| 2 | "Die Staatsanwaltschaft Eisenstadt plant im Fall Pilnacek erstmals Feuerwehrleute als Zeugen zu befragen, was die Staatsanwaltschaft Krems nicht getan hatte." | factual | **partially_true** (0.65) | Befragung der Feuerwehrleute was reported, but "erstmals" and "nicht getan" are harder to verify with high confidence. |
| 3 | *Merged into #2 above* | — | — | v3 extraction should combine these related claims |
| 4 | "Christian Hafenecker (FPÖ) erklärt im Pilnacek-U-Ausschuss, ein Zweck des Untersuchungsausschusses sei die Wiederherstellung des Vertrauens der Bevölkerung in Justiz und Exekutive unter ÖVP-Führung." | opinion | **opinion** (0.80) | This is Hafenecker's stated political position, not a verifiable fact. v3 catches this. |

### Chunk 2 (7:02)

| # | Hydrated Claim | Type | Expected Verdict | Reasoning |
|---|---|---|---|---|
| 5 | "Im Pilnacek-U-Ausschuss wird argumentiert, dass die Infragestellung der Ermittlungsarbeit das Vertrauen in die Institutionen gefährde." | opinion | **opinion** (0.80) | Rhetorical argument by interviewer/moderator, not factual claim. |
| 6 | "Die FPÖ betont traditionell die Bedeutung der Polizei." | opinion | **opinion** (0.75) | Political self-characterization. |
| 7 | "Christian Hafenecker (FPÖ) stellt klar, die Kritik richte sich nicht gegen einzelne Polizisten, sondern gegen die ÖVP-Führung im Innenministerium." | opinion | **opinion** (0.80) | Political framing statement. |
| 8 | "Christian Hafenecker (FPÖ) behauptet, die ÖVP habe seit Jahrzehnten die Kontrolle über das Innenministerium und Führungspositionen seien an ÖVP-Parteibuch gebunden." | factual | **partially_true** (0.70) | ÖVP has indeed held BMI for most of the last 30+ years (verifiable via parlament.gv.at), but "keine Führungsposition ohne Parteibuch" is harder to prove definitively. |

### Chunk 3 (7:31) — Currently empty claims

v3 extraction would find:

| # | Hydrated Claim | Type | Expected Verdict |
|---|---|---|---|
| 9 | "Christian Hafenecker (FPÖ) behauptet im Pilnacek-U-Ausschuss, eine enge Mitarbeiterin von Nationalratspräsident Wolfgang Sobotka (ÖVP) habe zahlreiche ÖVP-Politiker kontaktiert und sie mit der Causa Pilnacek konfrontiert." | factual | **partially_true** (0.65) | Sobotka-Mitarbeiterin Kontaktaufnahmen were reported in media, specifics vary. |

---

## Summary of improvement

| Metric | v2 | v3 expected |
|---|---|---|
| Claims with verdicts | 0/8 (0%) | ~9/9 (100%) |
| Parse failures | 8/8 | 0 (with extractJSON fallback) |
| Opinions correctly classified | 0 | 5 (new category) |
| Factual claims with TRUE/PARTIAL | 0 | 3-4 |
| Hydrated claims | 0 | 9 |
| Search queries generated | 0 | 18-27 |

---

## Critical path to fix

```
Priority 1: Replace JSON parsing     → extractJSON() in pipeline
            This alone fixes 100% of "Could not parse response"

Priority 2: Replace extraction prompt → Adds hydration + search_queries + type
            This enables meaningful verdicts instead of guessing

Priority 3: Replace verdict engine    → Source-tier logic, causal opt-in
            This produces calibrated confidence scores
```

**Minimum viable fix:** If you only change ONE thing, replace your JSON parse
with extractJSON(). That will immediately unblock verdict decisions, even
without the other improvements.
