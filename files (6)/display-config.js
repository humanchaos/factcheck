// ============================================================
// FAKTCHECK v3.0 — DISPLAY CONFIG
// ============================================================
// Updated display mapping with separate 'deceptive' category

const DISPLAY_CONFIG = {
    true: {
        label: 'Bestätigt',
        labelEn: 'Confirmed',
        color: '#22c55e',       // Green
        bgColor: '#f0fdf4',
        icon: '✅',
        emoji: '🟢'
    },
    false: {
        label: 'Falsch',
        labelEn: 'False',
        color: '#ef4444',       // Red
        bgColor: '#fef2f2',
        icon: '❌',
        emoji: '🔴'
    },
    deceptive: {
        label: 'Irreführend',
        labelEn: 'Deceptive',
        color: '#f97316',       // Orange (NEW — distinct from false)
        bgColor: '#fff7ed',
        icon: '⚠️',
        emoji: '🟠',
        tooltip: 'Fakten stimmen teilweise, aber der behauptete Zusammenhang ist falsch.'
    },
    partially_true: {
        label: 'Teilweise wahr',
        labelEn: 'Partially True',
        color: '#eab308',       // Yellow
        bgColor: '#fefce8',
        icon: '⚡',
        emoji: '🟡'
    },
    unverifiable: {
        label: 'Nicht überprüfbar',
        labelEn: 'Unverifiable',
        color: '#6b7280',       // Gray
        bgColor: '#f9fafb',
        icon: '❓',
        emoji: '⚪'
    },
    opinion: {
        label: 'Meinung',
        labelEn: 'Opinion',
        color: '#8b5cf6',       // Purple
        bgColor: '#f5f3ff',
        icon: '💬',
        emoji: '🟣'
    }
};

// Confidence display thresholds
const CONFIDENCE_LABELS = {
    high:   { min: 0.80, label: 'Hohe Sicherheit',    labelEn: 'High confidence' },
    medium: { min: 0.60, label: 'Mittlere Sicherheit', labelEn: 'Medium confidence' },
    low:    { min: 0.40, label: 'Geringe Sicherheit',  labelEn: 'Low confidence' },
    vlow:   { min: 0.00, label: 'Sehr unsicher',       labelEn: 'Very low confidence' }
};

function getConfidenceLabel(confidence, lang = 'de') {
    const key = lang === 'de' ? 'label' : 'labelEn';
    for (const level of Object.values(CONFIDENCE_LABELS)) {
        if (confidence >= level.min) return level[key];
    }
    return CONFIDENCE_LABELS.vlow[key];
}

export { DISPLAY_CONFIG, CONFIDENCE_LABELS, getConfidenceLabel };
