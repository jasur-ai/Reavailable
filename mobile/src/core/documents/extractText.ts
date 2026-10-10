/**
 * Turns an uploaded document into plain text for the transcript field.
 *
 * Supported: .txt, .md (UTF-8), .docx (Word Open XML) and .pdf (text-based PDFs). Legacy binary .doc
 * files cannot be read reliably on a phone, so the user is asked to save them as .docx or .pdf.
 * Scanned PDFs without a text layer produce no text and are reported as such.
 */

import JSZip from 'jszip';

export type DocumentKind = 'txt' | 'md' | 'docx' | 'pdf';

export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;

export class DocumentTextError extends Error {
  constructor(
    readonly code: 'unsupported_type' | 'too_large' | 'no_text' | 'unreadable',
    message: string,
  ) {
    super(message);
    this.name = 'DocumentTextError';
  }
}

export function documentKind(fileName: string): DocumentKind | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.txt')) return 'txt';
  if (lower.endsWith('.md')) return 'md';
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.pdf')) return 'pdf';
  return null;
}

/** Removes a file extension of a supported type, for use as a default book title. */
export function titleFromFileName(fileName: string): string {
  return fileName.replace(/\.(txt|md|docx|pdf)$/i, '').trim();
}

export async function extractDocumentText(kind: DocumentKind, bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
    throw new DocumentTextError('too_large', 'The file is larger than 15 MB. Split it into several books.');
  }
  let text: string;
  if (kind === 'txt' || kind === 'md') {
    text = decodeUtf8(bytes);
  } else if (kind === 'docx') {
    text = await docxText(bytes);
  } else {
    text = await pdfText(bytes);
  }
  const cleaned = normalizeWhitespace(text);
  if (cleaned.length === 0) {
    throw new DocumentTextError('no_text', 'No text was found in this file. Scanned pages need a text version.');
  }
  return cleaned;
}

export function decodeUtf8(bytes: Uint8Array): string {
  const decoded = new TextDecoder('utf-8').decode(bytes);
  // Remove a byte-order mark if present.
  return decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded;
}

export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (match, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(parseInt(entity.slice(1), 10));
    return XML_ENTITIES[entity] ?? match;
  });
}

/** Extracts paragraphs from the body of a .docx file (word/document.xml). */
export function docxParagraphsToText(documentXml: string): string {
  const paragraphs = documentXml.split(/<\/w:p>/);
  const lines = paragraphs.map((paragraph) => {
    let line = '';
    const tokens = paragraph.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g);
    for (const token of tokens) {
      if (token[0] === '<w:tab/>') line += ' ';
      else if (token[0] === '<w:br/>') line += '\n';
      else line += decodeXmlEntities(token[1] ?? '');
    }
    return line;
  });
  return lines.join('\n');
}

async function docxText(bytes: Uint8Array): Promise<string> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new DocumentTextError('unreadable', 'This .docx file could not be opened. Try saving it again from Word.');
  }
  const entry = zip.file('word/document.xml');
  if (!entry) {
    throw new DocumentTextError('unreadable', 'This .docx file has no document body.');
  }
  return docxParagraphsToText(await entry.async('string'));
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  // Loaded lazily so the rest of the app does not pay for the PDF engine at start-up.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // Hermes has no dynamic import of a computed worker path, so the worker is handed to pdf.js directly.
  // pdf.js checks globalThis.pdfjsWorker before it tries to load a worker file.
  const worker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
  (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
  let document: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>;
  try {
    document = await pdfjs.getDocument({
      data: bytes.slice(),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
    }).promise;
  } catch {
    throw new DocumentTextError('unreadable', 'This PDF could not be opened. It may be damaged or password-protected.');
  }
  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    let pageText = '';
    for (const item of content.items) {
      if (!('str' in item)) continue;
      pageText += item.str;
      pageText += item.hasEOL ? '\n' : ' ';
    }
    pages.push(pageText);
    page.cleanup();
  }
  await document.destroy();
  return pages.join('\n\n');
}
