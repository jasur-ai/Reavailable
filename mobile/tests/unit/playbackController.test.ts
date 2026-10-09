import { PlaybackController } from '../../src/core/playback/playbackController';
import { Library } from '../../src/core/library/library';
import { FakePlayer, makeBook, settle } from './support/fakePlayer';
import { MemoryPersistence } from './support/memory';

function setup(options: { now?: () => number } = {}) {
  const player = new FakePlayer();
  const library = new Library(new MemoryPersistence(), () => new Date('2026-10-09T05:00:00.000Z'));
  let clock = 0;
  const controller = new PlaybackController({
    player,
    library,
    audio: { uri: (path: string) => `file:///audio/${path}` },
    finishedGuardMs: 0,
    now: options.now ?? (() => clock),
  });
  return {
    player,
    library,
    controller,
    setClock(value: number) {
      clock = value;
    },
  };
}

describe('PlaybackController: opening and basic controls', () => {
  it('opens a book at its saved part, paused', async () => {
    const { controller, library, player } = setup();
    library.insert(makeBook('b1', ['stored', 'stored', 'stored'], { position: 1 }));

    await controller.open('b1');
    expect(controller.getSnapshot()).toMatchObject({ bookId: 'b1', index: 1, totalChunks: 3, status: 'paused' });
    // Any previous book is stopped first, then the saved part is loaded without autoplay.
    expect(player.events).toEqual(['pause', 'load file:///audio/b1/000001.mp3 paused']);
  });

  it('plays, pauses and resumes without reloading the part', async () => {
    const { controller, library, player } = setup();
    library.insert(makeBook('b1', ['stored', 'stored']));
    await controller.open('b1');

    await controller.play();
    expect(controller.getSnapshot().status).toBe('playing');
    await controller.pause();
    expect(controller.getSnapshot().status).toBe('paused');
    await controller.play();
    expect(controller.getSnapshot().status).toBe('playing');
    expect(player.loadedUris()).toHaveLength(1);
    expect(player.events).toEqual(expect.arrayContaining(['pause', 'play']));
  });

  it('repeats the current part from its beginning', async () => {
    const { controller, library, player } = setup();
    library.insert(makeBook('b1', ['stored', 'stored']));
    await controller.open('b1');
    await controller.play();
    await controller.repeat();

    expect(player.events.slice(-2)).toEqual(['seek 0', 'play']);
    expect(controller.getSnapshot()).toMatchObject({ index: 0, status: 'playing' });
  });

  it('next moves to the following part and starts it when playing', async () => {
    const { controller, library, player } = setup();
    library.insert(makeBook('b1', ['stored', 'stored', 'stored']));
    await controller.open('b1');
    await controller.play();
    await controller.next();

    expect(controller.getSnapshot()).toMatchObject({ index: 1, status: 'playing' });
    expect(player.loadedUris().at(-1)).toBe('file:///audio/b1/000001.mp3');
    expect(library.book('b1')?.position).toBe(1);
  });

  it('keeps paused when the user skips while paused', async () => {
    const { controller, library } = setup();
    library.insert(makeBook('b1', ['stored', 'stored']));
    await controller.open('b1');
    await controller.next();
    expect(controller.getSnapshot()).toMatchObject({ index: 1, status: 'paused' });
  });

  it('goes to a tapped part and ignores out-of-range indexes', async () => {
    const { controller, library } = setup();
    library.insert(makeBook('b1', ['stored', 'stored', 'stored']));
    await controller.open('b1');

    await controller.goTo(2);
    expect(controller.getSnapshot().index).toBe(2);
    await controller.goTo(-1);
    await controller.goTo(3);
    await controller.goTo(2);
    expect(controller.getSnapshot().index).toBe(2);
  });
});

describe('PlaybackController: advancing and finishing', () => {
  it('advances automatically when a part finishes', async () => {
    const { controller, library, player } = setup();
    library.insert(makeBook('b1', ['stored', 'stored', 'stored']));
    await controller.open('b1');
    await controller.play();

    player.finish();
    await settle();
    expect(controller.getSnapshot()).toMatchObject({ index: 1, status: 'playing' });
    player.finish();
    await settle();
    expect(controller.getSnapshot()).toMatchObject({ index: 2, status: 'playing' });
    expect(library.book('b1')?.position).toBe(2);
  });

  it('finishes the book after the last part and restarts from the first part on play', async () => {
    const { controller, library, player } = setup();
    library.insert(makeBook('b1', ['stored', 'stored']));
    await controller.open('b1');
    await controller.play();
    player.finish();
    await settle();
    player.finish();
    await settle();

    expect(controller.getSnapshot()).toMatchObject({ index: 1, status: 'finished' });
    expect(player.playing).toBe(false);

    await controller.play();
    expect(controller.getSnapshot()).toMatchObject({ index: 0, status: 'playing' });
  });

  it('ignores a finished event that belongs to the previous source', async () => {
    let clock = 1_000;
    const player = new FakePlayer();
    const library = new Library(new MemoryPersistence());
    const controller = new PlaybackController({
      player,
      library,
      audio: { uri: (path) => path },
      finishedGuardMs: 400,
      now: () => clock,
    });
    library.insert(makeBook('b1', ['stored', 'stored', 'stored']));
    await controller.open('b1');
    await controller.play();

    // The user skipped just before the old source ended: its event arrives 100 ms after the new load.
    await controller.next();
    clock = 1_100;
    player.finish();
    await settle();
    expect(controller.getSnapshot().index).toBe(1);

    clock = 2_000;
    player.finish();
    await settle();
    expect(controller.getSnapshot().index).toBe(2);
  });

  it('ignores finished events while nothing is playing', async () => {
    const { controller, library, player } = setup();
    library.insert(makeBook('b1', ['stored', 'stored']));
    await controller.open('b1');
    player.finish();
    await settle();
    expect(controller.getSnapshot().index).toBe(0);
  });
});

describe('PlaybackController: parts that are not on the device yet', () => {
  it('waits for a part that is still downloading and starts it when it is stored', async () => {
    const { controller, library, player } = setup();
    library.insert(makeBook('b1', ['stored', 'pending', 'stored']));
    await controller.open('b1');
    await controller.play();
    player.finish();
    await settle();

    expect(controller.getSnapshot()).toMatchObject({ index: 1, status: 'waiting', waitingReason: 'downloading' });
    expect(player.playing).toBe(false);

    library.update('b1', (draft) => {
      const part = draft.chunks[1];
      if (part) {
        part.state = 'stored';
        part.file = 'b1/000001.mp3';
      }
    });
    await controller.notifyLibraryChanged();
    expect(controller.getSnapshot()).toMatchObject({ index: 1, status: 'playing', waitingReason: null });
  });

  it('does nothing on library changes while the waited-for part is still missing', async () => {
    const { controller, library, player } = setup();
    library.insert(makeBook('b1', ['stored', 'pending']));
    await controller.open('b1');
    await controller.play();
    await controller.next();
    const eventsBefore = player.events.length;

    await controller.notifyLibraryChanged();
    await controller.notifyLibraryChanged();
    expect(player.events.length).toBe(eventsBefore);
    expect(controller.getSnapshot().status).toBe('waiting');
  });

  it('explains a failed part and lets the user skip it', async () => {
    const { controller, library } = setup();
    library.insert(makeBook('b1', ['stored', 'failed', 'stored'], { status: 'failed' }));
    await controller.open('b1');
    await controller.next();
    expect(controller.getSnapshot()).toMatchObject({ index: 1, status: 'waiting', waitingReason: 'missing' });

    await controller.next();
    expect(controller.getSnapshot()).toMatchObject({ index: 2, status: 'paused' });
  });

  it('waits while the server is still preparing a book with no parts yet', async () => {
    const { controller, library } = setup();
    library.insert(makeBook('b1', [], { status: 'processing', totalChunks: 0 }));
    await controller.open('b1');
    expect(controller.getSnapshot()).toMatchObject({ status: 'waiting', waitingReason: 'processing', totalChunks: 0 });

    library.update('b1', (draft) => {
      draft.status = 'ready';
      draft.totalChunks = 1;
      draft.chunks = makeBook('b1', ['stored']).chunks;
    });
    await controller.notifyLibraryChanged();
    expect(controller.getSnapshot()).toMatchObject({ status: 'paused', totalChunks: 1 });
  });

  it('updates the part count when the book gains parts', async () => {
    const { controller, library } = setup();
    library.insert(makeBook('b1', ['stored'], { totalChunks: 1 }));
    await controller.open('b1');
    library.update('b1', (draft) => {
      draft.totalChunks = 4;
    });
    await controller.notifyLibraryChanged();
    expect(controller.getSnapshot().totalChunks).toBe(4);
  });
});

describe('PlaybackController: errors and lifecycle', () => {
  it('reports a part the player cannot load, and recovers when asked to play again', async () => {
    const { controller, library, player } = setup();
    library.insert(makeBook('b1', ['stored']));
    player.failLoad = true;
    await controller.open('b1');
    expect(controller.getSnapshot()).toMatchObject({ status: 'error' });
    expect(controller.getSnapshot().error).toContain('could not be played');

    player.failLoad = false;
    await controller.play();
    expect(controller.getSnapshot().status).toBe('playing');
  });

  it('stops and forgets the book on close', async () => {
    const { controller, library, player } = setup();
    library.insert(makeBook('b1', ['stored', 'stored']));
    await controller.open('b1');
    await controller.play();
    await controller.close();

    expect(controller.getSnapshot()).toMatchObject({ bookId: null, status: 'idle' });
    expect(player.playing).toBe(false);
    await controller.play();
    expect(controller.getSnapshot().status).toBe('idle');
  });

  it('becomes idle when the active book is removed from the library', async () => {
    const { controller, library } = setup();
    library.insert(makeBook('b1', ['stored']));
    await controller.open('b1');
    library.remove('b1');
    await controller.notifyLibraryChanged();
    expect(controller.getSnapshot().status).toBe('idle');
  });

  it('opening an unknown book leaves the player idle', async () => {
    const { controller } = setup();
    await controller.open('missing');
    expect(controller.getSnapshot()).toMatchObject({ bookId: null, status: 'idle' });
  });

  it('clamps a saved position that is beyond the last part', async () => {
    const { controller, library } = setup();
    library.insert(makeBook('b1', ['stored', 'stored'], { position: 9 }));
    await controller.open('b1');
    expect(controller.getSnapshot().index).toBe(1);
  });

  it('notifies subscribers on every change and stops after unsubscribe', async () => {
    const { controller, library } = setup();
    library.insert(makeBook('b1', ['stored', 'stored']));
    let calls = 0;
    const unsubscribe = controller.subscribe(() => {
      calls += 1;
    });
    await controller.open('b1');
    expect(calls).toBeGreaterThan(0);

    unsubscribe();
    const before = calls;
    await controller.play();
    expect(calls).toBe(before);
  });

  it('does not write the same saved position again', async () => {
    const { controller, library } = setup();
    library.insert(makeBook('b1', ['stored', 'stored'], { position: 1 }));
    const update = jest.spyOn(library, 'update');
    await controller.open('b1');
    await controller.open('b1');
    expect(update).not.toHaveBeenCalled();
  });

  it('dispose stops reacting to player events', async () => {
    const { controller, library, player } = setup();
    library.insert(makeBook('b1', ['stored', 'stored']));
    await controller.open('b1');
    await controller.play();
    controller.dispose();
    player.finish();
    await settle();
    expect(controller.getSnapshot().index).toBe(0);
  });
});

describe('PlaybackController: control edge cases', () => {
  it('ignores play while the part is already playing', async () => {
    const { controller, library, player } = setup();
    library.insert(makeBook('b1', ['stored']));
    await controller.open('b1');
    await controller.play();
    const before = player.events.length;
    await controller.play();
    expect(player.events.length).toBe(before);
    expect(controller.getSnapshot().status).toBe('playing');
  });

  it('does nothing on play or repeat when no book is open', async () => {
    const { controller, player } = setup();
    await controller.play();
    await controller.repeat();
    expect(controller.getSnapshot().status).toBe('idle');
    expect(player.events).toEqual([]);
  });

  it('keeps waiting when play is pressed before the part is on the device', async () => {
    const { controller, library, player } = setup();
    library.insert(makeBook('b1', ['pending']));
    await controller.open('b1');
    await controller.play();
    expect(controller.getSnapshot()).toMatchObject({ status: 'waiting', waitingReason: 'downloading' });
    expect(player.loadedUris()).toEqual([]);
  });

  it('reloads a part after a load failure when repeat is pressed', async () => {
    const { controller, library, player } = setup();
    library.insert(makeBook('b1', ['stored']));
    player.failLoad = true;
    await controller.open('b1');
    expect(controller.getSnapshot().status).toBe('error');

    player.failLoad = false;
    await controller.repeat();
    expect(controller.getSnapshot()).toMatchObject({ status: 'playing', index: 0 });
  });

  it('ignores goTo for the part that is already current', async () => {
    const { controller, library, player } = setup();
    library.insert(makeBook('b1', ['stored', 'stored']));
    await controller.open('b1');
    await controller.play();
    const before = player.events.length;
    await controller.goTo(0);
    expect(player.events.length).toBe(before);
  });

  it('updates the waiting reason when a book fails while it has no parts yet', async () => {
    const { controller, library } = setup();
    library.insert(makeBook('b1', [], { status: 'processing', totalChunks: 0 }));
    await controller.open('b1');
    expect(controller.getSnapshot().waitingReason).toBe('processing');

    library.update('b1', (draft) => {
      draft.status = 'failed';
    });
    await controller.notifyLibraryChanged();
    expect(controller.getSnapshot()).toMatchObject({ status: 'waiting', waitingReason: 'missing' });
  });

  it('does not move on a book that has no parts yet', async () => {
    const { controller, library, player } = setup();
    library.insert(makeBook('b1', [], { status: 'processing', totalChunks: 0 }));
    await controller.open('b1');
    await controller.next();
    expect(controller.getSnapshot()).toMatchObject({ status: 'waiting', index: 0 });
    expect(player.loadedUris()).toEqual([]);
  });

  it('becomes idle when the book is removed just before a skip', async () => {
    const { controller, library, player } = setup();
    library.insert(makeBook('b1', ['stored', 'stored']));
    await controller.open('b1');
    await controller.play();
    library.remove('b1');
    await controller.next();
    expect(controller.getSnapshot()).toMatchObject({ bookId: null, status: 'idle' });
    expect(player.playing).toBe(false);
  });

  it('shows the playback error when the player fails during a control', async () => {
    const { controller, library, player } = setup();
    library.insert(makeBook('b1', ['stored', 'stored']));
    await controller.open('b1');
    await controller.play();
    player.pause = () => Promise.reject(new Error('audio session lost'));
    await controller.pause();
    expect(controller.getSnapshot()).toMatchObject({
      status: 'error',
      error: 'This part could not be played. Try again, or skip to the next part.',
    });
  });
});
