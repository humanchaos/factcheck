# 🤝 Contributing to FactCheck

We are building a high-precision fact-verification engine. Every line of code directly impacts democratic discourse — so our standards are high. Thank you for being part of this.

## 🚀 Getting Started

1. **Watch the Repo**: Stay updated on active issues and release announcements.
2. **Find a Task**: Look for the **`good first issue`** label — these are curated entry points.
3. **Discuss First**: Open a thread in **Discussions** before writing code. This prevents wasted effort and ensures alignment with the roadmap.

## 🛠️ v5.4 Standards

These are non-negotiable quality gates for all contributions:

| Principle | What It Means |
|-----------|---------------|
| **Precision > Recall** | It is better to SKIP a claim than to verify a metaphor. The binary filter (`PROCESS`/`SKIP`) exists for a reason. |
| **Tier-1 Sourcing** | Prioritize sovereign data: `.gov`, `imf.org`, `ecb.europa.eu`, `statistik.at`. YouTube and Wikipedia alone trigger Source Malus. |
| **Semantic Commits** | Use `feat:`, `fix:`, `docs:`, or `test:` prefixes. One logical change per commit. |
| **Factual Core** | Every claim must be stripped to its atomic, speaker-free factual core. No rhetorical framing survives into verification. |
| **ASR Awareness** | Phonetic repairs must be explicit (`phonetic_repairs[]`), not silently applied. |

## 📋 Pull Request Checklist

Before opening a PR, ensure:

- [ ] ESLint passes with **0 errors** (`npx eslint background.js content.js security-utils.js`)
- [ ] Jest unit tests pass (`npx jest`)
- [ ] Gold Standard Dryrun passes (`node test-dryrun.js`) — or document why a tolerance was adjusted
- [ ] Binary filter tested: metaphors marked as `SKIP`
- [ ] Factual core dedup tested: rhetorical framings merge into one `ClaimObject`

## 🏗️ Architecture Overview

```
YouTube Video
    ↓
Stage 1: Transcript Extraction (L1-L5 fallback)
    ↓
Stage 2: Semantic Core Extraction (Gemini)
    ├── Binary Filter (PROCESS/SKIP)
    ├── Factual Core Dedup (merge framings)
    ├── Phonetic ASR Correction
    └── Entity Hydration
    ↓
Stage 3: Verification Pipeline
    ├── Research & Summarize (grounded search)
    ├── Evidence Mapping (source attribution)
    └── Judge Evidence (verdict + confidence)
    ↓
Sidebar UI (claim cards with evidence chains)
```

## 🐛 Reporting Bugs

Use the **Bug Report** issue template. Always include:
- The raw ASR transcript snippet
- What the engine produced vs. what it should have produced
- Whether the issue is in extraction (Stage 2) or verification (Stage 3)

## 💡 Feature Requests

Use the **Feature Request** issue template. Explain:
- What gap in v5.4 logic this fills
- Which Tier-1 data sources the feature would utilize
- Whether it affects the Gold Standard Dryrun

## 📜 Code of Conduct

All contributors must follow our [Code of Conduct](CODE_OF_CONDUCT.md). We are building tools for democratic accountability — toxicity has no place here.
