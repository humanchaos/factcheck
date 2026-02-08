## Description
Brief summary of the changes introduced by this PR.

## Related Issue
Fixes # (issue number)

## 🛠️ Verification: The Golden Run

- [ ] **ASR Repair**: Tested against phonetic glitches (e.g., "Griechang" → "Kriechgang")
- [ ] **Binary Filter**: Verified that metaphors are marked as `SKIP`
- [ ] **Factual Core**: Verified that deduplication merges rhetorical framings into one `ClaimObject`
- [ ] **Source Tier**: No YouTube-only or Wikipedia-only verdicts above 0.1 confidence

## 🧪 Testing

- [ ] `npx eslint background.js content.js security-utils.js` — 0 errors
- [ ] `npx jest` — all tests pass
- [ ] `node test-dryrun.js` — Gold Standard Dryrun passes (or tolerance adjustment documented)
- [ ] Verified full-video coverage (no transcript truncation)

## Checklist

- [ ] My code follows the [CONTRIBUTING.md](CONTRIBUTING.md) guidelines
- [ ] I have performed a self-review of my own code
- [ ] My changes generate no new ESLint warnings
- [ ] Semantic commit message used (`feat:`, `fix:`, `docs:`, `test:`)
