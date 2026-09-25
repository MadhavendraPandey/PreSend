import { browser } from 'wxt/browser';
import { debugLog } from './config';
import type { Finding } from './types';

export const SEMANTIC_LABELS = [
  'confidential_business',
  'customer_confidential',
  'employee_sensitive',
  'financial_internal',
  'unreleased_product',
  'internal_security',
  'legal_confidential',
  'proprietary_technical',
] as const;

export type SemanticLabel = typeof SEMANTIC_LABELS[number];

interface TokenizerJson {
  model: {
    vocab: Record<string, number>;
    unk_token: string;
    continuing_subword_prefix?: string;
    max_input_chars_per_word?: number;
  };
}

interface ClassifierJson {
  labels: SemanticLabel[];
  coefficients: number[][];
  intercepts: number[];
  thresholds: number[];
}

interface OffsetToken {
  id: number;
  start: number;
  end: number;
}

export interface SemanticChunk {
  inputIds: number[];
  attentionMask: number[];
  startIndex: number;
  endIndex: number;
}

interface SemanticRuntime {
  tokenizer: TokenizerJson;
  classifier: ClassifierJson;
  embed: (chunks: SemanticChunk[]) => Promise<number[][]>;
}

interface SemanticPrediction {
  label: SemanticLabel;
  confidence: number;
  startIndex: number;
  endIndex: number;
}

const labelDetails: Record<SemanticLabel, { category: string; explanation: string; safe: string }> = {
  confidential_business: {
    category: 'Business-sensitive information',
    explanation: 'This passage may describe non-public business activity. Semantic detection is probabilistic; review it before sending.',
    safe: 'Replace this passage with a public, non-sensitive business summary.',
  },
  customer_confidential: {
    category: 'Customer-specific information',
    explanation: 'This passage may contain customer-specific operational or commercial details. Semantic detection is probabilistic; review it before sending.',
    safe: 'Replace this passage with a fictional, non-identifying customer example.',
  },
  employee_sensitive: {
    category: 'Employee-sensitive information',
    explanation: 'This passage may contain sensitive employee information. Semantic detection is probabilistic; review it before sending.',
    safe: 'Replace this passage with a generic, non-identifying employee example.',
  },
  financial_internal: {
    category: 'Non-public financial information',
    explanation: 'This passage may contain non-public financial information. Semantic detection is probabilistic; review it before sending.',
    safe: 'Replace this passage with public or fictional financial figures.',
  },
  unreleased_product: {
    category: 'Unreleased product information',
    explanation: 'This passage may discuss a product or feature that has not been released. Semantic detection is probabilistic; review it before sending.',
    safe: 'Replace this passage with information about an already public feature.',
  },
  internal_security: {
    category: 'Security-sensitive information',
    explanation: 'This passage may reveal security operations, controls, or weaknesses. Semantic detection is probabilistic; review it before sending.',
    safe: 'Replace this passage with a general security best-practice example.',
  },
  legal_confidential: {
    category: 'Legal-sensitive information',
    explanation: 'This passage may contain non-public legal or contractual information. Semantic detection is probabilistic; review it before sending.',
    safe: 'Replace this passage with a public, generic legal example.',
  },
  proprietary_technical: {
    category: 'Proprietary technical information',
    explanation: 'This passage may describe non-public implementation details. Semantic detection is probabilistic; review it before sending.',
    safe: 'Replace this passage with a public, generic technical example.',
  },
};

let runtimePromise: Promise<SemanticRuntime> | null = null;
let loggedSemanticFailure = false;

export const SEMANTIC_RUNTIME_ASSETS = {
  module: 'semantic/ort/ort-wasm-simd-threaded.mjs',
  wasm: 'semantic/ort/ort-wasm-simd-threaded.wasm',
} as const;

function safeSemanticFailureReason(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.replace(/[\r\n]+/g, ' ').slice(0, 240);
    return `${error.name}: ${message}`;
  }
  return 'Unknown semantic runtime error';
}

function extensionAssetUrl(path: string): string {
  return browser.runtime.getURL(path as never);
}

export function getSemanticWasmPaths(
  getUrl: (path: string) => string = extensionAssetUrl,
): { mjs: string; wasm: string } {
  return {
    mjs: getUrl(SEMANTIC_RUNTIME_ASSETS.module),
    wasm: getUrl(SEMANTIC_RUNTIME_ASSETS.wasm),
  };
}

function isChineseCharacter(codePoint: number): boolean {
  return (
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0x20000 && codePoint <= 0x2a6df) ||
    (codePoint >= 0x2a700 && codePoint <= 0x2b73f) ||
    (codePoint >= 0x2b740 && codePoint <= 0x2b81f) ||
    (codePoint >= 0x2b820 && codePoint <= 0x2ceaf) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff)
  );
}

function isControlCharacter(character: string): boolean {
  if (character === '\t' || character === '\n' || character === '\r') return false;
  return /\p{Cc}|\p{Cf}/u.test(character);
}

function basicSegments(text: string): Array<{ value: string; start: number; end: number }> {
  const cleaned = Array.from(text, (character) => isControlCharacter(character) ? ' ' : character)
    .join('');
  const segments: Array<{ value: string; start: number; end: number }> = [];
  const wordPattern = /[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu;
  for (const match of cleaned.matchAll(wordPattern)) {
    const start = match.index;
    const raw = match[0];
    if (start === undefined || !raw) continue;
    let cursor = start;
    let buffered = '';
    let bufferStart = start;
    const flush = () => {
      if (!buffered) return;
      segments.push({ value: buffered, start: bufferStart, end: cursor });
      buffered = '';
    };
    for (const character of raw) {
      const width = character.length;
      if (isChineseCharacter(character.codePointAt(0) ?? 0)) {
        flush();
        segments.push({ value: character, start: cursor, end: cursor + width });
        cursor += width;
        bufferStart = cursor;
      } else {
        if (!buffered) bufferStart = cursor;
        buffered += character;
        cursor += width;
      }
    }
    flush();
  }
  return segments;
}

function normalizeToken(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

function wordPieceTokens(text: string, tokenizer: TokenizerJson): OffsetToken[] {
  const vocab = tokenizer.model.vocab;
  const unknownId = vocab[tokenizer.model.unk_token];
  const continuation = tokenizer.model.continuing_subword_prefix ?? '##';
  const maxCharacters = tokenizer.model.max_input_chars_per_word ?? 100;
  if (unknownId === undefined) throw new Error('Semantic tokenizer is missing its unknown token');

  const output: OffsetToken[] = [];
  for (const segment of basicSegments(text)) {
    const token = normalizeToken(segment.value);
    if (!token) continue;
    if (Array.from(token).length > maxCharacters) {
      output.push({ id: unknownId, start: segment.start, end: segment.end });
      continue;
    }

    let cursor = 0;
    const pieces: number[] = [];
    let failed = false;
    while (cursor < token.length) {
      let end = token.length;
      let pieceId: number | undefined;
      while (end > cursor) {
        const candidate = `${cursor === 0 ? '' : continuation}${token.slice(cursor, end)}`;
        pieceId = vocab[candidate];
        if (pieceId !== undefined) break;
        end -= 1;
      }
      if (pieceId === undefined) {
        failed = true;
        break;
      }
      pieces.push(pieceId);
      cursor = end;
    }
    if (failed) {
      output.push({ id: unknownId, start: segment.start, end: segment.end });
    } else {
      for (const id of pieces) output.push({ id, start: segment.start, end: segment.end });
    }
  }
  return output;
}

export function buildSemanticChunks(
  text: string,
  tokenizer: TokenizerJson,
  maxTokens = 128,
  overlapTokens = 24,
): SemanticChunk[] {
  if (maxTokens < 4) throw new Error('Semantic max token length is too small');
  const clsId = tokenizer.model.vocab['[CLS]'];
  const sepId = tokenizer.model.vocab['[SEP]'];
  if (clsId === undefined || sepId === undefined) {
    throw new Error('Semantic tokenizer is missing boundary tokens');
  }
  const tokens = wordPieceTokens(text, tokenizer);
  if (tokens.length === 0) return [];

  const contentLimit = maxTokens - 2;
  const overlap = Math.max(0, Math.min(overlapTokens, contentLimit - 1));
  const chunks: SemanticChunk[] = [];
  let start = 0;
  while (start < tokens.length) {
    const end = Math.min(tokens.length, start + contentLimit);
    const content = tokens.slice(start, end);
    const inputIds = [clsId, ...content.map((token) => token.id), sepId];
    chunks.push({
      inputIds,
      attentionMask: inputIds.map(() => 1),
      startIndex: content[0]?.start ?? 0,
      endIndex: content[content.length - 1]?.end ?? text.length,
    });
    if (end === tokens.length) break;
    start = end - overlap;
  }
  return chunks;
}

function sigmoid(value: number): number {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exponential = Math.exp(value);
  return exponential / (1 + exponential);
}

export function classifyEmbeddings(
  chunks: SemanticChunk[],
  embeddings: number[][],
  classifier: ClassifierJson,
): SemanticPrediction[] {
  const predictions: SemanticPrediction[] = [];
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const chunk = chunks[chunkIndex];
    const embedding = embeddings[chunkIndex];
    if (!chunk || !embedding || embedding.length !== 384) {
      throw new Error('Semantic encoder returned an unexpected embedding');
    }
    for (let labelIndex = 0; labelIndex < classifier.labels.length; labelIndex += 1) {
      const coefficients = classifier.coefficients[labelIndex];
      const intercept = classifier.intercepts[labelIndex];
      const threshold = classifier.thresholds[labelIndex];
      if (!coefficients || intercept === undefined || threshold === undefined) {
        throw new Error('Semantic classifier artifact is incomplete');
      }
      let logit = intercept;
      for (let feature = 0; feature < embedding.length; feature += 1) {
        logit += embedding[feature]! * coefficients[feature]!;
      }
      const confidence = sigmoid(logit);
      if (confidence >= threshold) {
        predictions.push({
          label: classifier.labels[labelIndex]!,
          confidence,
          startIndex: chunk.startIndex,
          endIndex: chunk.endIndex,
        });
      }
    }
  }
  return predictions;
}

function mergePredictions(predictions: SemanticPrediction[]): SemanticPrediction[] {
  const sorted = [...predictions].sort((left, right) =>
    left.label.localeCompare(right.label) ||
    left.startIndex - right.startIndex ||
    left.endIndex - right.endIndex,
  );
  const merged: SemanticPrediction[] = [];
  for (const prediction of sorted) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      previous.label === prediction.label &&
      prediction.startIndex <= previous.endIndex
    ) {
      previous.endIndex = Math.max(previous.endIndex, prediction.endIndex);
      previous.confidence = Math.max(previous.confidence, prediction.confidence);
    } else {
      merged.push({ ...prediction });
    }
  }
  return merged;
}

function lengthBucket(length: number): Finding['features']['lengthBucket'] {
  if (length < 32) return 'short';
  if (length < 128) return 'medium';
  if (length < 512) return 'long';
  return 'very-long';
}

export function predictionsToFindings(
  text: string,
  predictions: SemanticPrediction[],
): Finding[] {
  return mergePredictions(predictions).map((prediction) => {
    const originalValue = text.slice(prediction.startIndex, prediction.endIndex);
    const details = labelDetails[prediction.label];
    return {
      id: `semantic-${prediction.label}-${prediction.startIndex}-${prediction.endIndex}`,
      detector: 'semantic',
      category: details.category,
      severity: 'medium',
      confidence: prediction.confidence,
      startIndex: prediction.startIndex,
      endIndex: prediction.endIndex,
      originalValue,
      maskedPreview: `[Masked passage, ${originalValue.length} characters]`,
      replacementValue: `[REDACTED ${details.category.toUpperCase()}]`,
      safeExampleValue: details.safe,
      explanation: details.explanation,
      features: {
        source: 'semantic',
        lengthBucket: lengthBucket(originalValue.length),
        entropyBucket: 'medium',
        placeholderLike: false,
        structures: [`semantic:${prediction.label}`, 'overlapping-token-chunk'],
      },
    };
  });
}

export function mergeDeterministicAndSemantic(
  deterministicFindings: Finding[],
  semanticFindings: Finding[],
): Finding[] {
  const semantic = semanticFindings.map((finding) => {
    const overlapsDeterministic = deterministicFindings.some((deterministic) =>
      finding.startIndex < deterministic.endIndex &&
      finding.endIndex > deterministic.startIndex,
    );
    return overlapsDeterministic ? { ...finding, replacementSafe: false } : finding;
  });
  return [...deterministicFindings, ...semantic];
}

function validateClassifier(value: unknown): ClassifierJson {
  if (!value || typeof value !== 'object') throw new Error('Semantic classifier is invalid');
  const classifier = value as Partial<ClassifierJson>;
  const labelsMatch = Array.isArray(classifier.labels) &&
    classifier.labels.length === SEMANTIC_LABELS.length &&
    classifier.labels.every((label, index) => label === SEMANTIC_LABELS[index]);
  const coefficientsMatch = Array.isArray(classifier.coefficients) &&
    classifier.coefficients.length === SEMANTIC_LABELS.length &&
    classifier.coefficients.every((row) => Array.isArray(row) && row.length === 384);
  if (
    !labelsMatch ||
    !coefficientsMatch ||
    !Array.isArray(classifier.intercepts) ||
    classifier.intercepts.length !== SEMANTIC_LABELS.length ||
    !Array.isArray(classifier.thresholds) ||
    classifier.thresholds.length !== SEMANTIC_LABELS.length
  ) {
    throw new Error('Semantic classifier dimensions or labels do not match');
  }
  return classifier as ClassifierJson;
}

async function createRuntime(): Promise<SemanticRuntime> {
  const ort = await import('onnxruntime-web/wasm');
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = getSemanticWasmPaths();

  const [modelResponse, tokenizerResponse, classifierResponse] = await Promise.all([
    fetch(extensionAssetUrl('semantic/encoder_fp32.onnx')),
    fetch(extensionAssetUrl('semantic/tokenizer.json')),
    fetch(extensionAssetUrl('semantic/classifier.json')),
  ]);
  if (!modelResponse.ok || !tokenizerResponse.ok || !classifierResponse.ok) {
    throw new Error('A bundled semantic model asset could not be loaded');
  }
  const [model, tokenizerValue, classifierValue] = await Promise.all([
    modelResponse.arrayBuffer(),
    tokenizerResponse.json() as Promise<TokenizerJson>,
    classifierResponse.json(),
  ]);
  const classifier = validateClassifier(classifierValue);
  const tokenizer = tokenizerValue;
  if (!tokenizer?.model?.vocab) throw new Error('Semantic tokenizer is invalid');
  const session = await ort.InferenceSession.create(model, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  debugLog('Semantic', 'initialized');

  const embed = async (chunks: SemanticChunk[]): Promise<number[][]> => {
    const embeddings: number[][] = [];
    const batchSize = 4;
    for (let batchStart = 0; batchStart < chunks.length; batchStart += batchSize) {
      const batch = chunks.slice(batchStart, batchStart + batchSize);
      const sequenceLength = Math.max(...batch.map((chunk) => chunk.inputIds.length));
      const ids = new BigInt64Array(batch.length * sequenceLength);
      const mask = new BigInt64Array(batch.length * sequenceLength);
      for (let row = 0; row < batch.length; row += 1) {
        const chunk = batch[row]!;
        for (let column = 0; column < chunk.inputIds.length; column += 1) {
          const offset = row * sequenceLength + column;
          ids[offset] = BigInt(chunk.inputIds[column]!);
          mask[offset] = BigInt(chunk.attentionMask[column]!);
        }
      }
      const output = await session.run({
        input_ids: new ort.Tensor('int64', ids, [batch.length, sequenceLength]),
        attention_mask: new ort.Tensor('int64', mask, [batch.length, sequenceLength]),
      });
      const hidden = output.last_hidden_state;
      if (!hidden || !(hidden.data instanceof Float32Array)) {
        throw new Error('Semantic encoder returned an unexpected tensor');
      }
      for (let row = 0; row < batch.length; row += 1) {
        const pooled = new Array<number>(384).fill(0);
        let tokenCount = 0;
        for (let token = 0; token < sequenceLength; token += 1) {
          if (mask[row * sequenceLength + token] === 0n) continue;
          tokenCount += 1;
          const hiddenStart = (row * sequenceLength + token) * 384;
          for (let feature = 0; feature < 384; feature += 1) {
            pooled[feature] = pooled[feature]! + (hidden.data[hiddenStart + feature] as number);
          }
        }
        let normSquared = 0;
        for (let feature = 0; feature < 384; feature += 1) {
          pooled[feature] = pooled[feature]! / Math.max(1, tokenCount);
          normSquared += pooled[feature]! * pooled[feature]!;
        }
        const norm = Math.sqrt(normSquared) || 1;
        for (let feature = 0; feature < 384; feature += 1) {
          pooled[feature] = pooled[feature]! / norm;
        }
        embeddings.push(pooled);
      }
      if (batchStart + batchSize < chunks.length) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    return embeddings;
  };
  return { tokenizer, classifier, embed };
}

function getRuntime(): Promise<SemanticRuntime> {
  runtimePromise ??= createRuntime();
  return runtimePromise;
}

export async function scanSemanticText(text: string): Promise<Finding[]> {
  if (!text.trim()) return [];
  const runtime = await getRuntime();
  const chunks = buildSemanticChunks(text, runtime.tokenizer, 128, 24);
  debugLog('Semantic', `chunks=${chunks.length}`);
  const embeddings = await runtime.embed(chunks);
  const predictions = classifyEmbeddings(chunks, embeddings, runtime.classifier);
  const findings = predictionsToFindings(text, predictions);
  debugLog('Semantic', `findings=${findings.length}`);
  return findings;
}

export async function scanWithSemanticFallback(
  text: string,
  deterministicFindings: Finding[],
  enabled: boolean,
  semanticScanner: (value: string) => Promise<Finding[]> = scanSemanticText,
): Promise<Finding[]> {
  if (!enabled || !text.trim()) return deterministicFindings;
  try {
    return mergeDeterministicAndSemantic(
      deterministicFindings,
      await semanticScanner(text),
    );
  } catch (error) {
    if (!loggedSemanticFailure) {
      loggedSemanticFailure = true;
      console.warn(
        `[PreSend][Semantic] initialization or inference failed: ${safeSemanticFailureReason(error)}`,
      );
    }
    return deterministicFindings;
  }
}
