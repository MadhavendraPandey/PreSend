import { CONFIG, debugLog } from './config';
import { redactText, replaceWithSafeExamples } from './redaction';
import { scanText } from './scanner';
import type { Finding, MonitorState, WarningAction } from './types';

interface ComposerMonitorOptions {
  readText: () => string;
  onStateChange: (state: MonitorState) => void;
  scanner?: (text: string) => Finding[] | Promise<Finding[]>;
  findingFilter?: (findings: Finding[]) => Promise<Finding[]>;
  typingDelayMs?: number;
  pasteDelayMs?: number;
}

export class ComposerMonitor {
  private readonly readText: () => string;
  private readonly onStateChange: (state: MonitorState) => void;
  private readonly scanner: (text: string) => Finding[] | Promise<Finding[]>;
  private readonly findingFilter?: (findings: Finding[]) => Promise<Finding[]>;
  private readonly typingDelayMs: number;
  private readonly pasteDelayMs: number;
  private typingScanTimer: ReturnType<typeof setTimeout> | undefined;
  private pasteScanTimer: ReturnType<typeof setTimeout> | undefined;
  private lastScannedText: string | undefined;
  private lastFindingCount = 0;
  private scanVersion = 0;

  constructor(options: ComposerMonitorOptions) {
    this.readText = options.readText;
    this.onStateChange = options.onStateChange;
    this.scanner = options.scanner ?? scanText;
    this.findingFilter = options.findingFilter;
    this.typingDelayMs = options.typingDelayMs ?? CONFIG.typingScanDelayMs;
    this.pasteDelayMs = options.pasteDelayMs ?? CONFIG.pasteScanDelayMs;
  }

  handleInput(): void {
    clearTimeout(this.typingScanTimer);
    this.scanVersion += 1;
    this.onStateChange({ kind: 'monitoring' });
    this.typingScanTimer = setTimeout(() => void this.scanCurrentText(false), this.typingDelayMs);
  }

  handlePaste(): void {
    clearTimeout(this.typingScanTimer);
    clearTimeout(this.pasteScanTimer);
    this.scanVersion += 1;
    debugLog('Monitor', 'Paste detected');
    this.onStateChange({ kind: 'checking' });
    this.pasteScanTimer = setTimeout(() => void this.scanCurrentText(false), this.pasteDelayMs);
  }

  async finalScan(): Promise<{ text: string; findings: Finding[] }> {
    clearTimeout(this.typingScanTimer);
    clearTimeout(this.pasteScanTimer);
    this.scanVersion += 1;
    this.onStateChange({ kind: 'checking' });

    const text = this.readText();
    const scannedFindings = await this.scanner(text);
    let findings = scannedFindings;
    if (this.findingFilter) {
      try {
        findings = await this.findingFilter(scannedFindings);
      } catch {
        debugLog('Monitor', 'Local allowlist could not be applied');
      }
    }
    this.lastScannedText = text;
    this.lastFindingCount = findings.length;
    this.onStateChange({ kind: 'complete', findingCount: findings.length });

    return { text, findings };
  }

  dispose(): void {
    clearTimeout(this.typingScanTimer);
    clearTimeout(this.pasteScanTimer);
    this.scanVersion += 1;
  }

  private async scanCurrentText(force: boolean): Promise<Finding[]> {
    const text = this.readText();

    if (!force && text === this.lastScannedText) {
      this.onStateChange({ kind: 'complete', findingCount: this.lastFindingCount });
      return [];
    }

    this.onStateChange({ kind: 'checking' });
    const currentScanVersion = ++this.scanVersion;
    const scannedFindings = await this.scanner(text);
    let findings = scannedFindings;

    if (this.findingFilter) {
      try {
        findings = await this.findingFilter(scannedFindings);
      } catch {
        // Storage failures must not suppress a real finding.
        debugLog('Monitor', 'Local allowlist could not be applied');
      }
    }

    if (currentScanVersion !== this.scanVersion) {
      return [];
    }

    this.lastScannedText = text;
    this.lastFindingCount = findings.length;
    this.onStateChange({ kind: 'complete', findingCount: findings.length });
    return findings;
  }
}

interface SubmissionDecisionOptions {
  action: WarningAction;
  originalText: string;
  findings: Finding[];
  replaceText: (text: string) => void;
  submit: () => void | Promise<void>;
  focusComposer: () => void;
}

export async function applySubmissionDecision(options: SubmissionDecisionOptions): Promise<void> {
  if (options.action === 'cancel') {
    options.focusComposer();
    return;
  }

  if (options.action === 'redact') {
    options.replaceText(redactText(options.originalText, options.findings));
  } else if (options.action === 'replace-safe') {
    options.replaceText(replaceWithSafeExamples(options.originalText, options.findings));
  }

  await options.submit();
}
