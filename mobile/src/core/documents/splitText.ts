/**
 * Splits a long text into parts that each fit one book on the server. Parts break at paragraph
 * boundaries when possible and at sentence boundaries otherwise, so no sentence is cut in half.
 */

const SENTENCE_PATTERN = /[^.!?…]*[.!?…]+["'»”’)\]]*\s*|[^.!?…]+$/g;

interface Unit {
  text: string;
  /** True for the last sentence of a paragraph: the next unit starts a new paragraph. */
  endsParagraph: boolean;
}

function sentencesOf(paragraph: string): string[] {
  const matches = paragraph.match(SENTENCE_PATTERN) ?? [paragraph];
  return matches.map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 0);
}

/** Cuts one over-long sentence at spaces, so every piece is at most `maxChars` long. */
function cutAtSpaces(text: string, maxChars: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(' ', maxChars);
    if (cut <= 0) {
      cut = maxChars;
    }
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) {
    pieces.push(rest);
  }
  return pieces;
}

function toUnits(text: string, maxChars: number): Unit[] {
  const units: Unit[] = [];
  for (const paragraph of text.split(/\n\s*\n/)) {
    const sentences = sentencesOf(paragraph.replace(/\s+/g, ' '));
    sentences.forEach((sentence, index) => {
      const pieces = sentence.length > maxChars ? cutAtSpaces(sentence, maxChars) : [sentence];
      pieces.forEach((piece, pieceIndex) => {
        units.push({
          text: piece,
          endsParagraph: index === sentences.length - 1 && pieceIndex === pieces.length - 1,
        });
      });
    });
  }
  return units;
}

/**
 * Returns the text as parts of at most `maxChars` characters each. A text that already fits is
 * returned as a single part. Blank input gives an empty list.
 */
export function splitTranscript(text: string, maxChars: number): string[] {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (normalized.length === 0) {
    return [];
  }
  if (normalized.length <= maxChars) {
    return [normalized];
  }

  const parts: string[] = [];
  let current = '';
  let paragraphEnded = false;
  for (const unit of toUnits(normalized, maxChars)) {
    if (current.length === 0) {
      current = unit.text;
    } else {
      const separator = paragraphEnded ? '\n\n' : ' ';
      const candidate = current + separator + unit.text;
      if (candidate.length > maxChars) {
        parts.push(current);
        current = unit.text;
      } else {
        current = candidate;
      }
    }
    paragraphEnded = unit.endsParagraph;
  }
  if (current.length > 0) {
    parts.push(current);
  }
  return parts;
}
