# FAKTCHECK LIVE v2.0

Real-time AI fact-checking for YouTube videos. Powered by Google Gemini with Google Search grounding.

## 🔒 Security Hardened

This version includes critical security improvements:
- XSS protection with safe DOM manipulation
- Input sanitization against prompt injection
- Rate limiting (30 requests/minute)
- Claim caching (1-hour TTL)
- Source quality enforcement

## Features

- **Real-time fact-checking** of YouTube video captions
- **Transcript loading** for full video analysis
- **Truth Meter** showing overall credibility score
- **Source tiering** (🥇 Official stats → 🥈 Quality journalism → 🥉 Fact-checkers)
- **German & English** support with auto-detection
- **Confidence scores** adjusted by source quality

## Installation

### 1. Get a Gemini API Key (Free)

1. Go to [Google AI Studio](https://aistudio.google.com/app/apikey)
2. Click "Create API Key"
3. Copy your key

### 2. Load the Extension

1. Open Chrome and go to `chrome://extensions`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select the `extension` folder

### 3. Configure

1. Click the FAKTCHECK icon in your toolbar
2. Paste your Gemini API key
3. Click "Save Settings"

## Usage

1. Open any YouTube video
2. Click the "📋 FAKTCHECK" button below the video
3. Either:
   - Click "Load Transcript" to analyze the full video
   - Or enable captions (CC) for real-time monitoring

## Verdict Types

| Verdict | Icon | Meaning |
|---------|------|---------|
| TRUE | ✓ | Verified correct |
| FALSE | ✗ | Verified incorrect |
| PARTIAL | ◐ | Partially correct |
| UNCLEAR | ? | Insufficient data |
| OPINION | ○ | Not a factual claim |

## Source Tiers

| Tier | Icon | Examples |
|------|------|----------|
| 1 | 🥇 | Statistik Austria, Eurostat, WHO, government docs |
| 2 | 🥈 | APA, Reuters, ORF, BBC, NYT |
| 3 | 🥉 | Mimikama, Snopes, Wikipedia |
| 4 | 📄 | Other sources |

## Privacy

- Your API key is stored locally (never synced)
- No user tracking or analytics
- Video content is only sent to Gemini API for analysis
- Nothing is stored permanently

## Rate Limits

- 30 API calls per minute
- Claims are cached for 1 hour to reduce API usage
- Cache can be cleared in settings

## Troubleshooting

**"No API key configured"**
→ Click the extension icon and add your Gemini API key

**"Rate limit exceeded"**
→ Wait 60 seconds before trying again

**No transcript available**
→ Some videos don't have captions enabled

**Results seem wrong**
→ AI fact-checking isn't perfect. Always verify important claims yourself.

## Development

```
extension/
├── manifest.json       # Extension config
├── background.js       # API calls, caching, rate limiting
├── content.js          # YouTube integration, UI
├── security-utils.js   # XSS protection
├── popup.html/js       # Settings page
└── sidebar.css         # Styles
```

## License

MIT License

---

Made for democratic transparency 🇦🇹
