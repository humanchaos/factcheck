# Trust Engine: Source Authority Policy

**factcheck** uses a domain-aware authority registry to tier sources deterministically.

## 📊 Five-Tier Source Authority System

| Tier | Icon | Category | Trust Level | Examples |
|------|------|----------|-------------|----------|
| 1 | 🏛️ / 🌍 | Official / Wire Agencies | Highest | Government (.gov, .gv.at), UN, WHO, Reuters, AP, AFP |
| 2 | 📰 / 📡 | Public Broadcasters / News of Record | High | BBC, ORF, NYT, Der Standard, Die Presse |
| 3 | ✅ / 📖 | Fact-Checkers / Reference | Medium | Snopes, PolitiFact, Mimikama, Wikipedia |
| 4 | 📄 | General / Unclassified | Low | Unknown or unregistered domains |
| 5 | ⚠️ | Unreliable / Disinformation | Flagged | RT, InfoWars, Sputnik |

## 🔧 Source Registry

All domain tiers are defined in [`sources-global.json`](assets/registry/sources-global.json), which includes:
- **41+ domains** across AT, DE, UK, US, EU, and INT regions
- **Wildcard support** (e.g., `*.gv.at` → Tier 1, `*.edu` → Tier 2)
- **Domain-type icons** for visual authority badges

## ✅ Inclusion Criteria

1. **IFCN Certification:** Primary preference is given to signatories of the [International Fact-Checking Network](https://www.ifcncodeofprinciples.poynter.org/).
2. **Accountability:** The source must have a clear, transparent "Corrections Policy."
3. **Evidence-Based:** Claims must be supported by primary data or direct citations.
4. **Non-Partisanship:** The source must demonstrate a history of checking all sides of the political spectrum.

## ❌ Exclusion Criteria

* Sources with no clear ownership or funding transparency.
* Personal blogs or unverified social media accounts.
* Outlets with a consistent history of uncorrected factual errors.
* Known state-controlled propaganda outlets are classified as **Tier 5**.

## 📈 Confidence Scoring

Confidence is calculated deterministically — no LLM "feelings":

```
Confidence = Base × SourceTier × Agreement
```

| Factor | Values |
|--------|--------|
| Base | Derived from verdict strength (TRUE=0.92, FALSE=0.85, PARTIALLY=0.65) |
| SourceTier | Tier 1 sources boost confidence; Tier 5 penalizes |
| Agreement | Multiple independent sources increase score |
