"""Transcript segmentation for text-to-speech.

Pipeline: normalize whitespace -> paragraphs -> sentences -> split over-long sentences at word
boundaries -> group into chunks of one or two sentences that respect a character limit.

The sentence splitter is rule-based and tuned for Uzbek prose in Latin or Cyrillic script. It
keeps abbreviations and single-letter initials intact, does not break before lowercase
continuations (e.g. "3. yil"), leaves decimals and URLs alone, and treats blank lines as hard
boundaries.
"""

from __future__ import annotations

import re

ABBREVIATIONS: frozenset[str] = frozenset(
    {
        # English titles and units (transcripts often mix languages)
        "dr",
        "mr",
        "mrs",
        "ms",
        "prof",
        "st",
        "jr",
        "sr",
        "vs",
        "etc",
        "no",
        "fig",
        # Uzbek titles and units
        "akad",
        "dots",
        "fil",
        "kand",
        "mln",
        "mlrd",
        "km",
        "kg",
        "sm",
    }
)

# A sentence terminator, optional closing quotes or brackets, then whitespace before the next token.
_TERMINATOR = re.compile(r"(?P<term>[.!?\u2026]+)(?P<close>[\"'\u2019\u201d\u00bb)\]]*)(?P<space>\s+)(?=\S)")
_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_PARAGRAPH_BREAK = re.compile(r"\n\s*\n+")
_HORIZONTAL_SPACE = re.compile(r"[ \t]+")
_CYRILLIC = re.compile(r"[\u0400-\u04ff]")


def has_cyrillic(text: str) -> bool:
    """Return True when the text contains Cyrillic letters."""
    return _CYRILLIC.search(text) is not None


def normalize_text(text: str) -> str:
    """Normalize line endings, invisible characters and horizontal whitespace."""
    cleaned = text.replace("\r\n", "\n").replace("\r", "\n")
    cleaned = cleaned.replace("\ufeff", "").replace("\u200b", "").replace("\u00a0", " ")
    cleaned = _CONTROL_CHARS.sub("", cleaned)
    lines = [_HORIZONTAL_SPACE.sub(" ", line).strip() for line in cleaned.split("\n")]
    return "\n".join(lines)


def _word_before(text: str, index: int) -> str:
    start = index
    while start > 0 and text[start - 1].isalpha():
        start -= 1
    return text[start:index]


def _is_sentence_boundary(text: str, match: re.Match[str]) -> bool:
    following = text[match.end()]  # the regex lookahead guarantees a non-space character here
    if following.islower() or following.isdigit():
        return False
    if match.group("term") == ".":
        word = _word_before(text, match.start("term"))
        if word.lower() in ABBREVIATIONS:
            return False
        if len(word) == 1 and word.isalpha():  # initial, e.g. "A. Navoiy"
            return False
    return True


def _split_paragraph(paragraph: str) -> list[str]:
    sentences: list[str] = []
    start = 0
    for match in _TERMINATOR.finditer(paragraph):
        if not _is_sentence_boundary(paragraph, match):
            continue
        sentence = paragraph[start : match.end("close")].strip()
        if sentence:
            sentences.append(sentence)
        start = match.end()
    tail = paragraph[start:].strip()
    if tail:
        sentences.append(tail)
    return sentences


def split_sentences(text: str) -> list[str]:
    """Split text into sentences. Blank lines always end a sentence."""
    sentences: list[str] = []
    for block in _PARAGRAPH_BREAK.split(normalize_text(text)):
        flat = " ".join(line for line in block.split("\n") if line)
        if flat:
            sentences.extend(_split_paragraph(flat))
    return sentences


def _break_long(sentence: str, limit: int) -> list[str]:
    """Break a sentence longer than ``limit`` into pieces at word boundaries."""
    if len(sentence) <= limit:
        return [sentence]
    pieces: list[str] = []
    current = ""
    for word in sentence.split():
        while len(word) > limit:  # pathological token longer than the limit
            if current:
                pieces.append(current)
                current = ""
            pieces.append(word[:limit])
            word = word[limit:]
        candidate = f"{current} {word}" if current else word
        if len(candidate) <= limit:
            current = candidate
        else:
            pieces.append(current)
            current = word
    if current:
        pieces.append(current)
    return pieces


def build_chunks(text: str, *, sentences_per_chunk: int = 2, max_chunk_chars: int = 600) -> list[str]:
    """Build TTS chunks of up to ``sentences_per_chunk`` sentences, each at most ``max_chunk_chars`` long.

    Returns an empty list when the text contains nothing readable.
    """
    if sentences_per_chunk < 1:
        raise ValueError("sentences_per_chunk must be at least 1")
    if max_chunk_chars < 1:
        raise ValueError("max_chunk_chars must be at least 1")

    units: list[str] = []
    for sentence in split_sentences(text):
        units.extend(_break_long(sentence, max_chunk_chars))

    chunks: list[str] = []
    group: list[str] = []
    for unit in units:
        full = len(group) >= sentences_per_chunk
        too_long = bool(group) and len(" ".join([*group, unit])) > max_chunk_chars
        if group and (full or too_long):
            chunks.append(" ".join(group))
            group = []
        group.append(unit)
    if group:
        chunks.append(" ".join(group))
    return chunks
