"""Unit tests for transcript segmentation."""

from __future__ import annotations

import pytest

from app.chunking import build_chunks, has_cyrillic, normalize_text, split_sentences


def test_splits_on_terminal_punctuation() -> None:
    assert split_sentences("Salom dunyo. Bugun havo yaxshi! Ertaga yomg'ir yog'adimi?") == [
        "Salom dunyo.",
        "Bugun havo yaxshi!",
        "Ertaga yomg'ir yog'adimi?",
    ]


def test_abbreviations_and_initials_do_not_split() -> None:
    assert split_sentences("Dr. Karimov keldi. A. Navoiy she'rlari o'qildi.") == [
        "Dr. Karimov keldi.",
        "A. Navoiy she'rlari o'qildi.",
    ]


def test_lowercase_continuation_does_not_split() -> None:
    assert split_sentences("Bu 3. yil edi. Keyin boshqa voqea sodir bo'ldi.") == [
        "Bu 3. yil edi.",
        "Keyin boshqa voqea sodir bo'ldi.",
    ]


def test_decimals_and_urls_are_kept_intact() -> None:
    assert split_sentences("Narx 3.5 dollar. Sayt example.com manzilida.") == [
        "Narx 3.5 dollar.",
        "Sayt example.com manzilida.",
    ]


def test_blank_lines_are_hard_boundaries() -> None:
    assert split_sentences("Birinchi abzats\n\nIkkinchi abzats") == ["Birinchi abzats", "Ikkinchi abzats"]


def test_single_newlines_inside_a_paragraph_are_joined() -> None:
    assert split_sentences("Gap bir davom\netadi.\nYangi gap.") == ["Gap bir davom etadi.", "Yangi gap."]


def test_closing_quotes_and_brackets_stay_with_their_sentence() -> None:
    text = "U dedi: «Yaxshi.» Keyin ketdi. Ular (ikki kishi) kelishdi."
    assert split_sentences(text) == ["U dedi: «Yaxshi.»", "Keyin ketdi.", "Ular (ikki kishi) kelishdi."]


def test_uzbek_apostrophes_and_cyrillic_script() -> None:
    text = "O‘zbekiston go‘zal mamlakat. Ўзбекистон — чиройли юрт."
    assert split_sentences(text) == ["O‘zbekiston go‘zal mamlakat.", "Ўзбекистон — чиройли юрт."]


def test_ellipsis_followed_by_lowercase_is_not_split() -> None:
    assert split_sentences("U o'ylab qoldi... va gapirmadi. Xayr.") == [
        "U o'ylab qoldi... va gapirmadi.",
        "Xayr.",
    ]


def test_empty_and_whitespace_only_input_has_no_sentences() -> None:
    assert split_sentences("") == []
    assert split_sentences("  \n\n \t ") == []


def test_control_characters_bom_and_nbsp_are_normalized() -> None:
    assert normalize_text("\ufeffSalom\x00 dunyo\r\nYangi\u00a0qator") == "Salom dunyo\nYangi qator"


def test_long_sentence_is_broken_at_word_boundaries() -> None:
    text = " ".join(["so'z"] * 400) + "."
    pieces = build_chunks(text, sentences_per_chunk=1, max_chunk_chars=300)
    assert all(len(piece) <= 300 for piece in pieces)
    assert " ".join(pieces).split() == text.split()


def test_token_longer_than_the_limit_is_hard_split() -> None:
    token = "a" * 250
    pieces = build_chunks(token + " tail", sentences_per_chunk=1, max_chunk_chars=100)
    assert all(len(piece) <= 100 for piece in pieces)
    assert "".join(piece.replace(" ", "") for piece in pieces) == token + "tail"


def test_chunks_group_two_sentences_by_default() -> None:
    assert build_chunks("Bir. Ikki. Uch. To'rt. Besh.") == ["Bir. Ikki.", "Uch. To'rt.", "Besh."]


def test_single_sentence_mode() -> None:
    assert build_chunks("Bir. Ikki. Uch.", sentences_per_chunk=1) == ["Bir.", "Ikki.", "Uch."]


def test_character_limit_is_respected_when_grouping() -> None:
    text = "Birinchi gap juda uzun bo'lishi kerak. Ikkinchi gap ham uzun bo'lsin. Uchinchi."
    chunks = build_chunks(text, sentences_per_chunk=2, max_chunk_chars=60)
    assert len(chunks) == 2
    assert all(len(chunk) <= 60 for chunk in chunks)


def test_build_chunks_rejects_invalid_parameters() -> None:
    with pytest.raises(ValueError, match="sentences_per_chunk"):
        build_chunks("x", sentences_per_chunk=0)
    with pytest.raises(ValueError, match="max_chunk_chars"):
        build_chunks("x", max_chunk_chars=0)


def test_build_chunks_of_blank_text_is_empty() -> None:
    assert build_chunks("   \n  ") == []


def test_cyrillic_detection() -> None:
    assert has_cyrillic("Ўзбекистон")
    assert not has_cyrillic("O'zbekiston")
