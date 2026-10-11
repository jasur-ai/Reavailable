import { VoiceCommandService, type SpeechRecognizerPort } from '../../src/core/voice/voiceService';

/** A recognizer that lets the test emit partial and final results by hand. */
function manualRecognizer() {
  const partial = new Set<(raw: string) => void>();
  const finals = new Set<(raw: string) => void>();
  const recognizer: SpeechRecognizerPort = {
    async start() {},
    async stop() {},
    onResult(listener) {
      finals.add(listener);
      return () => finals.delete(listener);
    },
    onPartial(listener) {
      partial.add(listener);
      return () => partial.delete(listener);
    },
    onError: () => () => undefined,
    onStopped: () => () => undefined,
  };
  return {
    recognizer,
    emitPartial: (raw: string) => partial.forEach((listener) => listener(raw)),
    emitFinal: (raw: string) => finals.forEach((listener) => listener(raw)),
  };
}

describe('voice service with partial results', () => {
  it('runs a command as soon as its word is partially recognized', async () => {
    const manual = manualRecognizer();
    const dispatched: string[] = [];
    let now = 10_000;
    const service = new VoiceCommandService(manual.recognizer, (command) => dispatched.push(command), {
      cooldownMs: 1_500,
      minConfidence: 0.5,
      now: () => now,
    });
    await service.start();

    manual.emitPartial('{"partial": "pause"}');
    expect(dispatched).toEqual(['pause']);

    // The final result of the same word, moments later, must not run it a second time.
    now += 300;
    manual.emitFinal('{"text": "pause", "result": []}');
    expect(dispatched).toEqual(['pause']);

    // After the cooldown, a new command is accepted again.
    now += 2_000;
    manual.emitPartial('{"partial": "start"}');
    expect(dispatched).toEqual(['pause', 'start']);
    service.dispose();
  });

  it('ignores partial results that are not a single command word', async () => {
    const manual = manualRecognizer();
    const dispatched: string[] = [];
    const service = new VoiceCommandService(manual.recognizer, (command) => dispatched.push(command));
    await service.start();
    manual.emitPartial('{"partial": "pau"}');
    manual.emitPartial('{"partial": "[unk]"}');
    expect(dispatched).toEqual([]);
    service.dispose();
  });
});
