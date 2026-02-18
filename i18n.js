// ============================================================
// TruthLens i18n — Multilingual Support Module
// ============================================================
// Loaded FIRST via manifest.json so window.TruthLensI18n
// is available for all subsequent scripts.
// ============================================================

(function () {
    'use strict';

    const SUPPORTED_LOCALES = ['de', 'en', 'fr', 'es', 'it', 'pt'];
    const DEFAULT_LOCALE = 'en';

    // ─── TRANSLATIONS ───────────────────────────────────────────

    const messages = {
        // ── German ──────────────────────────────────────────────
        de: {
            // Sidebar UI
            title: 'FAKTCHECK',
            live: 'LIVE',
            waiting: 'Warte auf Untertitel...',
            analyzing: 'Analysiere...',
            ready: 'Bereit',
            paused: 'Pausiert',
            noClaims: 'Keine Behauptungen gefunden',
            loadTranscript: 'Transkript laden',
            loading: 'Lade...',
            loaded: 'Geladen',
            noTranscript: 'Kein Transkript verfügbar',
            claims: 'Behauptungen',
            error: 'Fehler',
            noApiKey: 'API-Key fehlt!',
            confident: 'Konfidenz',
            exportBtn: 'Export',
            pauseBtn: 'Pause',
            closeBtn: 'Schließen',

            // Verdicts
            verdictTrue: 'WAHR',
            verdictFalse: 'FALSCH',
            verdictPartial: 'TEILWEISE',
            verdictUnverifiable: 'UNKLAR',
            verdictOpinion: 'MEINUNG',
            verdictPending: 'PRÜFE...',
            verdictDeceptive: 'IRREFÜHREND',
            verdictMissingContext: 'FEHLENDER KONTEXT',

            // Verdict display labels (for faktcheck-core DISPLAY_CONFIG)
            displayTrue: 'Bestätigt',
            displayFalse: 'Falsch',
            displayDeceptive: 'Irreführend',
            displayPartial: 'Teilweise wahr',
            displayUnverifiable: 'Nicht überprüfbar',
            displayOpinion: 'Meinung',
            displayMissingContext: 'Fehlender Kontext',

            // Satire context
            satiricalHyperbole: 'SATIRISCHE HYPERBEL',
            satiricalDesc: 'Bewusste Übertreibung im satirischen Kontext',

            // Popup
            popupTitle: 'FAKTCHECK',
            popupStatusNotConfigured: 'Nicht konfiguriert',
            popupStatusReady: 'Bereit',
            popupLabelApiKey: 'Gemini API-Key',
            popupLabelLanguage: 'Sprache',
            popupLabelAutoStart: 'Automatisch auf YouTube starten',
            popupBtnSave: 'Einstellungen speichern',
            popupSaved: '✓ Einstellungen gespeichert!',
            popupCacheSize: 'Cache-Größe:',
            popupRateLimit: 'Verbleibende Anfragen:',
            popupHelpLink: 'Kostenlosen Gemini API-Key holen →',
            popupAlertNoKey: 'Bitte gib einen Gemini API-Key ein',
            popupAlertInvalidKey: 'Ungültiges Key-Format. Gemini API-Keys beginnen mit "AIza"',
            popupLangAuto: 'Automatisch erkennen',
            popupSupportText: 'Jeder Kaffee treibt einen weiteren Faktencheck an. Hilf mit, dieses Tool kostenlos & Open Source zu halten.',
            popupBtnCoffee: 'Kaffee spendieren',
            popupBtnSponsor: 'Sponsor',

            // Error messages
            errorRateLimit: 'Rate Limit überschritten. Bitte warte einen Moment.',
            errorNoKey: 'Kein API-Key. Klicke auf das Erweiterungs-Symbol um deinen Gemini API-Key einzugeben.',
            errorParse: 'Antwort konnte nicht verarbeitet werden',
            errorFetch: 'Fehler',
            errorSourcesOnly: 'Quellen gefunden, aber keine explizite Analyse von Gemini.',
            errorNoResponse: 'Keine Antwort von Gemini erhalten.',
            errorDerived: 'Aus Suchresultaten abgeleitet.',

            // Core messages
            coreOpinion: 'Meinungsäußerung.',
            coreProcedural: 'Ankündigung, nicht überprüfbar.',
            coreSourceLabel: 'Quelle'
        },

        // ── English ─────────────────────────────────────────────
        en: {
            title: 'FAKTCHECK',
            live: 'LIVE',
            waiting: 'Waiting for captions...',
            analyzing: 'Analyzing...',
            ready: 'Ready',
            paused: 'Paused',
            noClaims: 'No claims found',
            loadTranscript: 'Load Transcript',
            loading: 'Loading...',
            loaded: 'Loaded',
            noTranscript: 'No transcript available',
            claims: 'claims',
            error: 'Error',
            noApiKey: 'API key missing!',
            confident: 'Confidence',
            exportBtn: 'Export',
            pauseBtn: 'Pause',
            closeBtn: 'Close',

            verdictTrue: 'TRUE',
            verdictFalse: 'FALSE',
            verdictPartial: 'PARTIAL',
            verdictUnverifiable: 'UNCLEAR',
            verdictOpinion: 'OPINION',
            verdictPending: 'CHECKING...',
            verdictDeceptive: 'DECEPTIVE',
            verdictMissingContext: 'MISSING CONTEXT',

            displayTrue: 'Confirmed',
            displayFalse: 'False',
            displayDeceptive: 'Deceptive',
            displayPartial: 'Partially true',
            displayUnverifiable: 'Unverifiable',
            displayOpinion: 'Opinion',
            displayMissingContext: 'Missing Context',

            satiricalHyperbole: 'SATIRICAL HYPERBOLE',
            satiricalDesc: 'Deliberate exaggeration in satirical context',

            popupTitle: 'FAKTCHECK',
            popupStatusNotConfigured: 'Not configured',
            popupStatusReady: 'Ready',
            popupLabelApiKey: 'Gemini API Key',
            popupLabelLanguage: 'Language',
            popupLabelAutoStart: 'Auto-start on YouTube videos',
            popupBtnSave: 'Save Settings',
            popupSaved: '✓ Settings saved!',
            popupCacheSize: 'Cache size:',
            popupRateLimit: 'Rate limit remaining:',
            popupHelpLink: 'Get a free Gemini API key →',
            popupAlertNoKey: 'Please enter a Gemini API key',
            popupAlertInvalidKey: 'Invalid API key format. Gemini API keys start with "AIza"',
            popupLangAuto: 'Auto-detect',
            popupSupportText: 'Every coffee fuels another fact-check. Help keep this tool free & open source.',
            popupBtnCoffee: 'Buy me a coffee',
            popupBtnSponsor: 'Sponsor',

            errorRateLimit: 'Rate limit exceeded. Please wait a moment.',
            errorNoKey: 'No API key. Click extension icon to add your Gemini API key.',
            errorParse: 'Could not parse response',
            errorFetch: 'Error',
            errorSourcesOnly: 'Sources found, but no explicit analysis from Gemini.',
            errorNoResponse: 'No response from Gemini received.',
            errorDerived: 'Derived from search results.',

            coreOpinion: 'Opinion statement.',
            coreProcedural: 'Announcement, not verifiable.',
            coreSourceLabel: 'Source'
        },

        // ── French ──────────────────────────────────────────────
        fr: {
            title: 'FAKTCHECK',
            live: 'EN DIRECT',
            waiting: 'En attente des sous-titres...',
            analyzing: 'Analyse en cours...',
            ready: 'Prêt',
            paused: 'En pause',
            noClaims: 'Aucune affirmation trouvée',
            loadTranscript: 'Charger la transcription',
            loading: 'Chargement...',
            loaded: 'Chargé',
            noTranscript: 'Aucune transcription disponible',
            claims: 'affirmations',
            error: 'Erreur',
            noApiKey: 'Clé API manquante !',
            confident: 'Confiance',
            exportBtn: 'Exporter',
            pauseBtn: 'Pause',
            closeBtn: 'Fermer',

            verdictTrue: 'VRAI',
            verdictFalse: 'FAUX',
            verdictPartial: 'PARTIEL',
            verdictUnverifiable: 'INCERTAIN',
            verdictOpinion: 'OPINION',
            verdictPending: 'VÉRIFICATION...',
            verdictDeceptive: 'TROMPEUR',
            verdictMissingContext: 'CONTEXTE MANQUANT',

            displayTrue: 'Confirmé',
            displayFalse: 'Faux',
            displayDeceptive: 'Trompeur',
            displayPartial: 'Partiellement vrai',
            displayUnverifiable: 'Non vérifiable',
            displayOpinion: 'Opinion',
            displayMissingContext: 'Contexte manquant',

            satiricalHyperbole: 'HYPERBOLE SATIRIQUE',
            satiricalDesc: 'Exagération délibérée dans un contexte satirique',

            popupTitle: 'FAKTCHECK',
            popupStatusNotConfigured: 'Non configuré',
            popupStatusReady: 'Prêt',
            popupLabelApiKey: 'Clé API Gemini',
            popupLabelLanguage: 'Langue',
            popupLabelAutoStart: 'Démarrage auto sur YouTube',
            popupBtnSave: 'Enregistrer',
            popupSaved: '✓ Paramètres enregistrés !',
            popupCacheSize: 'Taille du cache :',
            popupRateLimit: 'Requêtes restantes :',
            popupHelpLink: 'Obtenir une clé API Gemini gratuite →',
            popupAlertNoKey: 'Veuillez entrer une clé API Gemini',
            popupAlertInvalidKey: 'Format de clé invalide. Les clés API Gemini commencent par "AIza"',
            popupLangAuto: 'Détection automatique',
            popupSupportText: 'Chaque café alimente un nouveau fact-check. Aidez à garder cet outil gratuit et open source.',
            popupBtnCoffee: 'Offrir un café',
            popupBtnSponsor: 'Sponsoriser',

            errorRateLimit: 'Limite de requêtes atteinte. Veuillez patienter.',
            errorNoKey: 'Pas de clé API. Cliquez sur l\'icône pour ajouter votre clé Gemini.',
            errorParse: 'Impossible d\'analyser la réponse',
            errorFetch: 'Erreur',
            errorSourcesOnly: 'Sources trouvées, mais pas d\'analyse explicite de Gemini.',
            errorNoResponse: 'Aucune réponse de Gemini reçue.',
            errorDerived: 'Déduit des résultats de recherche.',

            coreOpinion: 'Expression d\'opinion.',
            coreProcedural: 'Annonce, non vérifiable.',
            coreSourceLabel: 'Source'
        },

        // ── Spanish ─────────────────────────────────────────────
        es: {
            title: 'FAKTCHECK',
            live: 'EN VIVO',
            waiting: 'Esperando subtítulos...',
            analyzing: 'Analizando...',
            ready: 'Listo',
            paused: 'Pausado',
            noClaims: 'No se encontraron afirmaciones',
            loadTranscript: 'Cargar transcripción',
            loading: 'Cargando...',
            loaded: 'Cargado',
            noTranscript: 'No hay transcripción disponible',
            claims: 'afirmaciones',
            error: 'Error',
            noApiKey: '¡Falta la clave API!',
            confident: 'Confianza',
            exportBtn: 'Exportar',
            pauseBtn: 'Pausa',
            closeBtn: 'Cerrar',

            verdictTrue: 'VERDADERO',
            verdictFalse: 'FALSO',
            verdictPartial: 'PARCIAL',
            verdictUnverifiable: 'INCIERTO',
            verdictOpinion: 'OPINIÓN',
            verdictPending: 'VERIFICANDO...',
            verdictDeceptive: 'ENGAÑOSO',
            verdictMissingContext: 'CONTEXTO FALTANTE',

            displayTrue: 'Confirmado',
            displayFalse: 'Falso',
            displayDeceptive: 'Engañoso',
            displayPartial: 'Parcialmente cierto',
            displayUnverifiable: 'No verificable',
            displayOpinion: 'Opinión',
            displayMissingContext: 'Contexto faltante',

            satiricalHyperbole: 'HIPÉRBOLE SATÍRICA',
            satiricalDesc: 'Exageración deliberada en contexto satírico',

            popupTitle: 'FAKTCHECK',
            popupStatusNotConfigured: 'No configurado',
            popupStatusReady: 'Listo',
            popupLabelApiKey: 'Clave API Gemini',
            popupLabelLanguage: 'Idioma',
            popupLabelAutoStart: 'Inicio automático en YouTube',
            popupBtnSave: 'Guardar ajustes',
            popupSaved: '✓ ¡Ajustes guardados!',
            popupCacheSize: 'Tamaño de caché:',
            popupRateLimit: 'Límite de solicitudes:',
            popupHelpLink: 'Obtener una clave API Gemini gratis →',
            popupAlertNoKey: 'Por favor, introduce una clave API Gemini',
            popupAlertInvalidKey: 'Formato de clave inválido. Las claves API Gemini empiezan con "AIza"',
            popupLangAuto: 'Detección automática',
            popupSupportText: 'Cada café impulsa otra verificación. Ayuda a mantener esta herramienta gratuita y de código abierto.',
            popupBtnCoffee: 'Invítame un café',
            popupBtnSponsor: 'Patrocinar',

            errorRateLimit: 'Límite de solicitudes alcanzado. Por favor, espera un momento.',
            errorNoKey: 'Sin clave API. Haz clic en el icono de la extensión para añadir tu clave Gemini.',
            errorParse: 'No se pudo procesar la respuesta',
            errorFetch: 'Error',
            errorSourcesOnly: 'Se encontraron fuentes, pero sin análisis explícito de Gemini.',
            errorNoResponse: 'No se recibió respuesta de Gemini.',
            errorDerived: 'Derivado de resultados de búsqueda.',

            coreOpinion: 'Expresión de opinión.',
            coreProcedural: 'Anuncio, no verificable.',
            coreSourceLabel: 'Fuente'
        },

        // ── Italian ─────────────────────────────────────────────
        it: {
            title: 'FAKTCHECK',
            live: 'IN DIRETTA',
            waiting: 'In attesa dei sottotitoli...',
            analyzing: 'Analisi in corso...',
            ready: 'Pronto',
            paused: 'In pausa',
            noClaims: 'Nessuna affermazione trovata',
            loadTranscript: 'Carica trascrizione',
            loading: 'Caricamento...',
            loaded: 'Caricato',
            noTranscript: 'Nessuna trascrizione disponibile',
            claims: 'affermazioni',
            error: 'Errore',
            noApiKey: 'Chiave API mancante!',
            confident: 'Fiducia',
            exportBtn: 'Esporta',
            pauseBtn: 'Pausa',
            closeBtn: 'Chiudi',

            verdictTrue: 'VERO',
            verdictFalse: 'FALSO',
            verdictPartial: 'PARZIALE',
            verdictUnverifiable: 'INCERTO',
            verdictOpinion: 'OPINIONE',
            verdictPending: 'VERIFICA...',
            verdictDeceptive: 'INGANNEVOLE',
            verdictMissingContext: 'CONTESTO MANCANTE',

            displayTrue: 'Confermato',
            displayFalse: 'Falso',
            displayDeceptive: 'Ingannevole',
            displayPartial: 'Parzialmente vero',
            displayUnverifiable: 'Non verificabile',
            displayOpinion: 'Opinione',
            displayMissingContext: 'Contesto mancante',

            satiricalHyperbole: 'IPERBOLE SATIRICA',
            satiricalDesc: 'Esagerazione deliberata in contesto satirico',

            popupTitle: 'FAKTCHECK',
            popupStatusNotConfigured: 'Non configurato',
            popupStatusReady: 'Pronto',
            popupLabelApiKey: 'Chiave API Gemini',
            popupLabelLanguage: 'Lingua',
            popupLabelAutoStart: 'Avvio automatico su YouTube',
            popupBtnSave: 'Salva impostazioni',
            popupSaved: '✓ Impostazioni salvate!',
            popupCacheSize: 'Dimensione cache:',
            popupRateLimit: 'Richieste rimanenti:',
            popupHelpLink: 'Ottieni una chiave API Gemini gratuita →',
            popupAlertNoKey: 'Inserisci una chiave API Gemini',
            popupAlertInvalidKey: 'Formato chiave non valido. Le chiavi API Gemini iniziano con "AIza"',
            popupLangAuto: 'Rilevamento automatico',
            popupSupportText: 'Ogni caffè alimenta un altro fact-check. Aiuta a mantenere questo strumento gratuito e open source.',
            popupBtnCoffee: 'Offrimi un caffè',
            popupBtnSponsor: 'Sponsorizza',

            errorRateLimit: 'Limite di richieste raggiunto. Attendere un momento.',
            errorNoKey: 'Nessuna chiave API. Fai clic sull\'icona per aggiungere la tua chiave Gemini.',
            errorParse: 'Impossibile elaborare la risposta',
            errorFetch: 'Errore',
            errorSourcesOnly: 'Fonti trovate, ma nessuna analisi esplicita da Gemini.',
            errorNoResponse: 'Nessuna risposta da Gemini ricevuta.',
            errorDerived: 'Derivato dai risultati di ricerca.',

            coreOpinion: 'Espressione di opinione.',
            coreProcedural: 'Annuncio, non verificabile.',
            coreSourceLabel: 'Fonte'
        },

        // ── Portuguese ──────────────────────────────────────────
        pt: {
            title: 'FAKTCHECK',
            live: 'AO VIVO',
            waiting: 'Aguardando legendas...',
            analyzing: 'Analisando...',
            ready: 'Pronto',
            paused: 'Pausado',
            noClaims: 'Nenhuma afirmação encontrada',
            loadTranscript: 'Carregar transcrição',
            loading: 'Carregando...',
            loaded: 'Carregado',
            noTranscript: 'Nenhuma transcrição disponível',
            claims: 'afirmações',
            error: 'Erro',
            noApiKey: 'Chave API em falta!',
            confident: 'Confiança',
            exportBtn: 'Exportar',
            pauseBtn: 'Pausa',
            closeBtn: 'Fechar',

            verdictTrue: 'VERDADEIRO',
            verdictFalse: 'FALSO',
            verdictPartial: 'PARCIAL',
            verdictUnverifiable: 'INCERTO',
            verdictOpinion: 'OPINIÃO',
            verdictPending: 'VERIFICANDO...',
            verdictDeceptive: 'ENGANOSO',
            verdictMissingContext: 'CONTEXTO EM FALTA',

            displayTrue: 'Confirmado',
            displayFalse: 'Falso',
            displayDeceptive: 'Enganoso',
            displayPartial: 'Parcialmente verdadeiro',
            displayUnverifiable: 'Não verificável',
            displayOpinion: 'Opinião',
            displayMissingContext: 'Contexto em falta',

            satiricalHyperbole: 'HIPÉRBOLE SATÍRICA',
            satiricalDesc: 'Exagero deliberado em contexto satírico',

            popupTitle: 'FAKTCHECK',
            popupStatusNotConfigured: 'Não configurado',
            popupStatusReady: 'Pronto',
            popupLabelApiKey: 'Chave API Gemini',
            popupLabelLanguage: 'Idioma',
            popupLabelAutoStart: 'Iniciar automaticamente no YouTube',
            popupBtnSave: 'Guardar definições',
            popupSaved: '✓ Definições guardadas!',
            popupCacheSize: 'Tamanho do cache:',
            popupRateLimit: 'Pedidos restantes:',
            popupHelpLink: 'Obter uma chave API Gemini gratuita →',
            popupAlertNoKey: 'Por favor, introduz uma chave API Gemini',
            popupAlertInvalidKey: 'Formato de chave inválido. As chaves API Gemini começam com "AIza"',
            popupLangAuto: 'Deteção automática',
            popupSupportText: 'Cada café impulsiona mais uma verificação. Ajuda a manter esta ferramenta gratuita e open source.',
            popupBtnCoffee: 'Oferece um café',
            popupBtnSponsor: 'Patrocinar',

            errorRateLimit: 'Limite de pedidos atingido. Por favor, aguarda um momento.',
            errorNoKey: 'Sem chave API. Clica no ícone da extensão para adicionar a tua chave Gemini.',
            errorParse: 'Não foi possível processar a resposta',
            errorFetch: 'Erro',
            errorSourcesOnly: 'Fontes encontradas, mas sem análise explícita do Gemini.',
            errorNoResponse: 'Nenhuma resposta do Gemini recebida.',
            errorDerived: 'Derivado dos resultados de pesquisa.',

            coreOpinion: 'Expressão de opinião.',
            coreProcedural: 'Anúncio, não verificável.',
            coreSourceLabel: 'Fonte'
        }
    };

    // ─── VERDICT KEY MAPPING ────────────────────────────────────
    // Maps verdict IDs to i18n keys
    const VERDICT_KEYS = {
        true: 'verdictTrue',
        mostly_true: 'verdictTrue',
        false: 'verdictFalse',
        mostly_false: 'verdictFalse',
        partially_true: 'verdictPartial',
        misleading: 'verdictPartial',
        unverifiable: 'verdictUnverifiable',
        opinion: 'verdictOpinion',
        pending: 'verdictPending',
        deceptive: 'verdictDeceptive',
        missing_context: 'verdictMissingContext',
        satirical_hyperbole: 'satiricalHyperbole'
    };

    const DISPLAY_LABEL_KEYS = {
        true: 'displayTrue',
        false: 'displayFalse',
        deceptive: 'displayDeceptive',
        partially_true: 'displayPartial',
        unverifiable: 'displayUnverifiable',
        opinion: 'displayOpinion',
        missing_context: 'displayMissingContext'
    };

    // ─── LOCALE RESOLUTION ──────────────────────────────────────

    /**
     * Resolves a raw locale string to a supported 2-letter code.
     * e.g. 'de-AT' → 'de', 'pt-BR' → 'pt', 'ja' → 'en' (fallback)
     */
    function resolveLocale(raw) {
        if (!raw) return DEFAULT_LOCALE;
        const code = String(raw).toLowerCase().split(/[-_]/)[0];
        return SUPPORTED_LOCALES.includes(code) ? code : DEFAULT_LOCALE;
    }

    /**
     * Gets the active locale:
     * 1. User override from chrome.storage.local ('preferredLanguage')
     * 2. Browser locale (navigator.language)
     * 3. Fallback to 'en'
     */
    async function getLocale() {
        try {
            const result = await chrome.storage.local.get(['preferredLanguage']);
            if (result.preferredLanguage && result.preferredLanguage !== 'auto') {
                return resolveLocale(result.preferredLanguage);
            }
        } catch (e) {
            // storage may not be available in all contexts
        }
        return resolveLocale(navigator.language || navigator.userLanguage || DEFAULT_LOCALE);
    }

    /**
     * Synchronous locale getter — uses cached value or navigator.language.
     * For use in contexts where async isn't possible.
     */
    let _cachedLocale = resolveLocale(navigator.language);

    function getLocaleSync() {
        return _cachedLocale;
    }

    // Prime the cache from storage on load
    (async () => {
        try {
            _cachedLocale = await getLocale();
        } catch (e) { /* keep browser default */ }
    })();

    // ─── TRANSLATION HELPERS ────────────────────────────────────

    /**
     * Translate a key synchronously using the given or cached locale.
     */
    function tSync(key, locale) {
        const lang = locale || _cachedLocale;
        return messages[lang]?.[key] || messages[DEFAULT_LOCALE]?.[key] || key;
    }

    /**
     * Translate a verdict ID to its display label.
     */
    function tvSync(verdict, locale) {
        const lang = locale || _cachedLocale;
        const key = VERDICT_KEYS[verdict];
        if (!key) return verdict?.toUpperCase() || '?';
        return messages[lang]?.[key] || messages[DEFAULT_LOCALE]?.[key] || verdict;
    }

    /**
     * Get the display label for DISPLAY_CONFIG (e.g., 'Bestätigt', 'Confirmed').
     */
    function getDisplayLabel(verdict, locale) {
        const lang = locale || _cachedLocale;
        const key = DISPLAY_LABEL_KEYS[verdict];
        if (!key) return verdict;
        return messages[lang]?.[key] || messages[DEFAULT_LOCALE]?.[key] || verdict;
    }

    /**
     * Async translate — resolves locale from storage first.
     */
    async function t(key) {
        const locale = await getLocale();
        return tSync(key, locale);
    }

    /**
     * Async verdict translate.
     */
    async function tv(verdict) {
        const locale = await getLocale();
        return tvSync(verdict, locale);
    }

    // ─── APPLY DATA-I18N ATTRIBUTES ─────────────────────────────

    /**
     * Translates all elements with [data-i18n] inside a container.
     */
    function applyTranslations(container, locale) {
        const lang = locale || _cachedLocale;
        const elements = (container || document).querySelectorAll('[data-i18n]');
        elements.forEach(el => {
            const key = el.getAttribute('data-i18n');
            const translation = tSync(key, lang);
            // For inputs, set placeholder; for others, set textContent
            if (el.tagName === 'INPUT' && el.type !== 'checkbox') {
                el.placeholder = translation;
            } else if (el.tagName === 'OPTION') {
                el.textContent = translation;
            } else {
                el.textContent = translation;
            }
        });
    }

    // ─── PUBLIC API ─────────────────────────────────────────────

    window.TruthLensI18n = {
        // Locale
        getLocale,
        getLocaleSync,
        resolveLocale,
        SUPPORTED_LOCALES,
        DEFAULT_LOCALE,

        // Translation functions
        t,
        tv,
        tSync,
        tvSync,
        getDisplayLabel,
        applyTranslations,

        // Raw messages (for direct access)
        messages,
        VERDICT_KEYS,
        DISPLAY_LABEL_KEYS,

        // Update cached locale (called after storage changes)
        updateCachedLocale(locale) {
            _cachedLocale = resolveLocale(locale);
        }
    };

    console.log('[TruthLens i18n] Module loaded, browser locale:', _cachedLocale);
})();
