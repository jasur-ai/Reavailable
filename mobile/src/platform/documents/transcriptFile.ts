/**
 * Reads a UTF-8 transcript from a .txt or .md file chosen by the user.
 */

import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';

export const MAX_TRANSCRIPT_FILE_BYTES = 1_000_000;
const ALLOWED_EXTENSIONS = ['.txt', '.md'];

export interface PickedTranscript {
  name: string;
  text: string;
}

/** Machine codes let the UI render the wording in the interface language. */
export type TranscriptFileErrorCode = 'file_wrong_type' | 'file_too_large';

export class TranscriptFileError extends Error {
  constructor(readonly code: TranscriptFileErrorCode, message: string) {
    super(message);
    this.name = 'TranscriptFileError';
  }
}

export async function pickTranscriptFile(): Promise<PickedTranscript | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: ['text/plain', 'text/markdown', 'text/*', 'application/octet-stream'],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled || result.assets.length === 0) {
    return null;
  }
  const asset = result.assets[0];
  const lowerName = asset.name.toLowerCase();
  if (!ALLOWED_EXTENSIONS.some((extension) => lowerName.endsWith(extension))) {
    throw new TranscriptFileError('file_wrong_type', 'Choose a .txt or .md file.');
  }
  if (asset.size !== undefined && asset.size > MAX_TRANSCRIPT_FILE_BYTES) {
    throw new TranscriptFileError('file_too_large', 'The file is larger than 1 MB. Split it into several books.');
  }
  const text = await new File(asset.uri).text();
  // Remove a UTF-8 byte-order mark if present.
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return { name: asset.name.replace(/\.(txt|md)$/i, ''), text: withoutBom };
}
