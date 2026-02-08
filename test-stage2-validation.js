#!/usr/bin/env node
/**
 * Stage 2 Validation Report — tests stripAttribution() against attribution-heavy inputs
 */

const fs = require('fs');
const src = fs.readFileSync('background.js', 'utf8');

// Extract and eval stripAttribution function
const match = src.match(/\/\/ V5\.4: SEMANTIC CORE EXTRACTION[\s\S]*?^}/m);
if (!match) { console.error('Could not find stripAttribution'); process.exit(1); }
eval(match[0]);

const tests = [
    { id: 1, input: 'Christian Stocker ist der aktuelle Bundeskanzler von Österreich.', hasAttrib: false },
    { id: 2, input: 'Laut Prognosen wächst Österreichs BIP 2026 um 5%.', hasAttrib: true },
    { id: 3, input: 'Die Inflation in Österreich lag 2025 bei 2.4%.', hasAttrib: false },
    { id: 4, input: 'FPÖ Neujahrstreffen 2026 fand in Wien statt.', hasAttrib: false },
    { id: 5, input: 'Laut ORF beträgt der ORF-Beitrag ab 2026 15,30€ pro Monat.', hasAttrib: true },
    { id: 6, input: 'Kickl sagt, Österreich hat 10 Millionen Einwohner.', hasAttrib: true },
    { id: 7, input: 'Die österreichische Nationalbank wurde 1816 gegründet.', hasAttrib: false },
    { id: 8, input: 'Graz ist die Hauptstadt der Steiermark.', hasAttrib: false },
    { id: 9, input: 'Im Video wird erklärt, dass Wien die lebenswerteste Stadt der Welt 2025 ist.', hasAttrib: true },
    { id: 10, input: "According to official data, Austria's population is 20 million.", hasAttrib: true },
    { id: 11, input: 'Laut dem Sprecher wurde das Mercosur-Abkommen 2025 final ratifiziert.', hasAttrib: true },
    { id: 12, input: 'Die EZB-Leitzinsen liegen bei 0%.', hasAttrib: false },
    { id: 13, input: 'Der Experte behauptet, dass Olaf Scholz noch Bundeskanzler ist.', hasAttrib: true },
    { id: 14, input: 'He claims that Joe Biden is the current US President.', hasAttrib: true },
    { id: 15, input: 'U.S. tariff revenue reached $18 trillion.', hasAttrib: false },
    { id: 16, input: 'Die globale Durchschnittstemperatur stieg 2024 um 1.5°C über vorindustrielles Niveau.', hasAttrib: false },
    { id: 17, input: 'Laut Impfgegnern verursachen COVID-19 Impfungen Autismus.', hasAttrib: true },
    { id: 18, input: 'Water boils at 100°C at sea level.', hasAttrib: false },
    { id: 19, input: 'Novo Nordisk Wegovy price is $199.', hasAttrib: false },
    { id: 20, input: 'Bitcoin ist aktuell über $100,000 wert.', hasAttrib: false },
    { id: 21, input: 'I think pineapple belongs on pizza.', hasAttrib: false },
    { id: 22, input: 'The Earth is flat.', hasAttrib: false },
    // Bonus: the key "Platz 185" test case from the spec
    { id: 'P', input: 'Wisst ihr, wo wir liegen? Am sensationellen Platz 185.', hasAttrib: false, note: 'Rhetoric, not standard attribution' },
    { id: 'L', input: 'Laut FPÖ TV liegt Österreich auf Platz 185.', hasAttrib: true },
];

console.log('');
console.log('┌─────┬─────────────────────────────────────────────────────┬─────────────────────────────────────────────────────┬──────────┐');
console.log('│  #  │ Input (Transcript)                                  │ Output (Stripped)                                    │ Strip ✓  │');
console.log('├─────┼─────────────────────────────────────────────────────┼─────────────────────────────────────────────────────┼──────────┤');

let passed = 0;
let total = 0;

for (const t of tests) {
    const stripped = stripAttribution(t.input);
    const wasStripped = stripped !== t.input;
    let check;
    if (t.hasAttrib) {
        total++;
        check = wasStripped ? '✅' : '❌';
        if (wasStripped) passed++;
    } else {
        check = wasStripped ? '⚠️ OVER' : '—';
    }
    const id = String(t.id).padStart(2);
    const inp = t.input.slice(0, 51).padEnd(51);
    const out = stripped.slice(0, 51).padEnd(51);
    console.log(`│ ${id}  │ ${inp} │ ${out} │   ${check}    │`);
}

console.log('└─────┴─────────────────────────────────────────────────────┴─────────────────────────────────────────────────────┴──────────┘');
console.log(`\nStripping accuracy: ${passed}/${total} attribution cases correctly stripped`);
