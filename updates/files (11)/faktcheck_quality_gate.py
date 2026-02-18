#!/usr/bin/env python3
"""
FAKTCHECK Quality Gate v1.0
============================
A deterministic, self-correcting quality assurance system for FAKTCHECK output.

PURPOSE:
  This script takes a faktcheck_chunks JSON output file and runs 20 quality
  checks across 4 categories. It produces:
  1. A per-claim audit with every violation flagged
  2. A run-level quality scorecard (0-100)
  3. Specific, actionable repair instructions for each failure
  4. A corrected output file with deterministic fixes applied

DESIGN PHILOSOPHY:
  - Zero LLM calls. Every check is deterministic.
  - Every check is independently testable.
  - The script can run in CI/CD (GitHub Actions) as a gate.
  - Failures are graded: CRITICAL (blocks release), WARNING (degrades quality), INFO (cosmetic).

USAGE:
  python3 faktcheck_quality_gate.py <input.json> [--fix] [--output corrected.json]
  
  --fix     : Apply all auto-fixable repairs and write corrected output
  --output  : Path for corrected output file (default: input_corrected.json)
  --strict  : Fail (exit 1) if any CRITICAL issues found
  --report  : Write detailed HTML report

Author: Quality Assurance Module for FAKTCHECK
"""

import json
import sys
import os
import re
import argparse
from collections import Counter, defaultdict
from difflib import SequenceMatcher
from typing import List, Dict, Tuple, Any, Optional
from dataclasses import dataclass, field, asdict
from enum import Enum

# ============================================================
# CONFIGURATION
# ============================================================

class Severity(Enum):
    CRITICAL = "CRITICAL"  # Blocks release. User-visible error.
    WARNING = "WARNING"    # Degrades quality. Should fix before release.
    INFO = "INFO"          # Cosmetic or minor. Fix when convenient.

# ============================================================
# SOURCE TIER REGISTRY — loadable from external config
# ============================================================
# 
# Default tiers are defined here as fallback. If a `sources.json` file
# exists alongside this script (or is passed via --sources), it overrides
# these defaults. This allows updating trusted domains without code changes.
#
# sources.json format:
# {
#   "tier_1": {
#     "parlament.gv.at": {"country": "AT", "type": "government", "added": "2025-01-01"},
#     "imf.org":          {"country": "INT", "type": "institution", "added": "2025-01-01"}
#   },
#   "tier_2": { ... },
#   "banned": { ... }
# }

# Built-in defaults (used when no sources.json is found)
_DEFAULT_TIER_1 = {
    # Austria government
    'parlament.gv.at', 'ris.bka.gv.at', 'bundeskanzleramt.gv.at',
    'bmf.gv.at', 'statistik.at', 'rechnungshof.gv.at', 'bundespraesident.at',
    # Austria research institutes
    'wifo.ac.at', 'ihs.ac.at', 'oenb.at',
    # International institutions
    'imf.org', 'worldbank.org', 'europa.eu', 'oecd.org', 'ecb.europa.eu',
    'destatis.de', 'bls.gov', 'eurostat.ec.europa.eu',
}

_DEFAULT_TIER_2 = {
    # Austrian quality media
    'orf.at', 'derstandard.at', 'diepresse.com', 'kurier.at',
    'kleinezeitung.at', 'salzburg24.at', 'vol.at',
    # German quality media
    'spiegel.de', 'zeit.de', 'faz.net', 'sueddeutsche.de', 'tagesschau.de',
    'deutschlandfunk.de', 'zdfheute.de',
    # International wire services
    'reuters.com', 'apnews.com', 'afp.com',
    # Austrian press agency
    'ots.at', 'apa.at',
}

_DEFAULT_BANNED = {'youtube.com', 'youtu.be', 'facebook.com', 'twitter.com',
                   'x.com', 'instagram.com', 'tiktok.com', 'reddit.com'}


def load_source_config(config_path: Optional[str] = None) -> Tuple[set, set, set]:
    """Load source tier configuration from external JSON file.
    
    Falls back to built-in defaults if no config file found.
    Returns (tier_1_domains, tier_2_domains, banned_sources).
    """
    # Search order: explicit path > sources.json next to script > defaults
    search_paths = []
    if config_path:
        search_paths.append(config_path)
    search_paths.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'sources.json'))
    
    for path in search_paths:
        if os.path.exists(path):
            try:
                with open(path) as f:
                    config = json.load(f)
                
                tier_1 = set(config.get('tier_1', {}).keys()) if isinstance(config.get('tier_1'), dict) else set(config.get('tier_1', []))
                tier_2 = set(config.get('tier_2', {}).keys()) if isinstance(config.get('tier_2'), dict) else set(config.get('tier_2', []))
                banned = set(config.get('banned', {}).keys()) if isinstance(config.get('banned'), dict) else set(config.get('banned', []))
                
                # Validate: tiers must not overlap
                overlap_12 = tier_1 & tier_2
                overlap_1b = tier_1 & banned
                if overlap_12:
                    print(f"  ⚠️  sources.json: {len(overlap_12)} domains appear in both tier_1 and tier_2", file=sys.stderr)
                if overlap_1b:
                    print(f"  ⚠️  sources.json: {len(overlap_1b)} domains appear in both tier_1 and banned", file=sys.stderr)
                
                print(f"  Loaded source config from {path}: {len(tier_1)} tier-1, {len(tier_2)} tier-2, {len(banned)} banned", file=sys.stderr)
                return tier_1, tier_2, banned
            except (json.JSONDecodeError, KeyError) as e:
                print(f"  ⚠️  Failed to parse {path}: {e}. Using defaults.", file=sys.stderr)
    
    return _DEFAULT_TIER_1.copy(), _DEFAULT_TIER_2.copy(), _DEFAULT_BANNED.copy()


# Initialize with defaults (overridden in main() if --sources provided)
TIER_1_DOMAINS, TIER_2_DOMAINS, BANNED_SOURCES = _DEFAULT_TIER_1.copy(), _DEFAULT_TIER_2.copy(), _DEFAULT_BANNED.copy()

# Known ASR error patterns (phonetically similar pairs)
ASR_ERROR_PATTERNS = {
    'bios': 'pius',
    'griechang': 'kriechgang',
    'griechgang': 'kriechgang',
    'aust firstst': 'austria first',
    'lohnstück kosten': 'lohnstückkosten',
}

# Metaphor markers that indicate non-factual language
METAPHOR_MARKERS = [
    'nebelsuppe', 'rollatormodus', 'schneckentempo', 'raketenstaat',
    'pannenstreifen', 'beiwagen', 'abschleppwagen', 'sonnenstaat',
]

# Speaker-action patterns that should have been filtered
SPEAKER_PATTERNS = [
    r'^der sprecher',
    r'^die sprecherin',
    r'hat sich .* angeschaut',
    r'war neugierig',
    r'war geschockt',
    r'war überrascht',
    r'freut sich',
    r'ist froh',
    r'kritisiert die',
    r'bezeichnet .* als',
]

# German language indicators
DE_INDICATORS = ['der', 'die', 'das', 'ist', 'und', 'ein', 'eine', 'wird',
                 'dass', 'nicht', 'auch', 'den', 'dem', 'des', 'von', 'mit',
                 'für', 'auf', 'sich', 'hat', 'als', 'nach', 'bei', 'über']

EN_INDICATORS = ['the', 'is', 'and', 'that', 'this', 'has', 'was', 'are',
                 'not', 'with', 'from', 'which', 'have', 'been', 'their',
                 'would', 'could', 'should', 'about', 'into']

VALID_VERDICTS = {'true', 'false', 'partially_true', 'opinion', 'unverifiable'}


# ============================================================
# DATA STRUCTURES
# ============================================================

@dataclass
class Violation:
    check_id: str
    severity: Severity
    claim_index: int  # -1 for run-level
    chunk_index: int  # -1 for run-level
    message: str
    auto_fixable: bool = False
    fix_description: str = ""
    
@dataclass
class ClaimAudit:
    chunk_index: int
    claim_index: int
    original_claim: str
    verdict: str
    confidence: float
    violations: List[Violation] = field(default_factory=list)
    score: float = 100.0  # starts perfect, deductions applied
    
@dataclass
class RunReport:
    input_file: str
    total_chunks: int
    total_claims: int
    claim_audits: List[ClaimAudit] = field(default_factory=list)
    run_violations: List[Violation] = field(default_factory=list)
    category_scores: Dict[str, float] = field(default_factory=dict)
    overall_score: float = 0.0
    grade: str = ""


# ============================================================
# DETECTION FUNCTIONS
# ============================================================

def detect_language(text: str) -> str:
    """Detect whether text is primarily German or English."""
    words = text.lower().split()
    de_count = sum(1 for w in words if w in DE_INDICATORS)
    en_count = sum(1 for w in words if w in EN_INDICATORS)
    return 'de' if de_count > en_count else 'en'

def detect_transcript_language(chunks: List[dict]) -> str:
    """Detect the primary language of the video transcript."""
    all_text = ' '.join(c.get('fullText', '') for c in chunks[:5])
    return detect_language(all_text)

def text_similarity(a: str, b: str) -> float:
    """Return 0-1 similarity between two strings."""
    return SequenceMatcher(None, a.lower(), b.lower()).ratio()

def has_named_entity(text: str) -> bool:
    """Check if text contains at least one named entity (capitalized word, number, date)."""
    # Numbers
    if re.search(r'\d+', text):
        return True
    # Capitalized words analysis
    words = text.split()
    # Common German sentence starters that are NOT named entities
    non_entity_starters = {
        'Der', 'Die', 'Das', 'Ein', 'Eine', 'Es', 'Er', 'Sie', 'Wir',
        'Ich', 'Man', 'Wenn', 'Dass', 'Ob', 'Wie', 'Was', 'Wer',
        'Alle', 'Viele', 'Einige', 'Jeder', 'Dieser', 'Jene',
        'Im', 'Am', 'Zum', 'Zur', 'Vom', 'Beim', 'Seit', 'Durch',
        'The', 'A', 'An', 'It', 'He', 'She', 'We', 'They', 'This', 'That',
    }
    for i, w in enumerate(words):
        # Strip trailing punctuation for analysis
        clean_w = w.rstrip('.,;:!?()[]"\'')
        if not clean_w:
            continue
        if clean_w[0].isupper() and len(clean_w) > 2:
            if i == 0:
                # First word: only count if it's NOT a common sentence starter
                if clean_w not in non_entity_starters:
                    return True
            else:
                # Later words: capitalized = named entity in German/English
                if clean_w not in ('Der', 'Die', 'Das', 'Ein', 'Eine'):
                    return True
    return False

def get_source_tier(domain: str) -> int:
    """Return tier for a domain. 1=institutional, 2=quality media, 3=other, 4=banned."""
    if domain in BANNED_SOURCES:
        return 4
    if domain in TIER_1_DOMAINS:
        return 1
    if domain in TIER_2_DOMAINS:
        return 2
    return 3

def check_asr_name_mismatch(claim_text: str, explanation: str) -> Optional[Tuple[str, str]]:
    """Detect if explanation corrected an ASR name error that claim still contains.
    
    Refined to minimize false positives:
    - Known ASR patterns always flagged (BIOS/Pius, Griechang/Kriechgang)
    - Unknown patterns require: different initial consonant, similar length,
      NOT a compound substring, NOT a morphological variant, phonetic sim > 0.65
    """
    claim_lower = claim_text.lower()
    
    # Known ASR patterns - always flag
    for wrong, right in ASR_ERROR_PATTERNS.items():
        if wrong in claim_lower:
            return (wrong, right)
    
    # Heuristic for unknown ASR errors - strict criteria
    claim_caps = set(re.findall(r'\b[A-ZÄÖÜ][a-zäöüß]{3,}\b', claim_text))
    exp_caps = set(re.findall(r'\b[A-ZÄÖÜ][a-zäöüß]{3,}\b', explanation))
    
    only_in_claim = claim_caps - exp_caps
    only_in_exp = exp_caps - claim_caps
    
    for oc in only_in_claim:
        for oe in only_in_exp:
            # Skip compound noun / substring relationships
            if oc.lower() in oe.lower() or oe.lower() in oc.lower():
                continue
            # Skip morphological variants (German suffixes)
            oc_stem = oc.lower().rstrip('snemen')
            oe_stem = oe.lower().rstrip('snemen')
            if oc_stem == oe_stem and len(oc_stem) > 3:
                continue
            # Must have different initial consonant (classic ASR swap)
            if oc[0].lower() == oe[0].lower():
                continue
            # Must have similar length
            if abs(len(oc) - len(oe)) > 3:
                continue
            # Must be phonetically similar
            if text_similarity(oc, oe) > 0.65:
                return (oc, oe)
    
    return None

def check_explanation_verdict_alignment(explanation: str, verdict: str) -> bool:
    """Check if explanation text contradicts the verdict."""
    exp_lower = explanation.lower()
    
    positive_signals = ['confirmed', 'supported', 'bestätigt', 'belegt', 'korrekt',
                       'is true', 'is correct', 'stimmt', 'trifft zu']
    negative_signals = ['contradicted', 'false', 'falsch', 'widerlegt', 'not supported',
                       'nicht bestätigt', 'incorrect', 'not true']
    
    has_positive = any(s in exp_lower for s in positive_signals)
    has_negative = any(s in exp_lower for s in negative_signals)
    
    if verdict == 'true' and has_negative and not has_positive:
        return False
    if verdict == 'false' and has_positive and not has_negative:
        return False
    return True

def check_irrelevant_search(claim_text: str, explanation: str) -> bool:
    """Detect if explanation discusses entities completely absent from the claim."""
    # Extract proper nouns from explanation that aren't in the claim
    exp_entities = set(re.findall(r'\b[A-ZÄÖÜ][a-zäöüß]{3,}\b', explanation))
    claim_entities = set(re.findall(r'\b[A-ZÄÖÜ][a-zäöüß]{3,}\b', claim_text))
    
    foreign_entities = exp_entities - claim_entities
    # Remove common German words that happen to be capitalized
    common_words = {'Der', 'Die', 'Das', 'Ein', 'Eine', 'Und', 'Oder', 'Aber',
                   'The', 'This', 'That', 'However', 'While', 'According',
                   'Also', 'Based', 'Evidence', 'Claim', 'Sources'}
    foreign_entities -= common_words
    
    # If more than 3 unique foreign entities, likely irrelevant search
    return len(foreign_entities) > 3


# ============================================================
# THE 20 QUALITY CHECKS
# ============================================================

def run_structural_checks(claim: dict, ci: int, chi: int) -> List[Violation]:
    """S1-S5: Structural integrity of the data."""
    violations = []
    v = claim.get('verification', {})
    
    # S1: Explanation present and meaningful
    exp = str(v.get('explanation', '') or '')
    if len(exp) < 10:
        violations.append(Violation(
            'S1_explanation_present', Severity.CRITICAL, ci, chi,
            f'Explanation missing or too short ({len(exp)} chars)',
            auto_fixable=False,
            fix_description='Verification pipeline must produce explanation for every claim'
        ))
    
    # S2: Sources should be structured objects, not bare strings
    sources = v.get('sources', [])
    if sources and isinstance(sources[0], str):
        violations.append(Violation(
            'S2_sources_typed', Severity.WARNING, ci, chi,
            f'Sources are bare strings, not structured objects. Found {len(sources)} string sources.',
            auto_fixable=True,
            fix_description='Convert source strings to {{domain, tier}} objects'
        ))
    
    # S3: Confidence range sanity
    conf = v.get('confidence', -1)
    if conf < 0 or conf > 1:
        violations.append(Violation(
            'S3_confidence_range', Severity.CRITICAL, ci, chi,
            f'Confidence {conf} outside valid range [0,1]'
        ))
    if conf == 0.5:
        violations.append(Violation(
            'S3_confidence_range', Severity.WARNING, ci, chi,
            f'Confidence is exactly 0.5 — likely hardcoded default, not calculated',
            auto_fixable=False,
            fix_description='Apply deterministic confidence formula'
        ))
    if conf == 0.28:
        violations.append(Violation(
            'S3_confidence_range', Severity.WARNING, ci, chi,
            f'Confidence is 0.28 — known fallback value from legacy code',
            auto_fixable=False,
            fix_description='Apply deterministic confidence formula'
        ))
    
    # S4: cleanedClaim should exist
    orig = claim.get('originalClaim', claim.get('claim', ''))
    cleaned = claim.get('cleanedClaim', '')
    if orig and not cleaned:
        violations.append(Violation(
            'S4_cleaned_claim_present', Severity.WARNING, ci, chi,
            'cleanedClaim is empty — no ASR/grammar correction applied',
            auto_fixable=False,
            fix_description='Extraction stage must populate cleanedClaim'
        ))
    
    # S5: Valid verdict
    verdict = v.get('verdict', '')
    if verdict not in VALID_VERDICTS:
        violations.append(Violation(
            'S5_verdict_valid', Severity.CRITICAL, ci, chi,
            f'Invalid verdict: "{verdict}". Must be one of: {VALID_VERDICTS}'
        ))
    
    # S6: Source domain monoculture / API endpoint leak
    # If all sources for a claim resolve to the same domain, the pipeline
    # is likely storing the API wrapper URL instead of the actual source URLs.
    # Known offenders: vertexaisearch.cloud.google.com, googleapis.com
    API_ENDPOINT_DOMAINS = {
        'vertexaisearch.cloud.google.com',
        'generativelanguage.googleapis.com',
        'aiplatform.googleapis.com',
    }
    if sources:
        domains = [s if isinstance(s, str) else s.get('domain', '') for s in sources]
        unique_domains = set(domains)
        
        # Check for API endpoint leak
        api_leak = unique_domains & API_ENDPOINT_DOMAINS
        if api_leak:
            violations.append(Violation(
                'S6_source_api_leak', Severity.CRITICAL, ci, chi,
                f'Sources contain API endpoint domain instead of actual source URLs: {api_leak}. '
                f'All {len(sources)} sources resolve to the same API wrapper. '
                f'Parse groundingMetadata.groundingChunks[].web.uri from the Gemini response.',
                auto_fixable=False,
                fix_description='Extract actual source URLs from Gemini groundingMetadata.groundingChunks[].web.uri '
                              'instead of storing the Vertex AI Search wrapper domain'
            ))
        # Also flag if ALL sources share one domain (even non-API) — suspicious
        elif len(unique_domains) == 1 and len(sources) >= 3:
            domain = list(unique_domains)[0]
            violations.append(Violation(
                'S6_source_monoculture', Severity.WARNING, ci, chi,
                f'All {len(sources)} sources are from a single domain: "{domain}". '
                f'Real fact-checks should cite multiple independent sources.',
                auto_fixable=False,
                fix_description='Verify source URL extraction is returning actual website domains'
            ))
    
    return violations

def run_semantic_checks(claim: dict, ci: int, chi: int, transcript_lang: str) -> List[Violation]:
    """M1-M5: Semantic quality of verification results."""
    violations = []
    v = claim.get('verification', {})
    sources = v.get('sources', [])
    exp = str(v.get('explanation', '') or '')
    orig = claim.get('originalClaim', claim.get('claim', ''))
    
    # M1: YouTube as evidence
    for s in sources:
        domain = s if isinstance(s, str) else s.get('domain', '')
        if domain in BANNED_SOURCES:
            violations.append(Violation(
                'M1_youtube_as_evidence', Severity.CRITICAL, ci, chi,
                f'Banned source "{domain}" used as evidence. This is circular when analyzing YouTube videos.',
                auto_fixable=True,
                fix_description=f'Remove "{domain}" from sources array'
            ))
            break  # One violation per claim is enough
    
    # M2: ASR name mismatch
    mismatch = check_asr_name_mismatch(orig, exp)
    if mismatch:
        violations.append(Violation(
            'M2_asr_name_mismatch', Severity.CRITICAL, ci, chi,
            f'ASR error detected: claim says "{mismatch[0]}" but verification found "{mismatch[1]}"',
            auto_fixable=True,
            fix_description=f'Replace "{mismatch[0]}" with "{mismatch[1]}" in claim display text'
        ))
    
    # M3: Explanation language mismatch
    if len(exp) > 30:
        exp_lang = detect_language(exp)
        if transcript_lang == 'de' and exp_lang == 'en':
            violations.append(Violation(
                'M3_explanation_language', Severity.WARNING, ci, chi,
                f'Explanation is in English but transcript is German',
                auto_fixable=False,
                fix_description='Add language instruction to judgeEvidence prompt: "Antworte auf Deutsch"'
            ))
    
    # M4: Irrelevant search results
    if check_irrelevant_search(orig, exp):
        violations.append(Violation(
            'M4_irrelevant_search', Severity.WARNING, ci, chi,
            'Explanation contains multiple entities not present in the claim — likely polluted search results',
            auto_fixable=False,
            fix_description='Improve search query construction to use claim keywords only'
        ))
    
    # M5: Circular reference (same platform as source)
    for s in sources:
        domain = s if isinstance(s, str) else s.get('domain', '')
        if domain in BANNED_SOURCES:
            violations.append(Violation(
                'M5_circular_reference', Severity.CRITICAL, ci, chi,
                f'Circular reference: analyzing YouTube content but citing "{domain}" as evidence',
                auto_fixable=True,
                fix_description=f'Filter "{domain}" from source pipeline'
            ))
            break
    
    return violations

def run_consistency_checks(claims_data: List[dict]) -> List[Violation]:
    """C1-C5: Cross-claim consistency checks (run-level)."""
    violations = []
    
    # Build index of all claims
    all_claims = []
    for chi, chunk in enumerate(claims_data):
        for ci, claim in enumerate(chunk.get('claims', [])):
            all_claims.append((chi, ci, claim))
    
    # C1: Duplicate claims (number-aware)
    # For short claims (<50 chars), text similarity alone is dangerous:
    # "Inflation is 5%" vs "Inflation is 50%" score ~0.93 but are opposite facts.
    # Fix: extract all numbers and require exact numeric match for short strings.
    seen_texts = {}
    for chi, ci, claim in all_claims:
        text = claim.get('originalClaim', claim.get('claim', ''))[:80]
        for seen_text, (seen_chi, seen_ci) in seen_texts.items():
            sim = text_similarity(text, seen_text)
            
            # Adaptive threshold based on string length
            if len(text) < 50:
                # Short strings: require higher similarity AND matching numbers
                threshold = 0.95
                text_numbers = sorted(re.findall(r'\d+(?:[.,]\d+)?', text))
                seen_numbers = sorted(re.findall(r'\d+(?:[.,]\d+)?', seen_text))
                numbers_match = text_numbers == seen_numbers
                is_duplicate = sim > threshold and (numbers_match or (not text_numbers and not seen_numbers))
            else:
                # Longer strings: standard threshold, but still verify numbers if present
                threshold = 0.85
                text_numbers = sorted(re.findall(r'\d+(?:[.,]\d+)?', text))
                seen_numbers = sorted(re.findall(r'\d+(?:[.,]\d+)?', seen_text))
                if text_numbers and seen_numbers and text_numbers != seen_numbers:
                    # High similarity but different numbers — NOT a duplicate
                    is_duplicate = False
                else:
                    is_duplicate = sim > threshold
            
            if is_duplicate:
                violations.append(Violation(
                    'C1_duplicate_claims', Severity.WARNING, ci, chi,
                    f'Duplicate of claim in chunk {seen_chi} (sim={sim:.2f}): "{text[:60]}..."',
                    auto_fixable=True,
                    fix_description='Merge into single claim with multiple timestamps'
                ))
                break
        else:
            seen_texts[text] = (chi, ci)
    
    # C2: Contradictory verdicts
    claim_verdicts = defaultdict(list)
    for chi, ci, claim in all_claims:
        text = claim.get('originalClaim', claim.get('claim', ''))[:60].lower()
        v = claim.get('verification', {}).get('verdict', '?')
        claim_verdicts[text].append((v, chi, ci))
    
    for text, entries in claim_verdicts.items():
        verdicts = set(e[0] for e in entries)
        if len(verdicts) > 1 and not ({'opinion', 'unverifiable'} >= verdicts):
            violations.append(Violation(
                'C2_contradictory_verdicts', Severity.CRITICAL, -1, -1,
                f'CONTRADICTORY: "{text}..." got verdicts: {[e[0] for e in entries]}',
                auto_fixable=False,
                fix_description='Deduplicate before verification, or flag as "disputed" when verdicts conflict'
            ))
    
    # C3: Confidence coherence
    for chi, ci, claim in all_claims:
        v = claim.get('verification', {})
        verdict = v.get('verdict', '')
        conf = v.get('confidence', 0)
        
        if verdict in ('true', 'false') and conf < 0.3:
            violations.append(Violation(
                'C3_confidence_coherence', Severity.WARNING, ci, chi,
                f'{verdict.upper()} with confidence {conf} — verdict is definitive but confidence says uncertain',
                auto_fixable=False,
                fix_description='Recalibrate confidence formula: definitive verdicts with tier-1 sources should score 0.5+'
            ))
        if verdict == 'unverifiable' and conf > 0.5:
            violations.append(Violation(
                'C3_confidence_coherence', Severity.WARNING, ci, chi,
                f'UNVERIFIABLE with confidence {conf} — if you are this confident, assign a verdict',
                auto_fixable=False,
                fix_description='High-confidence unverifiable suggests the judge is uncertain about category, not evidence'
            ))
    
    # C4: Source-verdict alignment
    for chi, ci, claim in all_claims:
        v = claim.get('verification', {})
        verdict = v.get('verdict', '')
        sources = v.get('sources', [])
        
        if verdict == 'unverifiable' and sources:
            tier1_present = any(
                (s if isinstance(s, str) else s.get('domain', '')) in TIER_1_DOMAINS 
                for s in sources
            )
            if tier1_present:
                violations.append(Violation(
                    'C4_source_verdict_alignment', Severity.CRITICAL, ci, chi,
                    f'Verdict is UNVERIFIABLE but Tier-1 sources are present: {[s for s in sources if (s if isinstance(s, str) else s.get("domain","")) in TIER_1_DOMAINS][:3]}',
                    auto_fixable=False,
                    fix_description='If authoritative sources found evidence, the claim IS verifiable. Re-judge.'
                ))
    
    # C5: Explanation-verdict alignment
    for chi, ci, claim in all_claims:
        v = claim.get('verification', {})
        verdict = v.get('verdict', '')
        exp = str(v.get('explanation', '') or '')
        
        if not check_explanation_verdict_alignment(exp, verdict):
            violations.append(Violation(
                'C5_explanation_verdict_alignment', Severity.CRITICAL, ci, chi,
                f'Explanation language contradicts verdict "{verdict}"',
                auto_fixable=False,
                fix_description='Judge produced incoherent result — retry verification for this claim'
            ))
    
    return violations

def run_extraction_checks(claims_data: List[dict]) -> List[Violation]:
    """E1-E5: Extraction quality checks."""
    violations = []
    
    for chi, chunk in enumerate(claims_data):
        chunk_claims = chunk.get('claims', [])
        
        for ci, claim in enumerate(chunk_claims):
            orig = claim.get('originalClaim', claim.get('claim', '')).lower()
            
            # E1: Speaker action leak
            for pattern in SPEAKER_PATTERNS:
                if re.search(pattern, orig):
                    violations.append(Violation(
                        'E1_speaker_action_leak', Severity.WARNING, ci, chi,
                        f'Speaker action/emotion leaked through filter: "{orig[:80]}"',
                        auto_fixable=True,
                        fix_description='Add to extraction SKIP list: speaker actions, emotions, personal anecdotes'
                    ))
                    break
            
            # E2: Metaphor leak (metaphor as the factual core)
            # IMPORTANT: This check is INFO-only, never CRITICAL or WARNING.
            # Reason: Deterministic pattern matching cannot reliably distinguish
            # metaphorical usage ("Austria is on the breakdown lane") from literal
            # usage ("traffic on the breakdown lane"). False positives would block
            # valid claims. This flag exists for human review, not automated blocking.
            for marker in METAPHOR_MARKERS:
                if marker in orig:
                    # Check if there's a factual kernel alongside the metaphor
                    has_number = bool(re.search(r'\d', orig))
                    has_named_ent = has_named_entity(claim.get('originalClaim', claim.get('claim', '')))
                    
                    if has_number or has_named_ent:
                        # Metaphor wraps a factual claim — this is acceptable,
                        # but note it for the UI to potentially show the factual kernel
                        pass  # No violation — factual kernel detected
                    else:
                        violations.append(Violation(
                            'E2_metaphor_leak', Severity.INFO, ci, chi,
                            f'Metaphor "{marker}" is the core of this claim, no factual kernel found. '
                            f'Review manually — may be valid if used literally in context.',
                            auto_fixable=False,
                            fix_description='Extract the underlying factual claim, not the metaphorical framing. '
                                          'If literal usage is intended, this flag can be ignored.'
                        ))
                    break
            
            # E4: Uncheckable claim
            if not has_named_entity(claim.get('originalClaim', claim.get('claim', ''))):
                violations.append(Violation(
                    'E4_uncheckable_claim', Severity.WARNING, ci, chi,
                    f'No named entity, number, or date found — claim may be uncheckable: "{orig[:80]}"',
                    auto_fixable=False,
                    fix_description='Apply checkability pre-filter: require NE+1, Number+1, Date+1 minimum'
                ))
            
            # E5: Future tense leak
            future_patterns = [r'\bwird\b.*\bwerden\b', r'\bwill\b', r'\bnächstes jahr\b',
                             r'\bin zukunft\b', r'\bwird eine\b.*\bbilden\b']
            for fp in future_patterns:
                if re.search(fp, orig):
                    v = claim.get('verification', {}).get('verdict', '')
                    if v not in ('opinion', 'unverifiable'):
                        violations.append(Violation(
                            'E5_future_tense_leak', Severity.INFO, ci, chi,
                            f'Future-tense claim assigned definitive verdict "{v}": "{orig[:80]}"',
                            auto_fixable=False,
                            fix_description='Future claims should be SKIP or tagged as prediction'
                        ))
                    break
        
        # E3: Atomization check (per-chunk)
        if len(chunk_claims) >= 3:
            texts = [c.get('originalClaim', c.get('claim', ''))[:60] for c in chunk_claims]
            for i in range(len(texts)):
                similar_count = sum(1 for j in range(len(texts)) if i != j and text_similarity(texts[i], texts[j]) > 0.6)
                if similar_count >= 2:
                    violations.append(Violation(
                        'E3_atomization', Severity.WARNING, i, chi,
                        f'Rhetorical list atomized into {similar_count+1} similar claims in chunk {chi}',
                        auto_fixable=False,
                        fix_description='Extract one unified claim from rhetorical lists, not one per item'
                    ))
                    break  # One flag per chunk
    
    return violations


# ============================================================
# AUTO-FIX ENGINE
# ============================================================

def apply_fixes(data: List[dict], violations: List[Violation]) -> Tuple[List[dict], int]:
    """Apply all auto-fixable repairs. Returns (fixed_data, fix_count)."""
    import copy
    fixed = copy.deepcopy(data)
    fix_count = 0
    
    # Index violations by type for batch processing
    by_type = defaultdict(list)
    for v in violations:
        if v.auto_fixable:
            by_type[v.check_id].append(v)
    
    # Fix M1/M5: Remove banned sources
    if 'M1_youtube_as_evidence' in by_type or 'M5_circular_reference' in by_type:
        for chunk in fixed:
            for claim in chunk.get('claims', []):
                sources = claim.get('verification', {}).get('sources', [])
                original_len = len(sources)
                claim['verification']['sources'] = [
                    s for s in sources 
                    if (s if isinstance(s, str) else s.get('domain', '')) not in BANNED_SOURCES
                ]
                if len(claim['verification']['sources']) < original_len:
                    fix_count += 1
    
    # Fix M2: ASR name corrections
    for v in by_type.get('M2_asr_name_mismatch', []):
        # Extract the wrong/right pair from the message
        match = re.search(r'claim says "(.+?)" but verification found "(.+?)"', v.message)
        if match:
            wrong, right = match.groups()
            for chunk in fixed:
                for claim in chunk.get('claims', []):
                    orig = claim.get('originalClaim', claim.get('claim', ''))
                    if wrong.lower() in orig.lower():
                        # Apply case-insensitive replacement
                        pattern = re.compile(re.escape(wrong), re.IGNORECASE)
                        claim['cleanedClaim'] = pattern.sub(right.title(), orig)
                        fix_count += 1
    
    # Fix S2: Convert string sources to structured objects
    if 'S2_sources_typed' in by_type:
        for chunk in fixed:
            for claim in chunk.get('claims', []):
                sources = claim.get('verification', {}).get('sources', [])
                if sources and isinstance(sources[0], str):
                    claim['verification']['sources'] = [
                        {'domain': s, 'tier': get_source_tier(s)} 
                        for s in sources
                    ]
                    fix_count += 1
    
    # Fix C1: Mark duplicates
    seen = {}
    for chi, chunk in enumerate(fixed):
        to_remove = []
        for ci, claim in enumerate(chunk.get('claims', [])):
            text = claim.get('originalClaim', claim.get('claim', ''))[:80]
            is_dupe = False
            for seen_text in seen:
                if text_similarity(text, seen_text) > 0.85:
                    is_dupe = True
                    # Add timestamp to the original
                    vtime = chunk.get('videoTime', '')
                    seen[seen_text]['timestamps'] = seen[seen_text].get('timestamps', [])
                    seen[seen_text]['timestamps'].append(vtime)
                    to_remove.append(ci)
                    fix_count += 1
                    break
            if not is_dupe:
                seen[text] = claim
                claim['timestamps'] = [chunk.get('videoTime', '')]
        
        # Remove duplicates (reverse order to preserve indices)
        for ci in reversed(to_remove):
            chunk['claims'].pop(ci)
    
    return fixed, fix_count


# ============================================================
# SCORING ENGINE
# ============================================================

SEVERITY_WEIGHTS = {
    Severity.CRITICAL: 10,
    Severity.WARNING: 3,
    Severity.INFO: 1,
}

CATEGORY_WEIGHTS = {
    'structural': 0.20,
    'semantic': 0.25,
    'consistency': 0.30,
    'extraction': 0.25,
}

def calculate_scores(total_claims: int, violations: List[Violation]) -> Tuple[Dict[str, float], float, str]:
    """Calculate category scores and overall score.
    
    Scoring philosophy:
    - Systemic issues (same check_id) are counted ONCE, not per-claim
      (e.g., 44 language violations = 1 systemic issue, not 44 penalties)
    - CRITICAL: 15 points deducted per unique issue
    - WARNING:  5 points deducted per unique issue  
    - INFO:     1 point deducted per unique issue
    - Auto-fixable violations are penalized at 50% (they can be repaired)
    """
    if total_claims == 0:
        return {}, 0.0, "F"
    
    category_map = {
        'S': 'structural', 'M': 'semantic', 'C': 'consistency', 'E': 'extraction'
    }
    
    # Group by check_id to count systemic issues once
    by_check = defaultdict(list)
    for v in violations:
        by_check[v.check_id].append(v)
    
    category_penalties = defaultdict(float)
    for check_id, items in by_check.items():
        cat = category_map.get(check_id[0], 'other')
        severity = items[0].severity
        fixable = items[0].auto_fixable
        
        # Base penalty per unique issue type
        base = {Severity.CRITICAL: 15, Severity.WARNING: 5, Severity.INFO: 1}[severity]
        
        # Scale slightly by prevalence (but cap at 2x)
        prevalence = min(2.0, 1.0 + len(items) / total_claims)
        
        # Reduce penalty if auto-fixable
        fix_discount = 0.5 if fixable else 1.0
        
        penalty = base * prevalence * fix_discount
        category_penalties[cat] += penalty
    
    category_scores = {}
    for cat in CATEGORY_WEIGHTS:
        raw = max(0, 100 - category_penalties.get(cat, 0))
        category_scores[cat] = round(raw, 1)
    
    overall = sum(
        category_scores.get(cat, 100) * weight 
        for cat, weight in CATEGORY_WEIGHTS.items()
    )
    overall = round(max(0, min(100, overall)), 1)
    
    if overall >= 90: grade = "A"
    elif overall >= 80: grade = "B"
    elif overall >= 70: grade = "C"
    elif overall >= 60: grade = "D"
    else: grade = "F"
    
    return category_scores, overall, grade


# ============================================================
# REPORT GENERATOR
# ============================================================

def generate_report(report: RunReport) -> str:
    """Generate human-readable quality report."""
    lines = []
    lines.append("=" * 70)
    lines.append(f"  FAKTCHECK QUALITY GATE REPORT")
    lines.append(f"  Input: {report.input_file}")
    lines.append(f"  Claims: {report.total_claims} across {report.total_chunks} chunks")
    lines.append("=" * 70)
    lines.append("")
    
    # Overall score
    lines.append(f"  OVERALL SCORE: {report.overall_score}/100  [{report.grade}]")
    lines.append("")
    
    # Category breakdown
    lines.append("  CATEGORY SCORES:")
    for cat, score in sorted(report.category_scores.items()):
        bar_len = int(score / 5)
        bar = "█" * bar_len + "░" * (20 - bar_len)
        lines.append(f"    {cat:15s}: {score:5.1f}/100  {bar}")
    lines.append("")
    
    # Violation summary
    by_severity = defaultdict(list)
    all_violations = report.run_violations
    for ca in report.claim_audits:
        all_violations.extend(ca.violations)
    
    for v in all_violations:
        by_severity[v.severity].append(v)
    
    lines.append(f"  VIOLATIONS: {len(all_violations)} total")
    for sev in [Severity.CRITICAL, Severity.WARNING, Severity.INFO]:
        count = len(by_severity.get(sev, []))
        if count > 0:
            emoji = {"CRITICAL": "🔴", "WARNING": "🟡", "INFO": "🔵"}[sev.value]
            lines.append(f"    {emoji} {sev.value}: {count}")
    lines.append("")
    
    # Violation details grouped by check
    by_check = defaultdict(list)
    for v in all_violations:
        by_check[v.check_id].append(v)
    
    lines.append("-" * 70)
    lines.append("  DETAILED FINDINGS")
    lines.append("-" * 70)
    
    for check_id in sorted(by_check.keys()):
        items = by_check[check_id]
        sev = items[0].severity.value
        emoji = {"CRITICAL": "🔴", "WARNING": "🟡", "INFO": "🔵"}[sev]
        fixable = " [AUTO-FIXABLE]" if items[0].auto_fixable else ""
        lines.append(f"\n  {emoji} {check_id} ({len(items)} occurrences){fixable}")
        lines.append(f"     Fix: {items[0].fix_description}")
        
        # Show up to 3 examples
        for item in items[:3]:
            loc = f"chunk {item.chunk_index}" if item.chunk_index >= 0 else "run-level"
            lines.append(f"     • [{loc}] {item.message[:100]}")
        if len(items) > 3:
            lines.append(f"     ... and {len(items)-3} more")
    
    # Auto-fix summary
    fixable_count = sum(1 for v in all_violations if v.auto_fixable)
    if fixable_count > 0:
        lines.append("")
        lines.append("-" * 70)
        lines.append(f"  AUTO-FIXABLE: {fixable_count}/{len(all_violations)} violations can be automatically repaired")
        lines.append(f"  Run with --fix to apply corrections")
        lines.append("-" * 70)
    
    # Production readiness
    lines.append("")
    lines.append("=" * 70)
    critical_count = len(by_severity.get(Severity.CRITICAL, []))
    if critical_count == 0 and report.overall_score >= 85:
        lines.append("  ✅ PRODUCTION READY")
    elif critical_count == 0:
        lines.append("  🟡 ACCEPTABLE — no critical issues but quality below target")
    else:
        lines.append(f"  🔴 NOT PRODUCTION READY — {critical_count} critical issues must be resolved")
    lines.append("=" * 70)
    
    return "\n".join(lines)


# ============================================================
# MAIN PIPELINE
# ============================================================

def run_quality_gate(input_file: str, fix: bool = False, output_file: str = None, strict: bool = False) -> RunReport:
    """Run the complete quality gate on a faktcheck output file."""
    
    with open(input_file) as f:
        data = json.load(f)
    
    # Detect transcript language
    transcript_lang = detect_transcript_language(data)
    
    report = RunReport(
        input_file=os.path.basename(input_file),
        total_chunks=len(data),
        total_claims=sum(len(c.get('claims', [])) for c in data)
    )
    
    # Per-claim checks (Structural + Semantic)
    for chi, chunk in enumerate(data):
        for ci, claim in enumerate(chunk.get('claims', [])):
            audit = ClaimAudit(
                chunk_index=chi,
                claim_index=ci,
                original_claim=claim.get('originalClaim', claim.get('claim', ''))[:100],
                verdict=claim.get('verification', {}).get('verdict', ''),
                confidence=claim.get('verification', {}).get('confidence', 0),
            )
            
            audit.violations.extend(run_structural_checks(claim, ci, chi))
            audit.violations.extend(run_semantic_checks(claim, ci, chi, transcript_lang))
            
            report.claim_audits.append(audit)
    
    # Run-level checks (Consistency + Extraction)
    report.run_violations.extend(run_consistency_checks(data))
    report.run_violations.extend(run_extraction_checks(data))
    
    # Collect all violations
    all_violations = list(report.run_violations)
    for ca in report.claim_audits:
        all_violations.extend(ca.violations)
    
    # Calculate scores
    report.category_scores, report.overall_score, report.grade = calculate_scores(
        report.total_claims, all_violations
    )
    
    # Apply fixes if requested
    if fix:
        fixed_data, fix_count = apply_fixes(data, all_violations)
        out_path = output_file or input_file.replace('.json', '_corrected.json')
        with open(out_path, 'w') as f:
            json.dump(fixed_data, f, indent=2, ensure_ascii=False)
        print(f"\n  Applied {fix_count} auto-fixes → {out_path}")
    
    return report


# ============================================================
# CLI
# ============================================================

def main():
    parser = argparse.ArgumentParser(description='FAKTCHECK Quality Gate')
    parser.add_argument('input', help='Path to faktcheck_chunks JSON file')
    parser.add_argument('--fix', action='store_true', help='Apply auto-fixes')
    parser.add_argument('--output', help='Output path for corrected file')
    parser.add_argument('--strict', action='store_true', help='Exit 1 on critical issues')
    parser.add_argument('--json', action='store_true', help='Output report as JSON')
    parser.add_argument('--sources', help='Path to sources.json config file (overrides built-in tiers)')
    
    args = parser.parse_args()
    
    if not os.path.exists(args.input):
        print(f"Error: File not found: {args.input}")
        sys.exit(1)
    
    # Load source tier config (external file or defaults)
    global TIER_1_DOMAINS, TIER_2_DOMAINS, BANNED_SOURCES
    TIER_1_DOMAINS, TIER_2_DOMAINS, BANNED_SOURCES = load_source_config(args.sources)
    
    report = run_quality_gate(args.input, fix=args.fix, output_file=args.output, strict=args.strict)
    
    if args.json:
        # JSON output for CI/CD
        output = {
            'score': report.overall_score,
            'grade': report.grade,
            'categories': report.category_scores,
            'total_claims': report.total_claims,
            'violations': {
                'critical': sum(1 for ca in report.claim_audits for v in ca.violations if v.severity == Severity.CRITICAL) + 
                           sum(1 for v in report.run_violations if v.severity == Severity.CRITICAL),
                'warning': sum(1 for ca in report.claim_audits for v in ca.violations if v.severity == Severity.WARNING) +
                          sum(1 for v in report.run_violations if v.severity == Severity.WARNING),
                'info': sum(1 for ca in report.claim_audits for v in ca.violations if v.severity == Severity.INFO) +
                       sum(1 for v in report.run_violations if v.severity == Severity.INFO),
            },
            'production_ready': report.overall_score >= 85 and sum(1 for ca in report.claim_audits for v in ca.violations if v.severity == Severity.CRITICAL) + sum(1 for v in report.run_violations if v.severity == Severity.CRITICAL) == 0,
        }
        print(json.dumps(output, indent=2))
    else:
        print(generate_report(report))
    
    if args.strict:
        critical = sum(1 for ca in report.claim_audits for v in ca.violations if v.severity == Severity.CRITICAL) + \
                   sum(1 for v in report.run_violations if v.severity == Severity.CRITICAL)
        sys.exit(1 if critical > 0 else 0)


if __name__ == '__main__':
    main()
