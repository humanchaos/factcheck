// FAKTCHECK v2.0 - Security Utilities
// XSS protection, safe DOM manipulation

'use strict';

const SecurityUtils = {

    // Escape HTML entities to prevent XSS
    escapeHtml(text) {
        if (typeof text !== 'string') return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },

    // Escape for HTML attributes
    escapeAttr(text) {
        if (typeof text !== 'string') return '';
        return text
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#x27;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    },

    // Validate URL - only allow http/https
    sanitizeUrl(url) {
        if (typeof url !== 'string') return null;
        try {
            const parsed = new URL(url);
            if (!['http:', 'https:'].includes(parsed.protocol)) return null;
            return parsed.href;
        } catch {
            return null;
        }
    },

    // Create element safely
    createElement(tag, attrs = {}, content = null) {
        const el = document.createElement(tag);

        for (const [key, value] of Object.entries(attrs)) {
            // Block event handlers
            if (key.toLowerCase().startsWith('on')) continue;

            if (key === 'href' || key === 'src') {
                const safe = this.sanitizeUrl(value);
                if (safe) el.setAttribute(key, safe);
            } else if (key === 'class' || key === 'className') {
                el.className = String(value).replace(/[^a-zA-Z0-9_\- ]/g, '');
            } else if (key.startsWith('data-')) {
                el.setAttribute(key, this.escapeAttr(String(value)));
            } else {
                el.setAttribute(key, this.escapeAttr(String(value)));
            }
        }

        if (content !== null) {
            if (typeof content === 'string') {
                el.textContent = content;
            } else if (content instanceof Node) {
                el.appendChild(content);
            } else if (Array.isArray(content)) {
                content.forEach(child => {
                    if (child instanceof Node) el.appendChild(child);
                    else if (typeof child === 'string') el.appendChild(document.createTextNode(child));
                });
            }
        }

        return el;
    },

    // Create text node (always safe)
    createText(text) {
        return document.createTextNode(String(text));
    },

    // Sanitize claim data
    sanitizeClaim(claim) {
        if (!claim || typeof claim !== 'object') return null;

        const validVerdicts = ['true', 'false', 'partially_true', 'unverifiable',
            'opinion', 'pending', 'mostly_true', 'mostly_false', 'misleading'];

        return {
            id: String(claim.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50),
            text: String(claim.text || '').slice(0, 2000),
            timestamp: typeof claim.timestamp === 'number' ? claim.timestamp : 0,
            verdict: validVerdicts.includes(claim.verdict) ? claim.verdict : 'pending',
            displayVerdict: validVerdicts.includes(claim.displayVerdict) ? claim.displayVerdict : 'pending',
            speaker: claim.speaker ? String(claim.speaker).slice(0, 200) : null,
            explanation: String(claim.explanation || '').slice(0, 1000),
            confidence: typeof claim.confidence === 'number' ? Math.max(0, Math.min(1, claim.confidence)) : 0,
            key_facts: Array.isArray(claim.key_facts)
                ? claim.key_facts.filter(f => typeof f === 'string').slice(0, 10).map(f => f.slice(0, 500))
                : [],
            sources: Array.isArray(claim.sources)
                ? claim.sources.filter(s => s && typeof s.url === 'string').slice(0, 10).map(s => ({
                    title: String(s.title || 'Source').slice(0, 200),
                    url: this.sanitizeUrl(s.url),
                    tier: typeof s.tier === 'number' ? Math.max(1, Math.min(4, s.tier)) : 4,
                    quote: s.quote ? String(s.quote).slice(0, 300) : undefined
                })).filter(s => s.url)
                : [],
            caveats: claim.caveats ? String(claim.caveats).slice(0, 500) : undefined,
            // Evidence Chain fields
            quote: claim.quote ? String(claim.quote).slice(0, 500) : '',
            primary_source: claim.primary_source ? this.sanitizeUrl(String(claim.primary_source)) : '',
            confidence_basis: ['direct_match', 'paraphrase', 'insufficient_data'].includes(claim.confidence_basis) ? claim.confidence_basis : '',
            source_quality: ['high', 'medium', 'low'].includes(claim.source_quality) ? claim.source_quality : 'low',
            is_satire_context: !!claim.is_satire_context
        };
    }
};

// Freeze to prevent tampering
Object.freeze(SecurityUtils);
window.SecurityUtils = SecurityUtils;
