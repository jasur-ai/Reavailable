/**
 * Ports: the interfaces the core needs from the platform. Implementations live in src/platform.
 */

import type { LibraryData } from '../types';

/** Audio files for stored chunks. Paths are relative, for example "<bookId>/000003.mp3". */
export interface AudioStore {
  write(relativePath: string, data: Uint8Array): Promise<void>;
  exists(relativePath: string): Promise<boolean>;
  uri(relativePath: string): string;
  removeBook(bookId: string): Promise<void>;
}

/** Per-book access tokens. Tokens are secrets and must not be stored with the library data. */
export interface TokenVault {
  save(bookId: string, token: string): Promise<void>;
  load(bookId: string): Promise<string | null>;
  remove(bookId: string): Promise<void>;
}

/** Durable storage for the library document (books, chunk states, settings). */
export interface LibraryPersistence {
  read(): Promise<unknown>;
  write(data: LibraryData): Promise<void>;
}

/** SHA-256 of the bytes, as lower-case hex. */
export type Hasher = (bytes: Uint8Array) => Promise<string>;
