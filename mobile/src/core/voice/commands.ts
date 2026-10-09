/**
 * English voice commands. The recognizer is restricted to this closed vocabulary, so anything
 * else is rejected as [unk] and cannot trigger an action.
 */

export const VOICE_COMMANDS = ['next', 'repeat', 'pause', 'resume'] as const;

export type VoiceCommand = (typeof VOICE_COMMANDS)[number];

/** Token the recognizer emits for words outside the grammar. */
export const UNKNOWN_TOKEN = '[unk]';

/** Grammar handed to the recognizer. */
export const VOICE_GRAMMAR: readonly string[] = [...VOICE_COMMANDS, UNKNOWN_TOKEN];

export function isVoiceCommand(word: string): word is VoiceCommand {
  return (VOICE_COMMANDS as readonly string[]).includes(word);
}

export interface RecognizedText {
  text: string;
  /** Lowest per-word confidence (0..1) when the engine reports it, otherwise null. */
  confidence: number | null;
}

/** Reads a recognizer result. Accepts plain text and Vosk's JSON form ({"text": ..., "result": [...]}). */
export function readRecognizedText(raw: string): RecognizedText {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as { text?: unknown; result?: unknown };
        return {
          text: typeof record.text === 'string' ? record.text : '',
          confidence: lowestConfidence(record.result),
        };
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
  if (!isVoiceCommand(word)) {
    return null;
  }
  if (confidence !== null && confidence < minConfidence) {
    return null;
  }
  return word;
}
