// FAKTCHECK Popup Script
document.addEventListener('DOMContentLoaded', async () => {
    const apiKeyInput = document.getElementById('apiKey');
    const langSelect = document.getElementById('langSelect');
    const autoStartCheckbox = document.getElementById('autoStart');
    const saveBtn = document.getElementById('saveBtn');
    const savedMsg = document.getElementById('savedMsg');
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const cacheSize = document.getElementById('cacheSize');
    const rateLimit = document.getElementById('rateLimit');

    // Load existing settings
    try {
        const result = await chrome.storage.local.get([
            'geminiApiKey',
            'language',
            'autoStart',
            'analysisCache'
        ]);

        if (result.geminiApiKey) {
            apiKeyInput.value = result.geminiApiKey;
            statusDot.classList.add('active');
            statusText.textContent = 'Ready';
        }

        if (result.language) {
            langSelect.value = result.language;
        }

        if (result.autoStart !== undefined) {
            autoStartCheckbox.checked = result.autoStart;
        }

        // Update cache size
        if (result.analysisCache) {
            cacheSize.textContent = Object.keys(result.analysisCache).length;
        }
    } catch (error) {
        console.error('Error loading settings:', error);
    }

    // Save settings
    saveBtn.addEventListener('click', async () => {
        const apiKey = apiKeyInput.value.trim();
        const language = langSelect.value;
        const autoStart = autoStartCheckbox.checked;

        if (!apiKey) {
            alert('Please enter a Gemini API key');
            return;
        }

        // Basic validation for Gemini API key format
        if (!apiKey.startsWith('AIza')) {
            alert('Invalid API key format. Gemini API keys start with "AIza"');
            return;
        }

        try {
            await chrome.storage.local.set({
                geminiApiKey: apiKey,
                language: language,
                autoStart: autoStart
            });

            // Update status
            statusDot.classList.add('active');
            statusText.textContent = 'Ready';

            // Show saved message
            savedMsg.classList.add('show');
            setTimeout(() => {
                savedMsg.classList.remove('show');
            }, 2000);

            // Settings saved - no action needed (background reads from storage directly)

        } catch (error) {
            console.error('Error saving settings:', error);
            alert('Failed to save settings: ' + error.message);
        }
    });

    // Check rate limit status periodically
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
