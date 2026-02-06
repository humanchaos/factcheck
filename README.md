# 📑 factcheck

**Protecting the truth in the digital age.**

> Because "Trust me, bro" isn't a valid source for a healthy democracy.

**factcheck** is an open-source Chrome Extension designed to automate the verification of claims made in YouTube videos — in real-time. In an era of rampant misinformation, we aim to provide journalists, researchers, and citizens with the technical infrastructure to cross-reference statements against reliable data sources as they watch.

---

## 🗳️ Why This Matters

Our democracy relies on a shared reality. When misinformation spreads faster than the truth, the foundation of public discourse weakens. This tool is built to:

- **Empower Journalists:** Rapidly verify data points during live events and video content.
- **Reduce Bias:** Use algorithmic cross-referencing to highlight factual inconsistencies.
- **Scale Truth:** Fact-checking humans can't keep up with bot-generated lies; we need code to fight back.

---

## 🚀 Quick Start

### Prerequisites

- Google Chrome (or Chromium-based browser)
- A free [Gemini API Key](https://aistudio.google.com/app/apikey)

### Installation

```bash
# Clone the repository
git clone https://github.com/humanchaos/factcheck.git
cd factcheck
```

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the cloned `factcheck` folder

### Configuration

1. Click the **FAKTCHECK** icon in your Chrome toolbar
2. Paste your Gemini API key
3. Click **Save Settings**

### Usage

1. Open any YouTube video
2. Click the **📋 FAKTCHECK** button below the video
3. Watch claims get extracted and verified in real-time

---

## 🛠️ Tech Stack & Architecture

| Component | Technology |
|-----------|------------|
| Platform | Chrome Extension (Manifest V3) |
| AI Engine | Google Gemini 2.0 Flash |
| Grounding | Google Search (via Gemini) |
| Security | XSS protection, input sanitization, rate limiting |
| Languages | JavaScript, HTML, CSS |

### How It Works

1. **Extract** — Transcripts or live captions are captured from YouTube
2. **Analyze** — Gemini identifies verifiable claims and assigns checkability scores
3. **Verify** — Each claim is cross-referenced using Google Search grounding
4. **Display** — Results appear in a real-time sidebar with verdict, sources, and confidence

### Source Tiers

| Tier | Icon | Examples |
|------|------|----------|
| 1 | 🥇 | Official statistics, government docs, parliamentary records |
| 2 | 🥈 | Quality journalism (APA, Reuters, ORF, BBC, NYT) |
| 3 | 🥉 | Fact-checkers (Mimikama, Snopes, Wikipedia) |
| 4 | 📄 | Other sources |

---

## 🗺️ Roadmap: How You Can Help

We are looking for contributors to help us reach "Version 1.0". Check out our [Open Issues](https://github.com/humanchaos/factcheck/issues).

| Feature | Status | Help Needed |
|---------|--------|-------------|
| Multi-Language Support | 🏗️ In Progress | Native speakers for additional languages |
| Twitter/X Integration | 📅 Planned | API implementation experts |
| Confidence Scoring | ✅ Done | Feedback on weights/biases |
| Chrome Web Store Release | 💡 Idea | UX feedback and testing |
| Additional Platforms | 💡 Idea | Twitch, TikTok, news sites |

---

## 🔒 Privacy

- Your API key is stored **locally** in your browser (never synced or transmitted)
- **No user tracking** or analytics
- Video content is only sent to the Gemini API for analysis
- Nothing is stored permanently

---

## 🤝 Contributing

We love Pull Requests!

1. Fork the repo.
2. Create your feature branch (`git checkout -b feature/AmazingFeature`).
3. Commit your changes (`git commit -m 'Add AmazingFeature'`).
4. Push to the branch (`git push origin feature/AmazingFeature`).
5. Open a Pull Request.

---

## ⚖️ License

Distributed under the MIT License. See [LICENSE](LICENSE) for more information.

---

Made for democratic transparency 🇦🇹
