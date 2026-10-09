/**
 * Secrets live in the platform keystore (iOS Keychain / Android Keystore), never in the library file.
 */

import * as SecureStore from 'expo-secure-store';
import type { TokenVault } from '../../core/library/ports';

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

const TOKEN_PREFIX = 'book-token-';
const SERVER_KEY_NAME = 'server-api-key';

/** Per-book access tokens. The key is derived from the book id, which only contains [a-z0-9-]. */
export function createTokenVault(): TokenVault {
  const keyFor = (bookId: string): string => `${TOKEN_PREFIX}${bookId}`;
  return {
    save: (bookId, token) => SecureStore.setItemAsync(keyFor(bookId), token, OPTIONS),
    load: (bookId) => SecureStore.getItemAsync(keyFor(bookId), OPTIONS),
    remove: (bookId) => SecureStore.deleteItemAsync(keyFor(bookId), OPTIONS),
  };
}

/** Optional server access key that the user enters in Settings (needed when the server requires one). */
export const serverKeyStore = {
  load: (): Promise<string | null> => SecureStore.getItemAsync(SERVER_KEY_NAME, OPTIONS),
  save: (value: string): Promise<void> => SecureStore.setItemAsync(SERVER_KEY_NAME, value, OPTIONS),
  remove: (): Promise<void> => SecureStore.deleteItemAsync(SERVER_KEY_NAME, OPTIONS),
};
