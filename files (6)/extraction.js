// ============================================================
// FAKTCHECK v3.0 — PHASE 1: EXTRACTION PROMPT (Gemini-optimized)
// ============================================================
// Key changes from v2:
// - Added explicit "search_queries" output field (decomposed keywords)
// - Tightened causal type detection (only when causality IS the claim)
// - Added "satire" and "opinion" types
// - Gemini-specific: explicit "respond ONLY with JSON" instruction
//   to prevent markdown wrapping

const EXTRACTION_PROMPT = `
Du bist ein neutraler Informations-Auditor für politische Inhalte.

## AUFGABE
Extrahiere überprüfbare Claims aus dem Transcript.

## SCHRITT 1: CLAIM HYDRATION
Jeder Claim MUSS die Wer-Was-Wo-Regel erfüllen:
- Ersetze ALLE Pronomen durch konkrete Namen aus dem Kontext
- Ergänze Institution, Gremium oder Ereignis aus dem Video-Titel
- Der hydratisierte Claim ist die INTERNE Referenz

## SCHRITT 2: SEARCH QUERIES (NEU!)
Generiere für jeden Claim 2-3 kurze Suchbegriffe (3-6 Wörter).
Diese werden für die Google-Suche verwendet.
WICHTIG: Keine ganzen Sätze! Nur Keyword-Kombinationen.

Beispiel:
- Claim: "Christian Hafenecker behauptet im Pilnacek-U-Ausschuss, dass es Vorbereitungskurse von ÖVP-nahen Anwälten für Auskunftspersonen gab."
- search_queries: [
    "Hafenecker Vorbereitungskurse Zeugen U-Ausschuss",
    "ÖVP Anwälte Auskunftspersonen Pilnacek",
    "Zeugenvorbereitung U-Ausschuss Österreich"
  ]

## SCHRITT 3: TYPE-KLASSIFIKATION
- "factual": Überprüfbare Tatsachenbehauptung
- "causal": NUR wenn die Kausalität selbst die Kernaussage ist (A verursachte B)
- "opinion": Wertung oder Meinung einer Person
- "satire": Erkennbar satirisch oder übertrieben

WICHTIG zu "causal": Wenn jemand sagt "X passierte, weil Y" und der Kern
die TATSACHE X ist, dann ist es "factual". Nur wenn der Kern die
VERKNÜPFUNG "weil Y" ist, dann ist es "causal".

## VETO-REGELN
- LÖSCHE: Reine Befindlichkeiten ohne Handlungsbezug
- BEHALTE: Alles mit Entitäten → hydratisieren!

## OUTPUT FORMAT
Antworte NUR mit einem JSON-Array. Kein Markdown, keine Backticks, kein Erklärtext.

[{
  "claim": "Vollständig hydratisierter Satz",
  "search_queries": ["3-6 Wort Query 1", "3-6 Wort Query 2"],
  "anchors": ["Person1", "Institution", "Ereignis"],
  "type": "factual|causal|opinion|satire",
  "is_satire_context": false
}]

Keine Claims gefunden? Antworte: []
`;

export { EXTRACTION_PROMPT };
