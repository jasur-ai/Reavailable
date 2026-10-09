/** File naming for stored audio chunks. */

export type AudioExtension = 'mp3' | 'wav' | 'ogg';

export function extensionFor(contentType: string): AudioExtension {
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (type === 'audio/wav' || type === 'audio/x-wav' || type === 'audio/wave') {
    return 'wav';
  }
  if (type === 'audio/ogg') {
    return 'ogg';
  }
  return 'mp3';
}

/** Relative path of a chunk inside the audio store, for example "<bookId>/000003.mp3". */
export function chunkRelativePath(bookId: string, index: number, contentType: string): string {
  return `${bookId}/${String(index).padStart(6, '0')}.${extensionFor(contentType)}`;
}
