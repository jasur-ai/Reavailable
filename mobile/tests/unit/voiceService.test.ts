import { VOICE_GRAMMAR } from '../../src/core/voice/commands';
import { VoiceCommandService, type VoiceServiceOptions } from '../../src/core/voice/voiceService';
import { FakeRecognizer } from './support/fakeRecognizer';

function setup(options: Partial<VoiceServiceOptions> = {}) {
  const recognizer = new FakeRecognizer();
  const dispatched: string[] = [];
  let clock = 10_000;
  const service = new VoiceCommandService(recognizer, (command) => dispatched.push(command), {
    cooldownMs: 1_500,
    minConfidence: 0.5,
    now: () => clock,
    ...options,
  });
  return {
    recognizer,
    service,
    dispatched,
    advance(ms: number) {
      clock += ms;
    },
  };
}

describe('VoiceCommandService: lifecycle', () => {
  it('starts listening with the closed grammar', async () => {
    const { service, recognizer } = setup();
    await service.start();
    expect(service.getSnapshot().status).toBe('listening');
    expect(recognizer.starts).toEqual([[...VOICE_GRAMMAR]]);
  });

  it('does not start the recognizer twice', async () => {
    const { service, recognizer } = setup();
    await service.start();
    await service.start();
    expect(recognizer.starts).toHaveLength(1);
  });

  it('stops the recognizer and reports off', async () => {
    const { service, recognizer } = setup();
    await service.start();
    await service.stop();
    expect(recognizer.stops).toBe(1);
    expect(service.getSnapshot().status).toBe('off');
  });

  it('ignores results that arrive after stop', async () => {
    const { service, recognizer, dispatched } = setup();
    await service.start();
    await service.stop();
    recognizer.emitResult('next');
    expect(dispatched).toEqual([]);
  });

  it('reports an error when the recognizer cannot start, and can start again later', async () => {
    const { service, recognizer } = setup();
    recognizer.failNextStart = 'Microphone access is needed.';
    await service.start();
    expect(service.getSnapshot()).toMatchObject({ status: 'error', message: 'Microphone access is needed.' });

    await service.start();
    expect(service.getSnapshot().status).toBe('listening');
  });

  it('uses a generic message when the start error is not an Error', async () => {
    const { service, recognizer } = setup();
    recognizer.start = () => Promise.reject('boom');
    await service.start();
    expect(service.getSnapshot()).toMatchObject({ status: 'error', message: 'Voice control could not start.' });
  });

  it('stays off when stop is requested while the recognizer is still starting', async () => {
    const { service, recognizer } = setup();
    let release: () => void = () => undefined;
    recognizer.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const starting = service.start();
    expect(service.getSnapshot().status).toBe('starting');

    await service.stop();
    release();
    await starting;
    expect(service.getSnapshot().status).toBe('off');
  });

  it('stays unavailable and never touches the recognizer when the speech module is missing', async () => {
    const { service, recognizer } = setup();
    service.markUnavailable('Not in this build.');
    await service.start();
    expect(recognizer.starts).toEqual([]);
    expect(service.getSnapshot()).toMatchObject({ status: 'unavailable', message: 'Not in this build.' });
  });

  it('keeps listening after the engine stops by itself', async () => {
    const { service, recognizer } = setup();
    await service.start();
    recognizer.emitStopped();
    await new Promise((resolve) => setImmediate(resolve));
    expect(recognizer.starts).toHaveLength(2);
    expect(service.getSnapshot().status).toBe('listening');
  });

  it('does not restart the engine after the user turned voice control off', async () => {
    const { service, recognizer } = setup();
    await service.start();
    await service.stop();
    recognizer.emitStopped();
    await new Promise((resolve) => setImmediate(resolve));
    expect(recognizer.starts).toHaveLength(1);
  });

  it('retries after an automatic restart fails, then reports an error when retries run out', async () => {
    const { service, recognizer } = setup({ maxRetries: 1, retryDelayMs: 0 });
    await service.start();
    const original = recognizer.start.bind(recognizer);
    recognizer.start = async () => {
      throw new Error('Recognizer busy.');
    };
    recognizer.emitStopped();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(service.getSnapshot()).toMatchObject({ status: 'error', message: 'Recognizer busy.' });
    recognizer.start = original;
  });

  it('recovers from a single engine error without the user restarting voice control', async () => {
    const { service, recognizer } = setup({ retryDelayMs: 0 });
    await service.start();
    recognizer.emitError('Audio device lost.');
    expect(service.getSnapshot().status).toBe('starting');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(recognizer.starts).toHaveLength(2);
    expect(service.getSnapshot().status).toBe('listening');
    recognizer.emitResult('next');
    expect(service.getSnapshot().lastCommand).toBe('next');
  });

  it('stops retrying after repeated engine errors and reports the last one', async () => {
    const { service, recognizer } = setup({ maxRetries: 2, retryDelayMs: 0 });
    await service.start();
    for (let i = 0; i < 3; i += 1) {
      recognizer.emitError('Audio device lost.');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(service.getSnapshot()).toMatchObject({ status: 'error', message: 'Audio device lost.' });
  });

  it('does not restart after an engine error once the user turned voice off', async () => {
    const { service, recognizer } = setup({ retryDelayMs: 0 });
    await service.start();
    recognizer.emitError('Audio device lost.');
    await service.stop();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(recognizer.starts).toHaveLength(1);
    expect(service.getSnapshot().status).toBe('off');
  });

  it('notifies subscribers and stops after unsubscribe', async () => {
    const { service } = setup();
    let calls = 0;
    const unsubscribe = service.subscribe(() => {
      calls += 1;
    });
    await service.start();
    expect(calls).toBeGreaterThan(0);
    unsubscribe();
    const before = calls;
    await service.stop();
    expect(calls).toBe(before);
  });

  it('dispose removes every recognizer listener', async () => {
    const { service, recognizer } = setup();
    expect(recognizer.listenerCount()).toBe(3);
    service.dispose();
    expect(recognizer.listenerCount()).toBe(0);
  });
});

describe('VoiceCommandService: accepting commands', () => {
  it('dispatches a recognized command while listening', async () => {
    const { service, recognizer, dispatched } = setup();
    await service.start();
    recognizer.emitResult('next');
    expect(dispatched).toEqual(['next']);
    expect(service.getSnapshot().lastCommand).toBe('next');
  });

  it('ignores commands while voice control is not listening', () => {
    const { service, recognizer, dispatched } = setup();
    recognizer.emitResult('pause');
    expect(dispatched).toEqual([]);
    expect(service.handleResult('pause')).toBeNull();
  });

  it('blocks a second command inside the cooldown and accepts it after the cooldown', async () => {
    const { service, recognizer, dispatched, advance } = setup();
    await service.start();
    recognizer.emitResult('next');
    advance(800);
    recognizer.emitResult('repeat');
    expect(dispatched).toEqual(['next']);

    advance(800);
    recognizer.emitResult('pause');
    expect(dispatched).toEqual(['next', 'pause']);
  });

  it('does not start the cooldown for results that were rejected', async () => {
    const { service, recognizer, dispatched } = setup();
    await service.start();
    recognizer.emitResult('[unk]');
    recognizer.emitResult('next');
    expect(dispatched).toEqual(['next']);
  });

  it('rejects low-confidence results from the engine', async () => {
    const { service, recognizer, dispatched } = setup({ minConfidence: 0.8 });
    await service.start();
    recognizer.emitResult(JSON.stringify({ text: 'next', result: [{ word: 'next', conf: 0.6 }] }));
    expect(dispatched).toEqual([]);
  });

  it('returns the accepted command from handleResult', async () => {
    const { service } = setup();
    await service.start();
    expect(service.handleResult('resume')).toBe('resume');
    expect(service.handleResult('resume')).toBeNull();
  });
});

describe('VoiceCommandService: last heard indicator state', () => {
  it('sets lastHeard as accepted when a command runs', async () => {
    const { service, recognizer } = setup();
    await service.start();
    recognizer.emitResult('pause');
    expect(service.getSnapshot().lastHeard).toMatchObject({ command: 'pause', accepted: true });
  });

  it('marks a command heard during cooldown as not accepted', async () => {
    const { service, recognizer, advance } = setup();
    await service.start();
    recognizer.emitResult('next');
    advance(300);
    recognizer.emitResult('pause');
    expect(service.getSnapshot().lastHeard).toMatchObject({ command: 'pause', accepted: false });
    expect(service.getSnapshot().lastCommand).toBe('next');
  });

  it('keeps lastHeard unchanged when the same command is repeated during cooldown', async () => {
    const { service, recognizer, advance } = setup();
    await service.start();
    recognizer.emitResult('next');
    const first = service.getSnapshot().lastHeard;
    advance(300);
    recognizer.emitResult('next');
    expect(service.getSnapshot().lastHeard).toBe(first);
  });

  it('does not change lastHeard for results that are not commands', async () => {
    const { service, recognizer } = setup();
    await service.start();
    recognizer.emitResult('[unk]');
    expect(service.getSnapshot().lastHeard ?? null).toBeNull();
  });
});
