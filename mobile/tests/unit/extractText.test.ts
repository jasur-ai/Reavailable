import JSZip from 'jszip';
import {
  decodeXmlEntities,
  DocumentTextError,
  docxParagraphsToText,
  documentKind,
  extractDocumentText,
  normalizeWhitespace,
  titleFromFileName,
} from '../../src/core/documents/extractText';

const enc = (text: string) => new TextEncoder().encode(text);

describe('document kinds and titles', () => {
  it('recognises the supported extensions case-insensitively', () => {
    expect(documentKind('Kitob.TXT')).toBe('txt');
    expect(documentKind('a.md')).toBe('md');
    expect(documentKind('b.docx')).toBe('docx');
    expect(documentKind('c.PDF')).toBe('pdf');
    expect(documentKind('old.doc')).toBeNull();
  });

  it('uses the file name without extension as the title', () => {
    expect(titleFromFileName('1-bob. Kirish.docx')).toBe('1-bob. Kirish');
  });
});

describe('plain text', () => {
  it('decodes UTF-8 with Uzbek letters and drops a byte-order mark', async () => {
    const text = await extractDocumentText('txt', enc('\uFEFFO‘zbekcha matn: g‘oya, qiyin.'));
    expect(text).toBe('O‘zbekcha matn: g‘oya, qiyin.');
  });

  it('normalises line endings and blank lines', () => {
    expect(normalizeWhitespace('a\r\nb\r\n\r\n\r\n\r\nc   d\t e ')).toBe('a\nb\n\nc d e');
  });

  it('rejects a file that has no text at all', async () => {
    await expect(extractDocumentText('md', enc('   \n\n  '))).rejects.toMatchObject({ code: 'no_text' });
  });

  it('rejects files over 15 MB', async () => {
    const big = new Uint8Array(15 * 1024 * 1024 + 1);
    await expect(extractDocumentText('txt', big)).rejects.toBeInstanceOf(DocumentTextError);
  });
});

describe('docx', () => {
  it('decodes XML entities', () => {
    expect(decodeXmlEntities('Tom &amp; Jerry &lt;3 &#1059;&#x27; &quot;x&quot;')).toBe('Tom & Jerry <3 У\' "x"');
  });

  it('keeps one line per paragraph and joins the runs inside it', () => {
    const xml =
      '<w:document><w:body>' +
      '<w:p><w:r><w:t>Birinchi </w:t></w:r><w:r><w:t xml:space="preserve">gap.</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>Ikkinchi</w:t><w:tab/><w:t>qator</w:t></w:r></w:p>' +
      '<w:p/>' +
      '</w:body></w:document>';
    expect(docxParagraphsToText(xml)).toBe('Birinchi gap.\nIkkinchi qator\n');
  });

  it('reads word/document.xml from a real .docx container', async () => {
    const zip = new JSZip();
    zip.file(
      'word/document.xml',
      '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>Salom, dunyo!</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Bu DOCX sinovi.</w:t></w:r></w:p></w:body></w:document>',
    );
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const text = await extractDocumentText('docx', bytes);
    expect(text).toBe('Salom, dunyo!\nBu DOCX sinovi.');
  });

  it('reports a damaged .docx as unreadable', async () => {
    await expect(extractDocumentText('docx', enc('not a zip'))).rejects.toMatchObject({ code: 'unreadable' });
  });
});

