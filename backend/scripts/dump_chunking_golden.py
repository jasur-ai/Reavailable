"""Regenerate the shared chunking fixture used by the Cloudflare Worker tests.

The Python chunker in ``app/chunking.py`` is the reference implementation. The Worker port must
split text exactly the same way, so both are checked against one committed fixture::

    python backend/scripts/dump_chunking_golden.py > worker/tests/fixtures/chunking-golden.json

CI regenerates the fixture and fails when it differs from the committed copy, which catches a port
that drifted from the reference.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "backend"))

from app.chunking import build_chunks, has_cyrillic, split_sentences  # noqa: E402

CASES: list[tuple[str, int, int]] = [
    ("Salom. Bu test. Ikkinchi gap!", 2, 600),
    ("Salom. Bu test. Ikkinchi gap!", 1, 600),
    ("", 2, 600),
    ("   \n\n  ", 2, 600),
    (
        "Dr. Karimov bugun keldi. U kitobni o'qidi va juda qiziqarli deb topdi!\n\n"
        "Ikkinchi bob shu yerda boshlanadi. Quyosh nuri derazadan tushib turardi.",
        2,
        600,
    ),
    (
        "A. Navoiy buyuk shoir edi. Uning asarlari bugungacha o'qiladi. "
        "Prof. Yusupov ma'ruza qildi. Talabalar diqqat bilan tingladi.",
        2,
        600,
    ),
    (
        "Narx 3.5 so'mga oshdi. Keyin 4.25 bo'ldi. 3. yil oxirida hammasi o'zgardi.",
        1,
        600,
    ),
    (
        'U "kelaman" dedi va chiqib ketdi. (Bu juda g\'alati edi.) Keyin hech narsa bo\'lmadi...',
        2,
        600,
    ),
    (
        "Manzil: https://example.com/a.b/c?q=1.2 sahifasida yozilgan. "
        "Ko'proq ma'lumot uchun murojaat qiling.",
        2,
        600,
    ),
    (
        "Биринчи жумла. Иккинчи жумла келди.\n\nУчинчи жумла шу ерда.",
        2,
        600,
    ),
    (
        "Bu juda uzun gap bo'lib, " + ("so'z " * 250) + "va nihoyat tugadi.",
        2,
        120,
    ),
    ("Bitta gap", 2, 600),
    ("Bitta gap.", 2, 600),
    ("Bir\nikki\nuch", 2, 600),
    ("Bir\n\nikki", 2, 600),
    ("  Ko'p   bo'shliq   bilan.   Keyingi   gap.  ", 2, 600),
    ("Raqam 7. Keyingi gap boshlandi.", 1, 600),
    ("etc. va boshqalar ishlatiladi. Bu ham muhim.", 2, 600),
    ("mln. so'm berildi. Keyin yana so'raldi.", 2, 600),
    ("Uchta nuqta... va davom. Yana bir gap!", 2, 600),
    ("So'roq? Javob. Undov!", 1, 600),
    ("a. b. c. harflari ketma-ket.", 2, 600),
    ("\u2018Iqtibos\u2019 ichida gap bor. \u201cYana biri\u201d ham bor.", 2, 600),
    ("x" * 700, 1, 600),
    ("so'z" * 200 + ". Tugadi.", 2, 600),
]


def main() -> None:
    payload = {
        "generated_by": "backend/scripts/dump_chunking_golden.py",
        "cases": [
            {
                "text": text,
                "sentences_per_chunk": sentences_per_chunk,
                "max_chunk_chars": max_chunk_chars,
                "sentences": split_sentences(text),
                "chunks": build_chunks(
                    text,
                    sentences_per_chunk=sentences_per_chunk,
                    max_chunk_chars=max_chunk_chars,
                ),
                "has_cyrillic": has_cyrillic(text),
            }
            for text, sentences_per_chunk, max_chunk_chars in CASES
        ],
    }
    json.dump(payload, sys.stdout, ensure_ascii=False, indent=2, sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
