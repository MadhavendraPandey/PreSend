import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { redactText } from '../src/redaction';
import { scanText } from '../src/scanner';
import {
  buildSemanticChunks,
  classifyEmbeddings,
  getSemanticWasmPaths,
  mergeDeterministicAndSemantic,
  predictionsToFindings,
  scanWithSemanticFallback,
  SEMANTIC_LABELS,
  SEMANTIC_RUNTIME_ASSETS,
} from '../src/semantic';
import { DEFAULT_SETTINGS } from '../src/storage';
import wxtConfig from '../wxt.config';

const tokenizer = {
  model: {
    vocab: {
      '[UNK]': 100,
      '[CLS]': 101,
      '[SEP]': 102,
      alpha: 200,
      beta: 201,
    },
    unk_token: '[UNK]',
    continuing_subword_prefix: '##',
    max_input_chars_per_word: 100,
  },
};

function classifier(firstThreshold = 0.5) {
  return {
    labels: [...SEMANTIC_LABELS],
    coefficients: SEMANTIC_LABELS.map((_, labelIndex) =>
      Array.from({ length: 384 }, (_, featureIndex) =>
        labelIndex === 0 && featureIndex === 0 ? 2 : 0,
      ),
    ),
    intercepts: SEMANTIC_LABELS.map((_, index) => index === 0 ? 0 : -10),
    thresholds: SEMANTIC_LABELS.map((_, index) => index === 0 ? firstThreshold : 0.99),
  };
}

describe('semantic integration', () => {
  it('defaults semantic detection on', () => {
    expect(DEFAULT_SETTINGS.semanticDetection).toBe(true);
  });

  it('packages and exposes both ONNX Runtime browser assets', () => {
    const urls = getSemanticWasmPaths((path) => `chrome-extension://presend/${path}`);
    expect(urls).toEqual({
      mjs: 'chrome-extension://presend/semantic/ort/ort-wasm-simd-threaded.mjs',
      wasm: 'chrome-extension://presend/semantic/ort/ort-wasm-simd-threaded.wasm',
    });

    for (const path of Object.values(SEMANTIC_RUNTIME_ASSETS)) {
      expect(existsSync(resolve('public', path))).toBe(true);
    }
    const manifest = (wxtConfig as unknown as {
      manifest: { web_accessible_resources: Array<{ resources: string[] }> };
    }).manifest;
    const resources = manifest.web_accessible_resources.flatMap((entry) => entry.resources);
    expect(resources).toEqual(expect.arrayContaining(Object.values(SEMANTIC_RUNTIME_ASSETS)));
  });

  it('keeps the persisted classifier label order and dimensions intact', () => {
    const classifierArtifact = JSON.parse(
      readFileSync(resolve('public/semantic/classifier.json'), 'utf8'),
    ) as {
      labels: string[];
      coefficients: number[][];
      intercepts: number[];
      thresholds: number[];
    };

    expect(classifierArtifact.labels).toEqual(SEMANTIC_LABELS);
    expect(classifierArtifact.coefficients).toHaveLength(SEMANTIC_LABELS.length);
    expect(classifierArtifact.coefficients.every((row) => row.length === 384)).toBe(true);
    expect(classifierArtifact.intercepts).toHaveLength(SEMANTIC_LABELS.length);
    expect(classifierArtifact.thresholds).toHaveLength(SEMANTIC_LABELS.length);
  });

  it('chunks every token in long prompts with overlap and no silent truncation', () => {
    const text = Array.from({ length: 300 }, (_, index) => index % 2 ? 'beta' : 'alpha').join(' ');
    const chunks = buildSemanticChunks(text, tokenizer, 128, 24);

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.inputIds.length <= 128)).toBe(true);
    expect(chunks[0]?.startIndex).toBe(0);
    expect(chunks.at(-1)?.endIndex).toBe(text.length);
    expect(chunks[1]!.startIndex).toBeLessThan(chunks[0]!.endIndex);
  });

  it('applies the persisted logistic form and thresholds to every chunk', () => {
    const chunks = buildSemanticChunks('alpha beta', tokenizer);
    const embedding = Array<number>(384).fill(0);
    embedding[0] = 1;
    const predictions = classifyEmbeddings(chunks, [embedding], classifier(0.8));

    expect(predictions).toEqual([
      expect.objectContaining({ label: 'confidential_business', startIndex: 0, endIndex: 10 }),
    ]);
    expect(predictions[0]!.confidence).toBeCloseTo(0.880797, 5);
  });

  it('merges overlapping duplicate semantic chunk results into one ranged finding', () => {
    const text = 'alpha beta alpha beta';
    const findings = predictionsToFindings(text, [
      { label: 'internal_security', confidence: 0.7, startIndex: 0, endIndex: 10 },
      { label: 'internal_security', confidence: 0.8, startIndex: 6, endIndex: text.length },
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      detector: 'semantic',
      startIndex: 0,
      endIndex: text.length,
      confidence: 0.8,
    });
    expect(findings[0]!.maskedPreview).not.toContain(text);
  });

  it('keeps deterministic findings when semantic initialization fails', async () => {
    const text = 'API_KEY=live_abcdefgh123456';
    const deterministic = scanText(text);
    const semanticScanner = vi.fn(async () => {
      throw new Error('WASM unavailable');
    });

    await expect(
      scanWithSemanticFallback(text, deterministic, true, semanticScanner),
    ).resolves.toEqual(deterministic);
  });

  it('does not let a broad semantic span replace an overlapping deterministic secret', () => {
    const text = 'Share API_KEY=live_abcdefgh123456 with the deployment owner.';
    const deterministic = scanText(text);
    const semantic = predictionsToFindings(text, [{
      label: 'internal_security',
      confidence: 0.75,
      startIndex: 0,
      endIndex: text.length,
    }]);
    const merged = mergeDeterministicAndSemantic(deterministic, semantic);
    const redacted = redactText(text, merged);

    expect(merged.find((finding) => finding.detector === 'semantic')?.replacementSafe).toBe(false);
    expect(redacted).toBe('Share API_KEY=[API_KEY_REDACTED] with the deployment owner.');
  });
});
