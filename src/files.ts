import { unzipSync } from 'fflate';
import { debugLog } from './config';
import { redactText, replaceWithSafeExamples } from './redaction';
import { scanText } from './scanner';
import type { Finding } from './types';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';

export const DEFAULT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_EXTRACTED_CHARACTERS = 2_000_000;
export const DEFAULT_MAX_PDF_PAGES = 500;
export const DEFAULT_MAX_FILE_SELECTION_COUNT = 10;
export const DEFAULT_MAX_FILE_SELECTION_BYTES = 25 * 1024 * 1024;

export const SUPPORTED_TEXT_EXTENSIONS = [
  '.txt', '.md', '.csv', '.json', '.yaml', '.yml', '.xml', '.env', '.log',
  '.py', '.js', '.ts', '.tsx', '.jsx', '.java', '.go', '.rs', '.php', '.rb',
  '.cs', '.cpp', '.c', '.h', '.sh', '.ps1', '.sql',
] as const;

export type SupportedTextExtension = (typeof SUPPORTED_TEXT_EXTENSIONS)[number];
export type SupportedFileFormat = 'text' | 'pdf' | 'docx';
export type FileSanitizationMode = 'redact' | 'replace-safe';
export type FileScanFailureReason =
  | 'unsupported-type'
  | 'file-too-large'
  | 'encrypted-document'
  | 'unknown-binary'
  | 'no-extractable-text'
  | 'extraction-limit-exceeded'
  | 'extraction-failed'
  | 'sanitization-unavailable';

export interface FileScanOptions {
  maxFileSizeBytes?: number;
  maxExtractedCharacters?: number;
  maxPdfPages?: number;
  scanner?: (text: string) => Finding[];
}

interface FileResultBase {
  fileName: string;
  fileSize: number;
  extension: string | null;
  format: SupportedFileFormat | null;
}

export interface ScannedFileResult extends FileResultBase {
  status: 'scanned';
  findings: Finding[];
  extractedCharacterCount: number;
  sanitizationAvailable: boolean;
}

export interface UnscannableFileResult extends FileResultBase {
  status: 'unscannable';
  findings: [];
  sanitizationAvailable: false;
  reason: FileScanFailureReason;
  message: string;
}

export type FileScanResult = ScannedFileResult | UnscannableFileResult;

export interface SanitizedFileResult {
  status: 'created';
  file: File;
  findings: Finding[];
  mode: FileSanitizationMode;
}

export type CreateSanitizedFileResult = SanitizedFileResult | UnscannableFileResult;

export function getFileSelectionLimitMessage(
  files: ReadonlyArray<Pick<File, 'size'>>,
): string | null {
  if (files.length > DEFAULT_MAX_FILE_SELECTION_COUNT) {
    return `Select at most ${DEFAULT_MAX_FILE_SELECTION_COUNT} files at a time. File contents could not be scanned.`;
  }
  const totalBytes = files.reduce((total, file) => total + Math.max(0, file.size), 0);
  if (totalBytes > DEFAULT_MAX_FILE_SELECTION_BYTES) {
    return 'The selected files exceed the 25 MB combined scanning limit. File contents could not be scanned.';
  }
  return null;
}

interface ResolvedOptions {
  maxFileSizeBytes: number;
  maxExtractedCharacters: number;
  maxPdfPages: number;
  scanner: (text: string) => Finding[];
}

interface ExtractedFile {
  text: string;
  format: SupportedFileFormat;
}

class FileProcessingError extends Error {
  constructor(
    readonly reason: FileScanFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'FileProcessingError';
  }
}

const supportedTextExtensions = new Set<string>(SUPPORTED_TEXT_EXTENSIONS);
const docxTextPartPattern =
  /^word\/(?:document|footnotes|endnotes|comments|header\d+|footer\d+)\.xml$/i;

function positiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function resolveOptions(options: FileScanOptions): ResolvedOptions {
  return {
    maxFileSizeBytes: positiveLimit(options.maxFileSizeBytes, DEFAULT_MAX_FILE_SIZE_BYTES),
    maxExtractedCharacters: positiveLimit(
      options.maxExtractedCharacters,
      DEFAULT_MAX_EXTRACTED_CHARACTERS,
    ),
    maxPdfPages: positiveLimit(options.maxPdfPages, DEFAULT_MAX_PDF_PAGES),
    scanner: options.scanner ?? scanText,
  };
}

export function getFileExtension(fileName: string): string | null {
  const normalized = fileName.trim().toLowerCase();
  const baseName = normalized.split(/[\\/]/).at(-1) ?? normalized;
  if (/^\.env(?:\.[a-z0-9_-]+)?$/.test(baseName)) return '.env';

  const dotIndex = baseName.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === baseName.length - 1) return null;
  return baseName.slice(dotIndex);
}

export function getSupportedFileFormat(file: Pick<File, 'name' | 'type'>): SupportedFileFormat | null {
  const extension = getFileExtension(file.name);
  if (extension && supportedTextExtensions.has(extension)) return 'text';
  if (extension === '.pdf') return 'pdf';
  if (extension === '.docx') return 'docx';

  // MIME fallback is limited to extensionless files. An executable renamed by its MIME
  // provider should not silently become a supported document.
  if (!extension && file.type.toLowerCase() === 'application/pdf') return 'pdf';
  if (
    !extension &&
    file.type.toLowerCase() ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return 'docx';
  }
  return null;
}

function failureMessage(reason: FileScanFailureReason, maxFileSizeBytes: number): string {
  switch (reason) {
    case 'unsupported-type':
      return 'This file type is not supported. File contents could not be scanned.';
    case 'file-too-large':
      return `This file exceeds the ${formatBytes(maxFileSizeBytes)} scanning limit.`;
    case 'encrypted-document':
      return 'Encrypted documents cannot be scanned.';
    case 'unknown-binary':
      return 'File contents could not be scanned because the file is not readable text.';
    case 'no-extractable-text':
      return 'No extractable text was found. Image-only documents require OCR and could not be scanned.';
    case 'extraction-limit-exceeded':
      return 'The document expands to too much text to scan safely.';
    case 'extraction-failed':
      return 'PreSend could not scan this file.';
    case 'sanitization-unavailable':
      return 'A sanitized copy cannot be created safely for this document format.';
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0) {
    return `${bytes / (1024 * 1024)} MB`;
  }
  if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024} KB`;
  return `${bytes} bytes`;
}

function unscannableResult(
  file: File,
  format: SupportedFileFormat | null,
  reason: FileScanFailureReason,
  maxFileSizeBytes: number,
): UnscannableFileResult {
  return {
    status: 'unscannable',
    fileName: file.name,
    fileSize: file.size,
    extension: getFileExtension(file.name),
    format,
    findings: [],
    sanitizationAvailable: false,
    reason,
    message: failureMessage(reason, maxFileSizeBytes),
  };
}

async function readFileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') {
    return new Uint8Array(await file.arrayBuffer());
  }

  if (typeof FileReader === 'undefined') {
    throw new FileProcessingError('extraction-failed', 'FileReader is unavailable.');
  }

  return await new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new FileProcessingError('extraction-failed', 'File read failed.'));
    reader.onload = () => {
      if (!(reader.result instanceof ArrayBuffer)) {
        reject(new FileProcessingError('extraction-failed', 'File read failed.'));
        return;
      }
      resolve(new Uint8Array(reader.result));
    };
    reader.readAsArrayBuffer(file);
  });
}

function startsWithBytes(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function containsBytes(bytes: Uint8Array, needle: readonly number[]): boolean {
  if (needle.length === 0 || needle.length > bytes.length) return false;
  const lastStart = bytes.length - needle.length;
  for (let start = 0; start <= lastStart; start += 1) {
    let matches = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (bytes[start + offset] !== needle[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

function looksLikePdf(bytes: Uint8Array): boolean {
  const header = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 1024)));
  return header.includes('%PDF-');
}

function looksLikeZip(bytes: Uint8Array): boolean {
  return (
    startsWithBytes(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWithBytes(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWithBytes(bytes, [0x50, 0x4b, 0x07, 0x08])
  );
}

function looksLikeOleCompound(bytes: Uint8Array): boolean {
  return startsWithBytes(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
}

function decodeTextBytes(bytes: Uint8Array): string {
  if (startsWithBytes(bytes, [0xff, 0xfe])) {
    return new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
  }
  if (startsWithBytes(bytes, [0xfe, 0xff])) {
    return new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function extractPlainText(bytes: Uint8Array): string {
  if (looksLikePdf(bytes) || looksLikeZip(bytes) || looksLikeOleCompound(bytes)) {
    throw new FileProcessingError('unknown-binary', 'Binary content has a text-file extension.');
  }

  let text: string;
  try {
    text = decodeTextBytes(bytes);
  } catch {
    throw new FileProcessingError('unknown-binary', 'Text decoding failed.');
  }

  let suspiciousControls = 0;
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code === 0) {
      throw new FileProcessingError('unknown-binary', 'NUL bytes indicate binary content.');
    }
    if (code < 32 && code !== 9 && code !== 10 && code !== 12 && code !== 13) {
      suspiciousControls += 1;
    }
  }
  if (text.length > 0 && suspiciousControls / text.length > 0.01) {
    throw new FileProcessingError('unknown-binary', 'Too many binary control characters.');
  }
  return text;
}

function xmlText(xmlBytes: Uint8Array): string {
  let xml: string;
  try {
    xml = decodeTextBytes(xmlBytes);
  } catch {
    throw new FileProcessingError('extraction-failed', 'WordprocessingML decoding failed.');
  }

  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (
    document.getElementsByTagName('parsererror').length > 0 ||
    document.getElementsByTagNameNS('*', 'parsererror').length > 0
  ) {
    throw new FileProcessingError('extraction-failed', 'Invalid WordprocessingML.');
  }

  const output: string[] = [];
  const visit = (node: Node): void => {
    if (node.nodeType !== Node.ELEMENT_NODE) {
      for (const child of Array.from(node.childNodes)) visit(child);
      return;
    }

    const element = node as Element;
    const name = element.localName;
    if (name === 't' || name === 'instrText' || name === 'delText') {
      output.push(element.textContent ?? '');
      return;
    }
    if (name === 'tab') {
      output.push('\t');
      return;
    }
    if (name === 'br' || name === 'cr') {
      output.push('\n');
      return;
    }

    for (const child of Array.from(element.childNodes)) visit(child);
    if (name === 'tc') output.push('\t');
    if (name === 'p' || name === 'tr') output.push('\n');
  };
  visit(document.documentElement);
  return output.join('');
}

function extractDocxText(bytes: Uint8Array, maxExtractedCharacters: number): string {
  if (looksLikeOleCompound(bytes)) {
    throw new FileProcessingError(
      'encrypted-document',
      'Encrypted OOXML documents use an OLE compound container.',
    );
  }
  if (!looksLikeZip(bytes)) {
    throw new FileProcessingError('extraction-failed', 'DOCX ZIP signature is missing.');
  }

  const maxXmlBytes = Math.max(maxExtractedCharacters * 4, 1_000_000);
  let selectedXmlBytes = 0;
  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(bytes, {
      filter: (entry) => {
        const normalizedName = entry.name.replace(/^\/+/, '');
        if (!docxTextPartPattern.test(normalizedName)) return false;
        selectedXmlBytes += entry.originalSize;
        if (selectedXmlBytes > maxXmlBytes) {
          throw new FileProcessingError(
            'extraction-limit-exceeded',
            'DOCX text XML exceeds the extraction limit.',
          );
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof FileProcessingError) throw error;
    if (error instanceof Error && /encrypt|password/i.test(error.message)) {
      throw new FileProcessingError('encrypted-document', 'Encrypted DOCX package.');
    }
    throw new FileProcessingError('extraction-failed', 'DOCX extraction failed.');
  }

  const entries = Object.entries(archive)
    .filter(([name]) => docxTextPartPattern.test(name.replace(/^\/+/, '')))
    .sort(([left], [right]) => {
      if (/^\/?word\/document\.xml$/i.test(left)) return -1;
      if (/^\/?word\/document\.xml$/i.test(right)) return 1;
      return left.localeCompare(right);
    });
  if (!entries.some(([name]) => /^\/?word\/document\.xml$/i.test(name))) {
    throw new FileProcessingError('extraction-failed', 'DOCX main document part is missing.');
  }

  let text = '';
  for (const [, xmlBytes] of entries) {
    const partText = xmlText(xmlBytes);
    if (text.length + partText.length > maxExtractedCharacters) {
      throw new FileProcessingError(
        'extraction-limit-exceeded',
        'DOCX extracted text exceeds the extraction limit.',
      );
    }
    text += `${partText}\n`;
  }
  return text.trim();
}

function pdfPageText(items: Array<Record<string, unknown>>): string {
  const output: string[] = [];
  let previousEndX: number | null = null;
  let previousY: number | null = null;

  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    const transform = Array.isArray(item.transform) ? item.transform : null;
    const x = typeof transform?.[4] === 'number' ? transform[4] : null;
    const y = typeof transform?.[5] === 'number' ? transform[5] : null;
    const width = typeof item.width === 'number' ? item.width : 0;

    if (previousY !== null && y !== null && Math.abs(previousY - y) > 1) {
      output.push('\n');
      previousEndX = null;
    } else if (previousEndX !== null && x !== null && x - previousEndX > 1) {
      output.push(' ');
    }

    output.push(item.str);
    previousEndX = x === null ? null : x + width;
    previousY = y;
    if (item.hasEOL === true) {
      output.push('\n');
      previousEndX = null;
      previousY = null;
    }
  }
  return output.join('');
}

function bundledExtensionAssetUrl(assetPath: string): string {
  const extensionPath = assetPath.replace(/^\/+/, '');
  if (typeof browser !== 'undefined' && browser.runtime?.getURL) {
    const getUrl = browser.runtime.getURL as unknown as (path: string) => string;
    return getUrl(extensionPath);
  }
  return new URL(assetPath, import.meta.url).href;
}

async function extractPdfText(
  bytes: Uint8Array,
  maxExtractedCharacters: number,
  maxPdfPages: number,
): Promise<string> {
  if (!looksLikePdf(bytes)) {
    throw new FileProcessingError('extraction-failed', 'PDF signature is missing.');
  }
  if (containsBytes(bytes, [0x2f, 0x45, 0x6e, 0x63, 0x72, 0x79, 0x70, 0x74])) {
    throw new FileProcessingError('encrypted-document', 'PDF encryption dictionary is present.');
  }

  let loadingTask: PDFDocumentLoadingTask | null = null;
  let pdfDocument: PDFDocumentProxy | null = null;

  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    if (typeof Worker !== 'undefined') {
      const workerModule = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url&no-inline');
      pdfjs.GlobalWorkerOptions.workerSrc = bundledExtensionAssetUrl(workerModule.default);
    }

    loadingTask = pdfjs.getDocument({
      data: bytes.slice(),
      useWorkerFetch: false,
      useSystemFonts: true,
      useWasm: false,
    });
    pdfDocument = await loadingTask.promise;
    if (pdfDocument.numPages > maxPdfPages) {
      throw new FileProcessingError(
        'extraction-limit-exceeded',
        'PDF page count exceeds the extraction limit.',
      );
    }

    const pages: string[] = [];
    let characterCount = 0;
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = pdfPageText(content.items as unknown as Array<Record<string, unknown>>);
      characterCount += text.length + 1;
      if (characterCount > maxExtractedCharacters) {
        throw new FileProcessingError(
          'extraction-limit-exceeded',
          'PDF extracted text exceeds the extraction limit.',
        );
      }
      pages.push(text);
    }
    return pages.join('\n').trim();
  } catch (error) {
    if (error instanceof FileProcessingError) throw error;
    if (
      error instanceof Error &&
      (error.name === 'PasswordException' || /password|encrypted/i.test(error.message))
    ) {
      throw new FileProcessingError('encrypted-document', 'PDF requires a password.');
    }
    throw new FileProcessingError('extraction-failed', 'PDF extraction failed.');
  } finally {
    if (loadingTask) {
      await loadingTask.destroy().catch(() => undefined);
    }
  }
}

async function extractFile(file: File, format: SupportedFileFormat, options: ResolvedOptions): Promise<ExtractedFile> {
  const bytes = await readFileBytes(file);
  let text: string;
  if (format === 'text') {
    text = extractPlainText(bytes);
  } else if (format === 'pdf') {
    text = await extractPdfText(bytes, options.maxExtractedCharacters, options.maxPdfPages);
  } else {
    text = extractDocxText(bytes, options.maxExtractedCharacters);
  }

  if (text.length > options.maxExtractedCharacters) {
    throw new FileProcessingError(
      'extraction-limit-exceeded',
      'Extracted text exceeds the configured limit.',
    );
  }
  if (format !== 'text' && text.trim().length === 0) {
    throw new FileProcessingError('no-extractable-text', 'No extractable text was found.');
  }
  return { text, format };
}

export async function scanLocalFile(
  file: File,
  options: FileScanOptions = {},
): Promise<FileScanResult> {
  const resolved = resolveOptions(options);
  const format = getSupportedFileFormat(file);
  if (!format) {
    return unscannableResult(file, null, 'unsupported-type', resolved.maxFileSizeBytes);
  }
  if (file.size > resolved.maxFileSizeBytes) {
    return unscannableResult(file, format, 'file-too-large', resolved.maxFileSizeBytes);
  }

  try {
    const extracted = await extractFile(file, format, resolved);
    const findings = resolved.scanner(extracted.text);
    debugLog('File', `${format.toUpperCase()} extraction and scan completed`);
    return {
      status: 'scanned',
      fileName: file.name,
      fileSize: file.size,
      extension: getFileExtension(file.name),
      format,
      findings,
      extractedCharacterCount: extracted.text.length,
      sanitizationAvailable: format === 'text',
    };
  } catch (error) {
    const reason = error instanceof FileProcessingError ? error.reason : 'extraction-failed';
    debugLog('File', `File scan unavailable (${reason})`);
    return unscannableResult(file, format, reason, resolved.maxFileSizeBytes);
  }
}

function sanitizedFileName(fileName: string): string {
  const extension = getFileExtension(fileName);
  if (!extension) return `${fileName}.presend-sanitized.txt`;
  if (extension === '.env' && /^\.env(?:\.[a-z0-9_-]+)?$/i.test(fileName)) {
    return `${fileName}.presend-sanitized.env`;
  }
  return `${fileName.slice(0, -extension.length)}.presend-sanitized${extension}`;
}

export async function createSanitizedFile(
  file: File,
  mode: FileSanitizationMode,
  options: FileScanOptions = {},
): Promise<CreateSanitizedFileResult> {
  const resolved = resolveOptions(options);
  const format = getSupportedFileFormat(file);
  if (!format) {
    return unscannableResult(file, null, 'unsupported-type', resolved.maxFileSizeBytes);
  }
  if (format !== 'text') {
    return unscannableResult(
      file,
      format,
      'sanitization-unavailable',
      resolved.maxFileSizeBytes,
    );
  }
  if (file.size > resolved.maxFileSizeBytes) {
    return unscannableResult(file, format, 'file-too-large', resolved.maxFileSizeBytes);
  }

  try {
    const extracted = await extractFile(file, format, resolved);
    const findings = resolved.scanner(extracted.text);
    const sanitizedText = mode === 'redact'
      ? redactText(extracted.text, findings)
      : replaceWithSafeExamples(extracted.text, findings);
    const sanitizedFile = new File([sanitizedText], sanitizedFileName(file.name), {
      type: file.type || 'text/plain',
      lastModified: Date.now(),
    });
    return { status: 'created', file: sanitizedFile, findings, mode };
  } catch (error) {
    const reason = error instanceof FileProcessingError ? error.reason : 'extraction-failed';
    return unscannableResult(file, format, reason, resolved.maxFileSizeBytes);
  }
}
