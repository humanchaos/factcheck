// FAKTCHECK v3.0 - Content Script (FIXED)
// FIXES: Sidebar video detection, silent failures, proper error display

(function () {
    'use strict';

    // Check SecurityUtils
    if (!window.SecurityUtils) {
        console.error('[FAKTCHECK] SecurityUtils not loaded!');
        return;
    }
    const S = window.SecurityUtils;

    console.log('[FAKTCHECK] ====================================');
    console.log('[FAKTCHECK] Content script loaded');
    console.log('[FAKTCHECK] URL:', window.location.href);
    console.log('[FAKTCHECK] ====================================');

    // State
    let sidebarInjected = false;
    let sidebarVisible = false;
    let isProcessing = false;
    let currentVideoId = null;
    let captionBuffer = [];
    let processedTimestamps = new Set();
    let currentLang = 'de';
    let captionObserver = null;
    let processingInterval = null;
    let identifiedHost = 'Moderator';  // Host name persists across session
    let isFirstChunk = true;           // Track first chunk for host detection

    let verdictCounts = {
        true: 0, mostly_true: 0, partially_true: 0,
        mostly_false: 0, false: 0, misleading: 0,
        unverifiable: 0, opinion: 0
    };

    // ─── i18n: Use shared TruthLensI18n module ──────────────────
    const I18n = window.TruthLensI18n;
    if (!I18n) {
        console.error('[FAKTCHECK] TruthLensI18n not loaded!');
        return;
    }
    const t = (key) => I18n.tSync(key);
    const tv = (verdict) => I18n.tvSync(verdict);

    const VERDICT_ICONS = {
        true: '✓', false: '✗', partially_true: '◐',
        unverifiable: '?', opinion: '○', pending: '⏳',
        mostly_true: '✓', mostly_false: '✗', misleading: '◐',
        satirical_hyperbole: '🎭'  // Satire-specific verdict
    };

    // Verdict color mapping: 🔴 FALSCH, 🟡 SATIRE, 🟢 WAHR
    const VERDICT_COLORS = {
        true: 'green', false: 'red', partially_true: 'amber',
        unverifiable: 'gray', opinion: 'gray', pending: 'gray',
        mostly_true: 'green', mostly_false: 'red', misleading: 'amber',
        satirical_hyperbole: 'amber'  // Yellow for satire (not red!)
    };

    // Get verdict display info based on context
    function getVerdictDisplay(verdict, isSatireContext = false) {
        // If false in satire context, show as satirical hyperbole
        if (verdict === 'false' && isSatireContext) {
            return {
                icon: '🎭',
                color: 'amber',
                label: t('satiricalHyperbole'),
                description: t('satiricalDesc')
            };
        }
        return {
            icon: VERDICT_ICONS[verdict] || '?',
            color: VERDICT_COLORS[verdict] || 'gray',
            label: tv(verdict) || verdict?.toUpperCase() || t('verdictUnverifiable'),
            description: null
        };
    }

    function getCurrentVideoId() {
        const params = new URLSearchParams(window.location.search);
        return params.get('v');
    }

    // ==================== Transcript Cleaning ====================
    // Removes stuttering phrases and word repetitions
    function cleanTranscript(text) {
        if (!text) return '';
        let cleaned = text.replace(/\s+/g, ' ').trim();

        // Remove phrase repetitions (3-50 chars) - loop until stable
        const phraseRegex = /(.{3,50})\1+/gi;
        let prev;
        do {
            prev = cleaned;
            cleaned = cleaned.replace(phraseRegex, '$1');
        } while (cleaned !== prev);

        // Remove word repetitions (e.g., "Land Land")
        return cleaned.split(' ').filter((word, i, arr) =>
            word.toLowerCase() !== arr[i + 1]?.toLowerCase()
        ).join(' ');
    }

    // Track detected speaker for role mapping
    let detectedSpeaker = null;

    // ==================== Video Metadata for Grounding ====================
    function getVideoMetadata() {
        try {
            const title = document.querySelector('h1.ytd-video-primary-info-renderer yt-formatted-string, h1.ytd-watch-metadata yt-formatted-string')?.textContent?.trim()
                || document.querySelector('meta[name="title"]')?.content
                || document.title.replace(' - YouTube', '').trim();

            const channel = document.querySelector('#channel-name a, #owner-name a, ytd-channel-name a')?.textContent?.trim()
                || document.querySelector('meta[itemprop="author"]')?.content;

            const description = document.querySelector('#description-inline-expander, #description yt-formatted-string')?.textContent?.trim()?.slice(0, 500)
                || document.querySelector('meta[name="description"]')?.content?.slice(0, 500);

            // Try to detect country/region from various signals
            const htmlLang = document.documentElement.lang || 'unknown';
            const pageText = (title + ' ' + (description || '')).toLowerCase();

            let detectedCountry = 'unknown';
            if (pageText.includes('österreich') || pageText.includes('austria') || pageText.includes('wien') || pageText.includes('orf')) {
                detectedCountry = 'Austria';
            } else if (pageText.includes('deutschland') || pageText.includes('germany') || pageText.includes('berlin') || pageText.includes('ard') || pageText.includes('zdf')) {
                detectedCountry = 'Germany';
            } else if (pageText.includes('schweiz') || pageText.includes('switzerland') || pageText.includes('zürich') || pageText.includes('srf')) {
                detectedCountry = 'Switzerland';
            }

            const metadata = { title, channel, description, htmlLang, detectedCountry };
            console.log('[FAKTCHECK] Video metadata:', metadata);
            return metadata;
        } catch (e) {
            console.log('[FAKTCHECK] Metadata extraction error:', e.message);
            return { title: null, channel: null, description: null, htmlLang: 'unknown', detectedCountry: 'unknown' };
        }
    }

    let cachedMetadata = null;

    async function sendMessageSafe(message) {
        try {
            console.log('[FAKTCHECK] Sending message:', message.type);
            const response = await chrome.runtime.sendMessage(message);
            if (response === undefined || response === null) {
                return { error: 'Extension error. Please refresh the page.', claims: [], verification: null };
            }
            if (response.error) console.error('[FAKTCHECK] Background error:', response.error);
            return response;
        } catch (error) {
            console.error('[FAKTCHECK] Message error:', error);
            if (error.message?.includes('Extension context invalidated')) {
                return { error: 'Extension reloaded. Please refresh the page.', claims: [], verification: null };
            }
            return { error: error.message, claims: [], verification: null };
        }
    }

    // ==================== Transcript Fetching ====================
    async function fetchTranscript() {
        try {
            const videoId = getCurrentVideoId();
            if (!videoId) return null;

            console.log('[FAKTCHECK] ========== FETCH TRANSCRIPT ==========');
            console.log('[FAKTCHECK] Video ID:', videoId);

            let transcript = await tryYtInitialPlayerResponse();
            if (transcript?.length > 0) {
                console.log('[FAKTCHECK] ✓ L1 Success:', transcript.length, 'segments');
                return transcript;
            }

            transcript = await tryCaptionTracksFromSource();
            if (transcript?.length > 0) {
                console.log('[FAKTCHECK] ✓ L2 Success:', transcript.length, 'segments');
                return transcript;
            }

            transcript = await tryInnertubeApi(videoId);
            if (transcript?.length > 0) {
                console.log('[FAKTCHECK] ✓ L3 Success:', transcript.length, 'segments');
                return transcript;
            }

            transcript = await tryTimedTextApi(videoId);
            if (transcript?.length > 0) {
                console.log('[FAKTCHECK] ✓ L4 Success:', transcript.length, 'segments');
                return transcript;
            }

            console.log('[FAKTCHECK] ✗ All transcript methods failed');
            return null;
        } catch (e) {
            // Silently fail - some videos don't have transcripts
            console.log('[FAKTCHECK] Transcript not available');
            return null;
        }
    }

    async function tryYtInitialPlayerResponse() {
        try {
            console.log('[FAKTCHECK] L1: Checking ytInitialPlayerResponse...');
            // Method 1: Check window global
            if (window.ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks) {
                const tracks = window.ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks;
                console.log('[FAKTCHECK] L1: Found', tracks.length, 'tracks in window object');
                return await fetchCaptionTrack(tracks);
            }
            // Method 2: Parse from script tags using brace-depth (v2 pattern)
            console.log('[FAKTCHECK] L1: No window object, searching scripts...');
            const scripts = document.querySelectorAll('script');
            for (const script of scripts) {
                const text = script.textContent || '';
                if (text.includes('captionTracks')) {
                    console.log('[FAKTCHECK] L1: Found captionTracks in script');
                    const startIdx = text.indexOf('"captionTracks"');
                    if (startIdx === -1) continue;
                    const bracketIdx = text.indexOf('[', startIdx);
                    if (bracketIdx === -1) continue;
                    // Use brace-depth parsing like v2
                    let depth = 0, endIdx = bracketIdx;
                    for (let i = bracketIdx; i < Math.min(text.length, bracketIdx + 10000); i++) {
                        if (text[i] === '[') depth++;
                        else if (text[i] === ']') depth--;
                        if (depth === 0) { endIdx = i + 1; break; }
                    }
                    try {
                        const tracksJson = text.substring(bracketIdx, endIdx);
                        console.log('[FAKTCHECK] L1: Extracted JSON, length:', tracksJson.length);
                        const tracks = JSON.parse(tracksJson);
                        if (tracks?.length > 0) {
                            console.log('[FAKTCHECK] L1: Parsed', tracks.length, 'tracks');
                            return await fetchCaptionTrack(tracks);
                        }
                    } catch (e) {
                        console.log('[FAKTCHECK] L1: JSON parse error:', e.message);
                    }
                }
            }
        } catch (e) { console.log('[FAKTCHECK] L1 failed:', e.message); }
        console.log('[FAKTCHECK] L1: No tracks found');
        return null;
    }

    async function tryCaptionTracksFromSource() {
        try {
            const response = await fetch(window.location.href);
            const html = await response.text();
            const match = html.match(/"captionTracks"\s*:\s*(\[.*?\])/);
            if (match) {
                let jsonStr = match[1], depth = 0, end = 0;
                for (let i = 0; i < jsonStr.length; i++) {
                    if (jsonStr[i] === '[') depth++;
                    if (jsonStr[i] === ']') depth--;
                    if (depth === 0) { end = i + 1; break; }
                }
                const tracks = JSON.parse(jsonStr.slice(0, end));
                if (tracks?.length > 0) return await fetchCaptionTrack(tracks);
            }
        } catch (e) { console.log('[FAKTCHECK] L2 failed:', e.message); }
        return null;
    }

    async function tryInnertubeApi(videoId) {
        try {
            let apiKey = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
            const scripts = document.querySelectorAll('script');
            for (const script of scripts) {
                const keyMatch = (script.textContent || '').match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
                if (keyMatch) { apiKey = keyMatch[1]; break; }
            }
            const response = await fetch(`https://www.youtube.com/youtubei/v1/get_transcript?key=${apiKey}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    context: { client: { clientName: 'WEB', clientVersion: '2.20231219.04.00' } },
                    params: btoa(`\n\x0b${videoId}`)
                })
            });
            if (response.ok) {
                const data = await response.json();
                const segments = data?.actions?.[0]?.updateEngagementPanelAction?.content?.transcriptRenderer?.content?.transcriptSearchPanelRenderer?.body?.transcriptSegmentListRenderer?.initialSegments;
                if (segments?.length > 0) {
                    const transcript = segments.map(seg => {
                        const r = seg.transcriptSegmentRenderer;
                        return { time: parseInt(r?.startMs || 0) / 1000, text: (r?.snippet?.runs?.map(x => x.text).join('') || '').trim() };
                    }).filter(s => s.text);
                    if (transcript.length > 0) return transcript;
                }
            }
        } catch (e) { console.log('[FAKTCHECK] L3 failed:', e.message); }
        return null;
    }

    async function tryTimedTextApi(videoId) {
        try {
            const variations = [{ lang: 'de' }, { lang: 'en' }, { lang: 'a.de' }, { lang: 'a.en' }];
            for (const v of variations) {
                try {
                    const response = await fetch(`https://www.youtube.com/api/timedtext?v=${videoId}&lang=${v.lang}&fmt=srv3`);
                    if (response.ok) {
                        const xml = await response.text();
                        if (xml.includes('<text')) {
                            const transcript = parseTranscriptXml(xml);
                            if (transcript?.length > 0) return transcript;
                        }
                    }
                } catch (e) { }
            }
        } catch (e) { console.log('[FAKTCHECK] L4 failed:', e.message); }
        return null;
    }

    async function fetchCaptionTrack(tracks) {
        let track = tracks.find(t => t.languageCode === 'de') || tracks.find(t => t.languageCode === 'en') || tracks[0];
        if (!track?.baseUrl) {
            console.log('[FAKTCHECK] No valid track found in:', tracks);
            return null;
        }
        console.log('[FAKTCHECK] Selected track:', track.languageCode, 'URL:', track.baseUrl.slice(0, 100));

        // Try JSON3 format first (more reliable)
        try {
            const jsonUrl = track.baseUrl + '&fmt=json3';
            console.log('[FAKTCHECK] Fetching JSON3:', jsonUrl);
            const jsonResponse = await fetch(jsonUrl, { credentials: 'include' });
            console.log('[FAKTCHECK] JSON3 response status:', jsonResponse.status, jsonResponse.statusText);
            if (jsonResponse.ok) {
                const text = await jsonResponse.text();
                console.log('[FAKTCHECK] JSON3 response length:', text.length);
                console.log('[FAKTCHECK] JSON3 first 200 chars:', text.slice(0, 200));
                if (text.length > 10) {
                    try {
                        const jsonData = JSON.parse(text);
                        if (jsonData?.events) {
                            const transcript = [];
                            for (const event of jsonData.events) {
                                if (event.segs) {
                                    const segText = event.segs.map(s => s.utf8 || '').join('').trim();
                                    if (segText && segText !== '\n') {
                                        transcript.push({ time: (event.tStartMs || 0) / 1000, text: segText });
                                    }
                                }
                            }
                            if (transcript.length > 0) {
                                console.log('[FAKTCHECK] ✓ JSON3 parsed:', transcript.length, 'segments');
                                return transcript;
                            }
                        }
                    } catch (e) {
                        console.log('[FAKTCHECK] JSON3 parse failed:', e.message);
                    }
                }
            }
        } catch (e) {
            console.log('[FAKTCHECK] JSON3 fetch failed:', e.message);
        }

        // Fall back to XML
        try {
            console.log('[FAKTCHECK] Trying XML format...');
            const response = await fetch(track.baseUrl, { credentials: 'include' });
            if (!response.ok) {
                console.log('[FAKTCHECK] XML fetch failed:', response.status);
                return null;
            }
            const xml = await response.text();
            console.log('[FAKTCHECK] XML response length:', xml.length);
            if (xml.length < 50) {
                console.log('[FAKTCHECK] XML too short:', xml);
                return null;
            }
            const result = parseTranscriptXml(xml);
            console.log('[FAKTCHECK] XML parse result:', result ? result.length + ' segments' : 'null');
            return result;
        } catch (e) {
            console.log('[FAKTCHECK] XML fetch/parse error:', e.message);
            return null;
        }
    }

    function parseTranscriptXml(xml) {
        const doc = new DOMParser().parseFromString(xml, 'text/xml');
        const transcript = [];
        // Try both 'text' (standard) and 'p' (srv3 format) elements
        let elements = doc.querySelectorAll('text');
        if (elements.length === 0) {
            elements = doc.querySelectorAll('p');
        }
        console.log('[FAKTCHECK] Found', elements.length, 'text/p elements');
        elements.forEach(text => {
            const content = text.textContent.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\n/g, ' ').trim();
            if (content) transcript.push({ time: parseFloat(text.getAttribute('start') || text.getAttribute('t') || 0), text: content });
        });
        return transcript.length > 0 ? transcript : null;
    }

    // ==================== Sidebar Creation ====================
    function createSidebar() {
        if (sidebarInjected) return;
        const sidebar = S.createElement('div', { id: 'faktcheck-sidebar' });

        // Header
        const header = S.createElement('div', { class: 'faktcheck-header' });
        const logo = S.createElement('div', { class: 'faktcheck-logo' });
        logo.appendChild(S.createElement('span', { class: 'faktcheck-title' }, t('title')));
        logo.appendChild(S.createElement('span', { class: 'faktcheck-live' }, t('live')));
        header.appendChild(logo);
        const controls = S.createElement('div', { class: 'faktcheck-controls' });
        controls.appendChild(S.createElement('button', { id: 'faktcheck-toggle', class: 'faktcheck-btn', title: 'Pause' }, '⏸'));
        controls.appendChild(S.createElement('button', { id: 'faktcheck-close', class: 'faktcheck-btn', title: 'Close' }, '✕'));
        header.appendChild(controls);
        sidebar.appendChild(header);

        // Status
        const status = S.createElement('div', { class: 'faktcheck-status', id: 'faktcheck-status' });
        status.appendChild(S.createElement('span', { class: 'status-dot' }));
        const statusText = S.createElement('span', { class: 'status-text' }, t('waiting'));
        statusText.setAttribute('data-i18n', 'waiting');
        status.appendChild(statusText);
        sidebar.appendChild(status);

        // Truth Meter
        const meter = S.createElement('div', { class: 'faktcheck-truth-meter' });
        const meterLabel = S.createElement('div', { class: 'truth-meter-label' });
        const falseLabel = S.createElement('span', { class: 'meter-label-false' }, '✗ ' + tv('false'));
        falseLabel.setAttribute('data-i18n-verdict', 'false');
        meterLabel.appendChild(falseLabel);
        meterLabel.appendChild(S.createElement('span', { class: 'meter-label-score', id: 'truth-meter-score' }, '—'));
        const trueLabel = S.createElement('span', { class: 'meter-label-true' }, tv('true') + ' ✓');
        trueLabel.setAttribute('data-i18n-verdict', 'true');
        meterLabel.appendChild(trueLabel);
        meter.appendChild(meterLabel);
        const meterBar = S.createElement('div', { class: 'truth-meter-bar' });
        meterBar.appendChild(S.createElement('div', { class: 'truth-meter-gradient' }));
        meterBar.appendChild(S.createElement('div', { class: 'truth-meter-needle', id: 'truth-meter-needle' }));
        meter.appendChild(meterBar);
        const meterStats = S.createElement('div', { class: 'truth-meter-stats' });
        meterStats.appendChild(S.createElement('span', { class: 'stat-false', id: 'stat-false' }, '0'));
        meterStats.appendChild(S.createElement('span', { class: 'stat-partial', id: 'stat-partial' }, '0'));
        meterStats.appendChild(S.createElement('span', { class: 'stat-true', id: 'stat-true' }, '0'));
        meter.appendChild(meterStats);
        sidebar.appendChild(meter);

        // Actions
        // Actions (hidden - transcript auto-loads)
        const actions = S.createElement('div', { class: 'faktcheck-actions', style: 'display: none;' });
        actions.appendChild(S.createElement('button', { id: 'faktcheck-load-transcript', class: 'faktcheck-load-btn' }, '📄 ' + t('loadTranscript')));
        sidebar.appendChild(actions);

        const claims = S.createElement('div', { class: 'faktcheck-claims', id: 'faktcheck-claims' });
        const emptyMsg = S.createElement('div', { class: 'faktcheck-empty' }, t('noClaims'));
        emptyMsg.setAttribute('data-i18n', 'noClaims');
        claims.appendChild(emptyMsg);
        sidebar.appendChild(claims);

        const footer = S.createElement('div', { class: 'faktcheck-footer' });
        const countEl = S.createElement('span', { class: 'faktcheck-count', id: 'faktcheck-count' }, '0 ' + t('claims'));
        countEl.setAttribute('data-i18n-suffix', 'claims');
        footer.appendChild(countEl);
        footer.appendChild(S.createElement('button', { id: 'faktcheck-export', class: 'faktcheck-export-btn', title: 'Export' }, '📥 Export'));
        sidebar.appendChild(footer);

        document.body.appendChild(sidebar);
        sidebarInjected = true;

        document.getElementById('faktcheck-close').addEventListener('click', hideSidebar);
        document.getElementById('faktcheck-toggle').addEventListener('click', toggleProcessing);
        document.getElementById('faktcheck-load-transcript').addEventListener('click', loadAndProcessTranscript);
        document.getElementById('faktcheck-export').addEventListener('click', () => {
            if (typeof exportChunks === 'function') exportChunks();
            else console.log('[FAKTCHECK] No chunks to export yet');
        });

        console.log('[FAKTCHECK] Sidebar created');
        injectToggleButton();

        // Auto-load transcript
        setTimeout(() => {
            console.log('[FAKTCHECK] Auto-loading transcript...');
            loadAndProcessTranscript();
        }, 1000);
    }

    // ==================== Claim Cards ====================
    function createClaimCard(claim) {
        const safe = S.sanitizeClaim(claim);
        if (!safe) return null;
        const verdict = safe.displayVerdict || safe.verdict;
        const card = S.createElement('div', { class: `faktcheck-card verdict-${verdict}`, 'data-claim-id': safe.id });

        const header = S.createElement('div', { class: 'claim-header' });
        const timestamp = S.createElement('span', { class: 'claim-timestamp' }, formatTime(safe.timestamp));
        timestamp.addEventListener('click', () => {
            const video = document.querySelector('#movie_player video');
            if (video) video.currentTime = safe.timestamp;
        });
        header.appendChild(timestamp);

        // Use getVerdictDisplay for proper satire handling
        const isSatireContext = safe.is_satire_context || false;
        const verdictInfo = getVerdictDisplay(verdict, isSatireContext);
        const verdictEl = S.createElement('span', {
            class: `claim-verdict verdict-${verdictInfo.color}`
        });
        verdictEl.appendChild(S.createElement('span', { class: 'verdict-icon' }, verdictInfo.icon));
        verdictEl.appendChild(S.createText(' ' + (verdictInfo.label || tv(verdict))));
        header.appendChild(verdictEl);
        card.appendChild(header);

        card.appendChild(S.createElement('div', { class: 'claim-text' }, safe.text));
        if (safe.explanation) card.appendChild(S.createElement('div', { class: 'claim-explanation' }, safe.explanation));

        if (safe.key_facts?.length > 0) {
            const facts = S.createElement('div', { class: 'claim-facts' });
            safe.key_facts.forEach(f => facts.appendChild(S.createElement('div', { class: 'fact-item' }, '• ' + f)));
            card.appendChild(facts);
        }

        if (safe.sources?.length > 0) {
            const sources = S.createElement('div', { class: 'claim-sources' });
            safe.sources.forEach(src => {
                if (src.url) sources.appendChild(S.createElement('a', { href: src.url, target: '_blank', rel: 'noopener noreferrer', class: 'source-link' }, '📄 ' + src.title));
            });
            card.appendChild(sources);
        }

        if (safe.confidence > 0) card.appendChild(S.createElement('div', { class: 'claim-confidence' }, `${Math.round(safe.confidence * 100)}% confident`));
        return card;
    }

    function updateClaimCard(claimId, updates) {
        const card = document.querySelector(`[data-claim-id="${claimId}"]`);
        if (!card) return;
        const safe = S.sanitizeClaim({ id: claimId, ...updates });
        if (!safe) return;
        const verdict = safe.displayVerdict || safe.verdict;
        card.className = `faktcheck-card verdict-${verdict}`;

        const verdictEl = card.querySelector('.claim-verdict');
        if (verdictEl) {
            verdictEl.innerHTML = '';
            verdictEl.appendChild(S.createElement('span', { class: 'verdict-icon' }, VERDICT_ICONS[verdict] || '?'));
            verdictEl.appendChild(S.createText(' ' + tv(verdict)));
        }

        if (safe.explanation) {
            let explEl = card.querySelector('.claim-explanation');
            if (!explEl) { explEl = S.createElement('div', { class: 'claim-explanation' }); card.querySelector('.claim-text')?.after(explEl); }
            explEl.textContent = safe.explanation;
        }

        updateTruthMeter(safe.verdict);
    }

    // ==================== Helpers ====================
    function formatTime(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    function updateStatus(text, active = false) {
        const statusText = document.querySelector('#faktcheck-status .status-text');
        const statusDot = document.querySelector('#faktcheck-status .status-dot');
        if (statusText) statusText.textContent = text;
        if (statusDot) statusDot.classList.toggle('active', active);
        console.log('[FAKTCHECK] Status:', text);
    }

    function updateCount(count) {
        const el = document.getElementById('faktcheck-count');
        if (el) el.textContent = `${count} ${t('claims')}`;
    }

    function updateTruthMeter(verdict) {
        if (verdict && verdictCounts.hasOwnProperty(verdict)) verdictCounts[verdict]++;
        const weights = { true: 100, mostly_true: 85, partially_true: 50, misleading: 35, mostly_false: 20, false: 0 };
        let totalWeight = 0, totalCounted = 0;
        for (const [key, weight] of Object.entries(weights)) {
            const count = verdictCounts[key] || 0;
            totalWeight += count * weight;
            totalCounted += count;
        }

        const needle = document.getElementById('truth-meter-needle');
        const scoreEl = document.getElementById('truth-meter-score');
        document.getElementById('stat-false').textContent = (verdictCounts.false || 0) + (verdictCounts.mostly_false || 0);
        document.getElementById('stat-partial').textContent = (verdictCounts.partially_true || 0) + (verdictCounts.misleading || 0);
        document.getElementById('stat-true').textContent = (verdictCounts.true || 0) + (verdictCounts.mostly_true || 0);

        if (totalCounted === 0) {
            if (scoreEl) scoreEl.textContent = '—';
            if (needle) needle.style.left = '50%';
            return;
        }
        const score = Math.round(totalWeight / totalCounted);
        if (scoreEl) scoreEl.textContent = `${score}%`;
        if (needle) needle.style.left = `${score}%`;
    }

    // ==================== Processing ====================
    // DEBUG: Store all chunks sent for analysis
    let analysisChunks = [];

    // Reset all session state when video changes
    function resetSession() {
        console.log('[FAKTCHECK] 🔄 Session reset - clearing all state');
        analysisChunks = [];
        captionBuffer = [];
        contextBuffer = [];
        processedTimestamps.clear();
        cachedMetadata = null;
        identifiedHost = 'Moderator';  // Reset host
        isFirstChunk = true;           // Re-enable host detection

        // Clear claims container
        const container = document.getElementById('faktcheck-claims');
        if (container) {
            container.innerHTML = `<div class="faktcheck-empty">${t('noClaims')}</div>`;
        }
        updateCount(0);
        updateTruthMeter(0, 0, 0);
    }

    // Check for video change and reset if needed
    function checkVideoChange() {
        const newVideoId = getCurrentVideoId();
        if (newVideoId && newVideoId !== currentVideoId) {
            console.log('[FAKTCHECK] Video changed from', currentVideoId, 'to', newVideoId);
            currentVideoId = newVideoId;
            resetSession();
            return true;
        }
        return false;
    }

    function exportChunks() {
        const blob = new Blob([JSON.stringify(analysisChunks, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `faktcheck_chunks_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        console.log('[FAKTCHECK] Exported', analysisChunks.length, 'chunks');
    }

    // Expose to console for manual export
    window.FAKTCHECK_EXPORT_CHUNKS = exportChunks;
    window.FAKTCHECK_GET_CHUNKS = () => analysisChunks;

    async function processText(text, timestamp) {
        // Check for video change and reset if needed
        checkVideoChange();

        // Host identification (first chunk or if still default)
        if (isFirstChunk || identifiedHost === 'Moderator') {
            // Multi-language host detection patterns
            const hostMatch = text.match(/(?:Der|Name ist|Ich bin|Willkommen bei|mit|My name is|I'm|I am|Welcome to|hosted by|Je suis|Soy|Sono|Eu sou)\s+([A-Z][a-zäöüéèêàâîïôùûçñ]+\s+[A-Z][a-zäöüéèêàâîïôùûçñ]+)/i);
            if (hostMatch) {
                identifiedHost = hostMatch[1];
                console.log(`[FAKTCHECK] 🎙️ Host identified: ${identifiedHost}`);
            }
            isFirstChunk = false;
        }

        // Clean transcript: remove duplicate consecutive words (stuttering)
        const cleanedText = cleanTranscript(text);

        console.log('[FAKTCHECK] ========== PROCESS TEXT ==========');
        console.log('[FAKTCHECK] Original length:', text.length, '| Cleaned length:', cleanedText.length);
        console.log('[FAKTCHECK] Token savings:', Math.round((1 - cleanedText.length / text.length) * 100) + '%');

        // Store chunk for analysis (use cleaned text)
        const chunkEntry = {
            timestamp: timestamp,
            videoTime: formatTime(timestamp),
            realTime: new Date().toISOString(),
            originalLength: text.length,
            cleanedLength: cleanedText.length,
            tokenSavings: Math.round((1 - cleanedText.length / text.length) * 100) + '%',
            fullText: cleanedText,
            // Parse context vs new text if present
            context: cleanedText.includes('[Context from previous') ? cleanedText.split('\n\nNew content to analyze:\n')[0] : null,
            newContent: cleanedText.includes('[Context from previous') ? cleanedText.split('\n\nNew content to analyze:\n')[1] : cleanedText,
            claims: [] // Will be filled after processing
        };
        analysisChunks.push(chunkEntry);

        console.log('[FAKTCHECK] 📦 CHUNK #' + analysisChunks.length + ':', {
            videoTime: chunkEntry.videoTime,
            contextChars: chunkEntry.context?.length || 0,
            newContentChars: chunkEntry.newContent?.length || 0
        });
        console.log('[FAKTCHECK] 📦 NEW CONTENT:', chunkEntry.newContent?.slice(0, 200) + '...');

        try {
            // Get or refresh metadata for grounding
            if (!cachedMetadata) cachedMetadata = getVideoMetadata();

            const response = await sendMessageSafe({
                type: 'EXTRACT_CLAIMS',
                text: cleanedText,  // Use cleaned text (no duplicates)
                metadata: cachedMetadata  // Pass metadata for grounding
            });
            if (response.error) {
                console.error('[FAKTCHECK] Extract error:', response.error);
                updateStatus('⚠️ ' + response.error, false);
                chunkEntry.error = response.error;
                return { success: false, error: response.error };
            }
            if (response.lang) currentLang = response.lang;
            const claims = response.claims || [];
            console.log('[FAKTCHECK] Received', claims.length, 'claims');

            // Initialize claims array with full details
            chunkEntry.claims = [];

            if (claims.length === 0) return { success: true, claimCount: 0 };

            const container = document.getElementById('faktcheck-claims');
            const empty = container?.querySelector('.faktcheck-empty');
            if (empty) empty.remove();

            for (const claim of claims) {
                const claimId = `claim-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                console.log('[FAKTCHECK] Processing:', claim.claim.slice(0, 50) + '...');
                const card = createClaimCard({ id: claimId, text: claim.claim, timestamp, verdict: 'pending', speaker: claim.speaker });
                if (card && container) {
                    container.insertBefore(card, container.firstChild);
                    updateCount(container.querySelectorAll('.faktcheck-card').length);
                }
                const verifyResponse = await sendMessageSafe({ type: 'VERIFY_CLAIM', claim: claim.claim, lang: currentLang });

                // Store full claim with verification for export
                const claimEntry = {
                    originalClaim: claim.claim,
                    speaker: claim.speaker || null,
                    category: claim.category || null,
                    checkability: claim.checkability || null,
                    importance: claim.importance || null,
                    verification: null
                };

                if (verifyResponse.error) {
                    updateClaimCard(claimId, { verdict: 'unverifiable', displayVerdict: 'unverifiable', explanation: verifyResponse.error });
                    claimEntry.verification = { verdict: 'error', explanation: verifyResponse.error };
                } else if (verifyResponse.verification) {
                    updateClaimCard(claimId, verifyResponse.verification);
                    claimEntry.verification = {
                        verdict: verifyResponse.verification.verdict,
                        explanation: verifyResponse.verification.explanation,
                        confidence: verifyResponse.verification.confidence,
                        key_facts: verifyResponse.verification.key_facts,
                        sources: verifyResponse.verification.sources?.map(s => s.title || s.url) || [],
                        caveats: verifyResponse.verification.caveats
                    };
                }

                chunkEntry.claims.push(claimEntry);
            }
            return { success: true, claimCount: claims.length };
        } catch (error) {
            console.error('[FAKTCHECK] Process error:', error);
            updateStatus('⚠️ ' + error.message, false);
            chunkEntry.error = error.message;
            return { success: false, error: error.message };
        }
    }

    async function loadAndProcessTranscript() {
        const btn = document.getElementById('faktcheck-load-transcript');
        if (!btn) return;
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = '⏳ ' + t('loading');
        updateStatus(t('loading'), true);

        try {
            const transcript = await fetchTranscript();
            if (!transcript || transcript.length === 0) {
                // Start live caption monitoring as fallback
                console.log('[FAKTCHECK] No transcript, starting live caption monitoring...');
                updateStatus(t('waiting'), true);
                startLiveCaptionObserver();
                btn.disabled = false;
                btn.textContent = originalText;
                return;
            }
            btn.textContent = '✓ ' + t('loaded');

            // Chunk into 3-min segments
            const chunks = [];
            let current = [], startTime = 0;
            const CHUNK_DURATION = 180, MIN_CHUNK_LENGTH = 200;
            for (const seg of transcript) {
                current.push(seg);
                const isLast = seg === transcript[transcript.length - 1];
                const currentText = current.map(s => s.text).join(' ');
                if ((seg.time - startTime > CHUNK_DURATION && currentText.length > MIN_CHUNK_LENGTH) || isLast) {
                    if (currentText.length >= MIN_CHUNK_LENGTH) {
                        chunks.push({ text: currentText, avgTime: current.reduce((s, x) => s + x.time, 0) / current.length });
                    }
                    current = [];
                    startTime = seg.time;
                }
            }

            let totalClaims = 0, hasError = false;
            for (let i = 0; i < chunks.length; i++) {
                updateStatus(`${t('analyzing')} (${i + 1}/${chunks.length})`, true);
                const result = await processText(chunks[i].text, chunks[i].avgTime);
                if (result.error) hasError = true;
                totalClaims += result.claimCount || 0;
            }

            if (hasError) updateStatus('⚠️ Einige Fehler aufgetreten', false);
            else if (totalClaims === 0) updateStatus(t('noClaims'), true);
            else updateStatus(`${t('ready')} - ${totalClaims} ${t('claims')}`, true);
            setTimeout(() => { btn.disabled = false; btn.textContent = originalText; }, 3000);
        } catch (error) {
            btn.textContent = '✗ ' + t('error');
            updateStatus('⚠️ ' + error.message, false);
            setTimeout(() => { btn.disabled = false; btn.textContent = originalText; }, 3000);
        }
    }

    // ==================== Live Caption Observer (Fallback) ====================
    let lastProcessTime = 0;
    let contextBuffer = []; // Rolling 30s context window

    function startLiveCaptionObserver() {
        if (captionObserver) return; // Already running
        isProcessing = true; // Fix: Enable processing for observer

        const mainPlayer = document.querySelector('#movie_player, .html5-video-player');
        if (!mainPlayer) {
            console.log('[FAKTCHECK] No player found, retrying...');
            setTimeout(startLiveCaptionObserver, 2000);
            return;
        }

        console.log('[FAKTCHECK] Starting live caption observer on main player');

        let debounceTimer = null;
        captionObserver = new MutationObserver(() => {
            // Debounce: batch rapid mutations
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                if (!isProcessing) return;

                const video = document.querySelector('#movie_player video');
                const currentTime = video?.currentTime || 0;

                // v3.6: Stop when video ends
                if (video && video.ended) {
                    console.log('[FAKTCHECK] Video ended - stopping analysis');
                    isProcessing = false;
                    updateStatus(currentLang === 'de' ? 'Video beendet' : 'Video ended', false);
                    if (captionObserver) {
                        captionObserver.disconnect();
                        captionObserver = null;
                    }
                    return;
                }

                const segments = mainPlayer.querySelectorAll('.ytp-caption-segment');
                if (segments.length === 0) return;

                segments.forEach(el => {
                    const text = el.textContent?.trim();
                    if (text && text.length > 2 && !captionBuffer.includes(text)) {
                        captionBuffer.push(text);
                        // Size cap: prevent memory bloat
                        if (captionBuffer.length > 100) captionBuffer.shift();
                        // Also add to context buffer with timestamp
                        contextBuffer.push({ text, time: currentTime });
                    }
                });

                // Prune context buffer to last 30 seconds
                const cutoffTime = currentTime - 30;
                contextBuffer = contextBuffer.filter(c => c.time > cutoffTime);

                const newText = captionBuffer.join(' ');
                const now = Date.now();

                // Process every 15 seconds if we have 400+ new chars
                if (newText.length > 400 && (now - lastProcessTime > 15000)) {
                    // Build context from the 30s buffer (excluding current batch)
                    const contextText = contextBuffer
                        .filter(c => !captionBuffer.includes(c.text))
                        .map(c => c.text)
                        .join(' ');

                    console.log('[FAKTCHECK] Processing:', newText.length, 'new chars +', contextText.length, 'context chars');

                    // Combine: context (as background) + new text (to analyze)
                    const fullText = contextText.length > 100
                        ? `[Context from previous 30 seconds: ${contextText}]\n\nNew content to analyze:\n${newText}`
                        : newText;

                    processText(fullText, currentTime);

                    // Clear the new text buffer but keep context buffer rolling
                    captionBuffer = [];
                    lastProcessTime = now;
                }
            }, 100);  // 100ms debounce
        });

        captionObserver.observe(mainPlayer, { childList: true, subtree: true });
        updateStatus(t('live') + ' - ' + t('waiting'), true);
    }

    // ==================== Sidebar Control ====================
    function showSidebar() {
        const sidebar = document.getElementById('faktcheck-sidebar');
        if (sidebar) { sidebar.classList.add('visible'); sidebarVisible = true; console.log('[FAKTCHECK] Sidebar shown'); }
    }

    function hideSidebar() {
        const sidebar = document.getElementById('faktcheck-sidebar');
        if (sidebar) { sidebar.classList.remove('visible'); sidebarVisible = false; console.log('[FAKTCHECK] Sidebar hidden'); }
    }

    function toggleSidebar() { if (sidebarVisible) hideSidebar(); else showSidebar(); }

    function toggleProcessing() {
        isProcessing = !isProcessing;
        const btn = document.getElementById('faktcheck-toggle');
        if (isProcessing) { if (btn) btn.textContent = '⏸'; updateStatus(t('ready'), true); }
        else { if (btn) btn.textContent = '▶'; updateStatus(t('paused'), false); }
    }

    function injectToggleButton() {
        const check = setInterval(() => {
            const container = document.querySelector('#top-level-buttons-computed');
            if (container && !document.getElementById('faktcheck-yt-btn')) {
                const btn = S.createElement('button', { id: 'faktcheck-yt-btn', class: 'faktcheck-yt-toggle' }, '📋 FAKTCHECK');
                btn.addEventListener('click', toggleSidebar);
                container.insertBefore(btn, container.firstChild);
                console.log('[FAKTCHECK] Toggle button injected');
                clearInterval(check);
            }
        }, 500);
        setTimeout(() => clearInterval(check), 10000);
    }

    // ==================== Init ====================
    async function init() {
        console.log('[FAKTCHECK] ========== INIT ==========');

        // Resolve locale from storage / browser
        const locale = await I18n.getLocale();
        currentLang = locale;
        I18n.updateCachedLocale(locale);
        console.log('[FAKTCHECK] Locale resolved:', locale);

        const response = await sendMessageSafe({ type: 'CHECK_API_KEY' });
        if (!response.hasKey) console.warn('[FAKTCHECK] ⚠️ No API key configured!');
        else console.log('[FAKTCHECK] ✓ API key present');

        if (!window.location.pathname.includes('/watch')) { console.log('[FAKTCHECK] Not a video page'); return; }

        currentVideoId = getCurrentVideoId();
        console.log('[FAKTCHECK] Video:', currentVideoId);

        createSidebar();

        // Apply translations to sidebar data-i18n elements
        const sidebar = document.getElementById('faktcheck-sidebar');
        if (sidebar) {
            I18n.applyTranslations(sidebar, locale);
            sidebar.classList.add(`lang-${locale}`);
        }

        setTimeout(showSidebar, 1500);
        console.log(`[FAKTCHECK] ========== READY (${locale.toUpperCase()}) ==========`);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    // Listen for API key updates
    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'API_KEY_UPDATED') { console.log('[FAKTCHECK] API key updated'); init(); }
    });

    // Listen for language changes in storage → retranslate sidebar live
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.preferredLanguage) {
            const newLang = changes.preferredLanguage.newValue || 'en';
            console.log('[FAKTCHECK] Language changed to:', newLang);
            I18n.updateCachedLocale(newLang);
            currentLang = newLang;

            const sidebar = document.getElementById('faktcheck-sidebar');
            if (sidebar) {
                // Update data-i18n elements
                I18n.applyTranslations(sidebar, newLang);

                // Update verdict labels on meter (data-i18n-verdict)
                sidebar.querySelectorAll('[data-i18n-verdict]').forEach(el => {
                    const key = el.getAttribute('data-i18n-verdict');
                    if (key === 'false') el.textContent = '✗ ' + tv('false');
                    if (key === 'true') el.textContent = tv('true') + ' ✓';
                });

                // Update footer claim count
                const countEl = sidebar.querySelector('[data-i18n-suffix]');
                if (countEl) {
                    const num = parseInt(countEl.textContent) || 0;
                    countEl.textContent = num + ' ' + t('claims');
                }

                // Update lang class
                sidebar.className = sidebar.className.replace(/lang-\w+/, '');
                sidebar.classList.add(`lang-${newLang}`);

                console.log('[FAKTCHECK] Sidebar retranslated to', newLang);
            }
        }
    });

})();
