/**
 * English voice commands. The recognizer is restricted to this closed vocabulary, so anything
 * else is rejected as [unk] and cannot trigger an action.
 *
 * Each command has one or more spoken words. Synonyms are kept to words that sound clearly
 * different from each other, so the recognizer does not confuse "pause" with "play".
 */

/** The actions the player understands. */
export const VOICE_COMMANDS = ['start', 'pause', 'resume', 'next', 'previous', 'repeat'] as const;

export type VoiceCommand = (typeof VOICE_COMMANDS)[number];

/** Every word the recognizer listens for, mapped to the action it triggers. */
export const VOICE_WORDS: Readonly<Record<string, VoiceCommand>> = {
  start: 'start',
  play: 'start',
  pause: 'pause',
  stop: 'pause',
  resume: 'resume',
  continue: 'resume',
  next: 'next',
  skip: 'next',
  previous: 'previous',
  back: 'previous',
  repeat: 'repeat',
  again: 'repeat',
};

/** Token the recognizer emits for words outside the grammar. */
export const UNKNOWN_TOKEN = '[unk]';

/** Grammar handed to the recognizer: every listened word plus the unknown token. */
export const VOICE_GRAMMAR: readonly string[] = [...Object.keys(VOICE_WORDS), UNKNOWN_TOKEN];

export function isVoiceWord(word: string): boolean {
  return Object.prototype.hasOwnProperty.call(VOICE_WORDS, word);
}

export interface RecognizedText {
  text: string;
  /** Lowest per-word confidence (0..1) when the engine reports it, otherwise null. */
  confidence: number | null;
}

/**
 * Reads a recognizer result. Accepts plain text, Vosk's final JSON ({"text": ..., "result": [...]})
 * and Vosk's partial JSON ({"partial": ...}), which arrives while the user is still speaking.
 */
export function readRecognizedText(raw: string): RecognizedText {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as { text?: unknown; partial?: unknown; result?: unknown };
        const text = typeof record.text === 'string' ? record.text : typeof record.partial === 'string' ? record.partial : '';
        return { text, confidence: lowestConfidence(record.result) };
      }
    } catch {
      // Not JSON after all: treat the whole string as text.
    }
  }
  return { text: trimmed, confidence: null };
}

function lowestConfidence(result: unknown): number | null {
  if (!Array.isArray(result)) {
    return null;
  }
  let lowest: number | null = null;
  for (const entry of result) {
    if (typeof entry === 'object' && entry !== null) {
      const conf = (entry as { conf?: unknown }).conf;
      if (typeof conf === 'number' && (lowest === null || conf < lowest)) {
        lowest = conf;
      }
    }
  }
  return lowest;
}

/**
 * Maps a recognizer result to a command. Only a single recognized word counts. Phrases such as
 * "next time" or results containing [unk] are rejected to keep false positives low.
 */
export function parseCommand(raw: string, minConfidence: number): VoiceCommand | null {
  const { text, confidence } = readRecognizedText(raw);
  const tokens = text.toLowerCase().split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length !== 1) {
    return null;
  }
  const word = tokens[0].replace(/[^a-z]/g, '');
  if (!isVoiceWord(word)) {
    return null;
  }
  if (confidence !== null && confidence < minConfidence) {
    return null;
  }
  return VOICE_WORDS[word];
}
