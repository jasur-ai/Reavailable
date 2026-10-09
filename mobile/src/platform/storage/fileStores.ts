/**
 * On-device storage: audio chunks and the library document.
 *
 * Audio lives under the app's documents directory (not the cache directory, which the OS may clear).
 * Writes are atomic: a chunk is written to "<name>.part" and then moved into place, so a crash never
 * leaves a half-written chunk under its final name.
 */

import { Directory, File, Paths } from 'expo-file-system';
import type { AudioStore, LibraryPersistence } from '../../core/library/ports';
import type { LibraryData } from '../../core/types';

const AUDIO_DIRECTORY = 'audio';
const LIBRARY_FILE = 'library.json';
const LIBRARY_TEMP_FILE = 'library.json.tmp';
const LIBRARY_BACKUP_FILE = 'library.corrupt.json';

export function createAudioStore(root: Directory = new Directory(Paths.document, AUDIO_DIRECTORY)): AudioStore {
  return {
    async write(relativePath: string, data: Uint8Array): Promise<void> {
      const partial = new File(root, `${relativePath}.part`);
      partial.create({ intermediates: true, overwrite: true });
      partial.write(data);
      await partial.move(new File(root, relativePath), { overwrite: true });
    },

    async exists(relativePath: string): Promise<boolean> {
      return new File(root, relativePath).exists;
    },

    uri(relativePath: string): string {
      return new File(root, relativePath).uri;
    },

    async removeBook(bookId: string): Promise<void> {
      const directory = new Directory(root, bookId);
      if (directory.exists) {
        directory.delete();
      }
    },
  };
}

export function createLibraryPersistence(directory: Directory = Paths.document): LibraryPersistence {
  const file = new File(directory, LIBRARY_FILE);
  return {
    async read(): Promise<unknown> {
      if (!file.exists) {
        return null;
      }
      const text = await file.text();
      try {
        return JSON.parse(text) as LibraryData;
      } catch {
        // Keep the unreadable file for diagnosis instead of overwriting it silently.
        const backup = new File(directory, LIBRARY_BACKUP_FILE);
        await file.move(backup, { overwrite: true });
        return null;
      }
    },

    async write(data: LibraryData): Promise<void> {
      const temp = new File(directory, LIBRARY_TEMP_FILE);
      temp.create({ intermediates: true, overwrite: true });
      temp.write(JSON.stringify(data));
      await temp.move(file, { overwrite: true });
    },
  };
}
