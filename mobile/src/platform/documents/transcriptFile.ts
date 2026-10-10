/**
 * Lets the user pick a document (.txt, .md, .docx, .pdf) and returns its plain text.
 */

import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import {
  DocumentTextError,
  documentKind,
  extractDocumentText,
  titleFromFileName,
} from '../../core/documents/extractText';

export interface PickedTranscript {
  name: string;
  text: string;
}

/** Machine codes let the UI render the wording in the interface language. */
export type TranscriptFileErrorCode = DocumentTextError['code'] | 'cancelled';

export class TranscriptFileError extends Error {
  constructor(readonly code: TranscriptFileErrorCode, message: string) {
    super(message);
    this.name = 'TranscriptFileError';
  }
}

export async function pickTranscriptFile(): Promise<PickedTranscript | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: [
      'text/plain',
      'text/markdown',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled || result.assets.length === 0) {
    return null;
  }
  const asset = result.assets[0];
  const kind = documentKind(asset.name);
  if (!kind) {
    throw new TranscriptFileError('unsupported_type', 'Choose a .txt, .md, .docx or .pdf file.');
  }
  try {
    const bytes = new Uint8Array(await new File(asset.uri).arrayBuffer());
    const text = await extractDocumentText(kind, bytes);
    return { name: titleFromFileName(asset.name), text };
  } catch (error) {
    if (error instanceof DocumentTextError) {
      throw new TranscriptFileError(error.code, error.message);
    }
    // Anything else (for example a native file error) is still reported, with its own text as detail.
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new TranscriptFileError('unreadable', detail);
  }
}
