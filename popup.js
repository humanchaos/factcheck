// FAKTCHECK Popup Script — Multilingual
document.addEventListener('DOMContentLoaded', async () => {
    const I18n = window.TruthLensI18n;
    if (!I18n) { console.error('[Popup] TruthLensI18n not loaded!'); return; }

    const apiKeyInput = document.getElementById('apiKey');
    const langSelect = document.getElementById('langSelect');
    const autoStartCheckbox = document.getElementById('autoStart');
    const saveBtn = document.getElementById('saveBtn');
    const savedMsg = document.getElementById('savedMsg');
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const cacheSize = document.getElementById('cacheSize');
    const rateLimit = document.getElementById('rateLimit');

    // Helper: translate using current locale
    const t = (key) => I18n.tSync(key);

    /**
     * Apply translations to all data-i18n elements in the popup.
     */
    function translatePopup(locale) {
        I18n.applyTranslations(document, locale);
    }

    // ── Load existing settings ──────────────────────────────────
    try {
        const result = await chrome.storage.local.get([
            'geminiApiKey',
            'preferredLanguage',
            'autoStart',
            'analysisCache'
        ]);

        // Resolve locale: storage override → browser → 'en'
        const storedLang = result.preferredLanguage || 'auto';
        langSelect.value = storedLang;

        // Set cached locale so t() works immediately
        if (storedLang !== 'auto') {
            I18n.updateCachedLocale(storedLang);
        } else {
            I18n.updateCachedLocale(navigator.language);
        }

        // Translate the popup UI
        translatePopup(I18n.getLocaleSync());

        if (result.geminiApiKey) {
            apiKeyInput.value = result.geminiApiKey;
            statusDot.classList.add('active');
            statusText.textContent = t('popupStatusReady');
        }

        if (result.autoStart !== undefined) {
            autoStartCheckbox.checked = result.autoStart;
        }

        if (result.analysisCache) {
            cacheSize.textContent = Object.keys(result.analysisCache).length;
        }
    } catch (error) {
        console.error('Error loading settings:', error);
    }

    // ── Re-translate when language selector changes ──────────────
    langSelect.addEventListener('change', () => {
        const selected = langSelect.value;
        if (selected !== 'auto') {
            I18n.updateCachedLocale(selected);
        } else {
            I18n.updateCachedLocale(navigator.language);
        }
        translatePopup(I18n.getLocaleSync());
    });

    // ── Save settings ───────────────────────────────────────────
    saveBtn.addEventListener('click', async () => {
        const apiKey = apiKeyInput.value.trim();
        const language = langSelect.value;
        const autoStart = autoStartCheckbox.checked;

        if (!apiKey) {
            alert(t('popupAlertNoKey'));
            return;
        }

        if (!apiKey.startsWith('AIza')) {
            alert(t('popupAlertInvalidKey'));
            return;
        }

        try {
            await chrome.storage.local.set({
                geminiApiKey: apiKey,
                preferredLanguage: language,
                autoStart: autoStart
            });

            // Update status
            statusDot.classList.add('active');
            statusText.textContent = t('popupStatusReady');

            // Show saved message
            savedMsg.classList.add('show');
            setTimeout(() => {
                savedMsg.classList.remove('show');
            }, 2000);

            // Notify content script about API key change
            try {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (tab?.id) {
                    chrome.tabs.sendMessage(tab.id, { type: 'API_KEY_UPDATED' });
                }
            } catch (e) { /* tab may not be available */ }

        } catch (error) {
            console.error('Error saving settings:', error);
            alert(t('errorFetch') + ': ' + error.message);
        }
    });

    // ── Rate limit status ───────────────────────────────────────
    async function updateRateLimitStatus() {
        try {
            const result = await chrome.storage.local.get(['rateLimitInfo']);
            if (result.rateLimitInfo) {
                const remaining = result.rateLimitInfo.remaining || '--';
                rateLimit.textContent = remaining;
            }
        } catch (error) {
            console.error('Error getting rate limit:', error);
        }
    }

    updateRateLimitStatus();
});
