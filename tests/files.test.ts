import { strToU8, zipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSanitizedFile,
  DEFAULT_MAX_FILE_SELECTION_BYTES,
  DEFAULT_MAX_FILE_SELECTION_COUNT,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  getFileSelectionLimitMessage,
  getFileExtension,
  getSupportedFileFormat,
  scanLocalFile,
  SUPPORTED_TEXT_EXTENSIONS,
} from '../src/files';
import { scanText } from '../src/scanner';

const githubToken = 'ghp_1234567890abcdefghijklmnopqrstuvwxyz';

function makeFile(
  contents: Array<string | Uint8Array<ArrayBufferLike>>,
  name: string,
  type = 'application/octet-stream',
): File {
  const fileParts = contents.map<BlobPart>((content) =>
    typeof content === 'string' ? content : new Uint8Array(content).buffer,
  );
  return new File(fileParts, name, { type, lastModified: 1_700_000_000_000 });
}

function readBlobText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return blob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Blob read failed.'));
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.readAsText(blob);
  });
}

function escapePdfString(text: string): string {
  return text.replace(/([\\()])/g, '\\$1');
}

function createPdf(text: string): Uint8Array {
  const stream = `BT\n/F1 12 Tf\n72 720 Td\n(${escapePdfString(text)}) Tj\nET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${new TextEncoder().encode(stream).length} >>\nstream\n${stream}\nendstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(new TextEncoder().encode(pdf).length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = new TextEncoder().encode(pdf).length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

function createDocx(text: string, extraParts: Record<string, string> = {}): Uint8Array {
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>
    </w:document>`;
  const entries: Record<string, Uint8Array> = {
    'word/document.xml': strToU8(xml),
  };
  for (const [name, value] of Object.entries(extraParts)) entries[name] = strToU8(value);
  return zipSync(entries);
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'browser');
});

describe('file support classification', () => {
  it('bounds multi-file selection count and aggregate bytes before extraction', () => {
    const tooMany = Array.from(
      { length: DEFAULT_MAX_FILE_SELECTION_COUNT + 1 },
      () => ({ size: 1 }),
    );
    expect(getFileSelectionLimitMessage(tooMany)).toContain('at most 10 files');
    expect(getFileSelectionLimitMessage([
      { size: DEFAULT_MAX_FILE_SELECTION_BYTES },
      { size: 1 },
    ])).toContain('25 MB combined');
    expect(getFileSelectionLimitMessage([{ size: 1 }, { size: 2 }])).toBeNull();
  });

  it('supports the requested text, data, environment, and source extensions', () => {
    expect(SUPPORTED_TEXT_EXTENSIONS).toEqual([
      '.txt', '.md', '.csv', '.json', '.yaml', '.yml', '.xml', '.env', '.log',
      '.py', '.js', '.ts', '.tsx', '.jsx', '.java', '.go', '.rs', '.php', '.rb',
      '.cs', '.cpp', '.c', '.h', '.sh', '.ps1', '.sql',
    ]);
    for (const extension of SUPPORTED_TEXT_EXTENSIONS) {
      expect(getSupportedFileFormat(makeFile([''], `sample${extension}`))).toBe('text');
    }
  });

  it('handles extensions case-insensitively and recognizes common .env variants', () => {
    expect(getFileExtension('REPORT.PDF')).toBe('.pdf');
    expect(getFileExtension('.env.local')).toBe('.env');
    expect(getSupportedFileFormat(makeFile([''], '.env.production'))).toBe('text');
  });

  it('recognizes PDF and DOCX while rejecting unknown and archive extensions', () => {
    expect(getSupportedFileFormat(makeFile([''], 'report.pdf'))).toBe('pdf');
    expect(getSupportedFileFormat(makeFile([''], 'report.docx'))).toBe('docx');
    expect(getSupportedFileFormat(makeFile([''], 'archive.zip'))).toBeNull();
    expect(getSupportedFileFormat(makeFile([''], 'program.exe'))).toBeNull();
  });
});

describe('text and source scanning', () => {
  it.each([
    ['notes.txt', `Token: ${githubToken}`],
    ['config.json', JSON.stringify({ github_token: githubToken })],
    ['.env', `GITHUB_TOKEN=${githubToken}`],
    ['deploy.ts', `export const token = '${githubToken}';`],
  ])('scans supported local content in %s through the existing scanner', async (name, text) => {
    const result = await scanLocalFile(makeFile([text], name, 'text/plain'));

    expect(result).toEqual(expect.objectContaining({
      status: 'scanned',
      format: 'text',
      sanitizationAvailable: true,
    }));
    if (result.status !== 'scanned') throw new Error(result.message);
    expect(result.findings).toEqual([
      expect.objectContaining({ detector: 'githubToken', originalValue: githubToken }),
    ]);
    expect(result).not.toHaveProperty('text');
  });

  it('accepts empty text files as scanned without manufacturing a finding', async () => {
    const result = await scanLocalFile(makeFile([], 'empty.txt', 'text/plain'));
    expect(result).toEqual(expect.objectContaining({
      status: 'scanned',
      findings: [],
      extractedCharacterCount: 0,
    }));
  });

  it('fails safely when a supported text extension contains binary data', async () => {
    const result = await scanLocalFile(makeFile([new Uint8Array([0, 1, 2, 3])], 'fake.txt'));
    expect(result).toEqual(expect.objectContaining({
      status: 'unscannable',
      reason: 'unknown-binary',
      findings: [],
      sanitizationAvailable: false,
    }));
  });
});

describe('document extraction', () => {
  it('extracts and scans text from a local PDF', async () => {
    const result = await scanLocalFile(makeFile(
      [createPdf(`GITHUB_TOKEN=${githubToken}`)],
      'credentials.pdf',
      'application/pdf',
    ));

    expect(result).toEqual(expect.objectContaining({
      status: 'scanned',
      format: 'pdf',
      sanitizationAvailable: false,
    }));
    if (result.status !== 'scanned') throw new Error(result.message);
    expect(result.findings).toEqual([
      expect.objectContaining({ detector: 'githubToken', originalValue: githubToken }),
    ]);
  }, 20_000);

  it('extracts main-body, header, and footer text from a local DOCX', async () => {
    const headerXml = `<?xml version="1.0" encoding="UTF-8"?>
      <w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:p><w:r><w:t>Header</w:t></w:r></w:p>
      </w:hdr>`;
    const footerXml = `<?xml version="1.0" encoding="UTF-8"?>
      <w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:p><w:r><w:t>GITHUB_TOKEN=${githubToken}</w:t></w:r></w:p>
      </w:ftr>`;
    const result = await scanLocalFile(makeFile(
      [createDocx('Main body', {
        'word/header1.xml': headerXml,
        'word/footer1.xml': footerXml,
        'word/media/ignored.png': 'not decompressed by the extractor',
      })],
      'credentials.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ));

    expect(result).toEqual(expect.objectContaining({
      status: 'scanned',
      format: 'docx',
      sanitizationAvailable: false,
    }));
    if (result.status !== 'scanned') throw new Error(result.message);
    expect(result.findings).toEqual([
      expect.objectContaining({ detector: 'githubToken', originalValue: githubToken }),
    ]);
  });

  it('does not claim an image-only or blank document was scanned', async () => {
    const result = await scanLocalFile(makeFile([createPdf('')], 'blank.pdf', 'application/pdf'));
    expect(result).toEqual(expect.objectContaining({
      status: 'unscannable',
      reason: 'no-extractable-text',
    }));
  }, 20_000);

  it('reports encrypted PDF and DOCX containers without attempting to scan them', async () => {
    const encryptedPdf = makeFile(
      ['%PDF-1.7\n1 0 obj\n<< /Encrypt 2 0 R >>\nendobj\n%%EOF'],
      'locked.pdf',
      'application/pdf',
    );
    const encryptedDocx = makeFile([
      new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]),
    ], 'locked.docx');

    await expect(scanLocalFile(encryptedPdf)).resolves.toEqual(expect.objectContaining({
      status: 'unscannable',
      reason: 'encrypted-document',
    }));
    await expect(scanLocalFile(encryptedDocx)).resolves.toEqual(expect.objectContaining({
      status: 'unscannable',
      reason: 'encrypted-document',
    }));
  });

  it('fails safely for malformed documents', async () => {
    await expect(scanLocalFile(makeFile(['not a pdf'], 'broken.pdf'))).resolves.toEqual(
      expect.objectContaining({ status: 'unscannable', reason: 'extraction-failed' }),
    );
    await expect(scanLocalFile(makeFile(['not a zip'], 'broken.docx'))).resolves.toEqual(
      expect.objectContaining({ status: 'unscannable', reason: 'extraction-failed' }),
    );
  });
});

describe('resource and privacy boundaries', () => {
  it('rejects unsupported files without reading or labeling them safe', async () => {
    const result = await scanLocalFile(makeFile(['secret'], 'archive.zip', 'application/zip'));
    expect(result).toEqual(expect.objectContaining({
      status: 'unscannable',
      reason: 'unsupported-type',
      format: null,
      findings: [],
    }));
    if (result.status !== 'unscannable') throw new Error('Expected an unsupported file result.');
    expect(result.message).toContain('could not be scanned');
  });

  it('enforces a configurable file-size limit before extraction', async () => {
    const file = makeFile(['01234567890'], 'large.txt', 'text/plain');
    const result = await scanLocalFile(file, { maxFileSizeBytes: 10 });

    expect(DEFAULT_MAX_FILE_SIZE_BYTES).toBe(10 * 1024 * 1024);
    expect(result).toEqual(expect.objectContaining({
      status: 'unscannable',
      reason: 'file-too-large',
      message: 'This file exceeds the 10 bytes scanning limit.',
    }));
  });

  it('caps expanded text independently of compressed/input size', async () => {
    const result = await scanLocalFile(makeFile(['abcdefghijk'], 'small.txt'), {
      maxExtractedCharacters: 10,
    });
    expect(result).toEqual(expect.objectContaining({
      status: 'unscannable',
      reason: 'extraction-limit-exceeded',
    }));
  });

  it('never writes file content or findings to extension storage', async () => {
    const set = vi.fn();
    Object.defineProperty(globalThis, 'browser', {
      configurable: true,
      value: { storage: { local: { set } } },
    });

    await scanLocalFile(makeFile([`GITHUB_TOKEN=${githubToken}`], 'secret.env'));
    expect(set).not.toHaveBeenCalled();
  });
});

describe('in-memory sanitized copies', () => {
  it.each(['redact', 'replace-safe'] as const)(
    'creates a separate %s copy without any detected original values',
    async (mode) => {
      const originalText = `GITHUB_TOKEN=${githubToken}\nRepeat: ${githubToken}`;
      const original = makeFile([originalText], 'credentials.env', 'text/plain');
      const result = await createSanitizedFile(original, mode);

      expect(result.status).toBe('created');
      if (result.status !== 'created') throw new Error(result.message);
      const sanitizedText = await readBlobText(result.file);
      expect(result.file).not.toBe(original);
      expect(result.file.name).toBe('credentials.presend-sanitized.env');
      expect(sanitizedText).not.toContain(githubToken);
      expect(await readBlobText(original)).toBe(originalText);
      if (mode === 'replace-safe') expect(scanText(sanitizedText)).toEqual([]);
    },
  );

  it('does not offer structurally unsafe PDF or DOCX rewriting', async () => {
    const result = await createSanitizedFile(
      makeFile([createPdf(githubToken)], 'credentials.pdf', 'application/pdf'),
      'redact',
    );
    expect(result).toEqual(expect.objectContaining({
      status: 'unscannable',
      format: 'pdf',
      reason: 'sanitization-unavailable',
      sanitizationAvailable: false,
    }));
  });

  it('keeps environment variants recognizable when naming sanitized copies', async () => {
    const result = await createSanitizedFile(
      makeFile([`GITHUB_TOKEN=${githubToken}`], '.env.local', 'text/plain'),
      'replace-safe',
    );
    expect(result.status).toBe('created');
    if (result.status !== 'created') throw new Error(result.message);
    expect(result.file.name).toBe('.env.local.presend-sanitized.env');
  });
});
