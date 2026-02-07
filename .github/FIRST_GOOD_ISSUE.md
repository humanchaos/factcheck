# [Good First Issue] Add visual feedback when a fact-check is "In Progress"

**Labels:** `good first issue`, `design`, `logic`

---

## 🐛 Problem

Currently, when a user clicks "Fact-check," there is a slight delay while the API processes the transcript. The UI doesn't show that anything is happening, which might make users think it's broken.

## 🎯 Goal

Add a simple loading spinner or a "Checking..." status message to the sidebar while the background script waits for the Gemini API response. The user should clearly see that something is happening.

**Acceptance criteria:**
- [ ] A visual indicator (spinner, pulsing dot, or text) appears when a fact-check request is in progress
- [ ] The indicator disappears when the response arrives (success or error)
- [ ] Works for both transcript-based and live-caption-based checks

## 📂 Suggested Files

- **`content.js`** — The `processTranscriptChunk()` and `processCaptionBatch()` functions trigger the API calls. Add a "loading" state before the call and clear it when the response arrives.
- **`sidebar.css`** — Add a simple CSS spinner or animation class (e.g., `.checking-spinner`).
- **`i18n.js`** — The key `analyzing` already exists in all 6 languages ("Analyzing...", "Analysiere...", etc.) — use this for the status text.

## 🧭 Getting Started

1. Clone the repo and load it as an unpacked extension in Chrome (see [README](../README.md#-quick-start))
2. Open a YouTube video and trigger a fact-check
3. Notice the gap between clicking and seeing results — that's what we're fixing
4. Look at the `updateStatus()` function in `content.js` for how the sidebar status text currently works

## 💡 Note to Contributor

This is a great way to get started with the codebase! Don't worry about making it look perfect — functional is better than pretty for now. A simple `updateStatus(t('analyzing'), true)` call before the API request and a clear after would already be a solid PR.
