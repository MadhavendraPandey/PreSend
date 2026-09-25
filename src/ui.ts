import { debugLog } from './config';
import { confidenceLevel, feedbackCategoryOptions } from './feedback';
import type { FileScanResult } from './files';
import type { FeedbackLabel, Finding, WarningAction } from './types';

function severityLabel(finding: Finding): string {
  return finding.severity.toUpperCase();
}

const maxSemanticPreviewCharacters = 2_400;

function boundedSemanticPassage(value: string): { text: string; excerpted: boolean } {
  if (value.length <= maxSemanticPreviewCharacters) {
    return { text: value, excerpted: false };
  }
  const edgeLength = Math.floor((maxSemanticPreviewCharacters - 40) / 2);
  return {
    text: `${value.slice(0, edgeLength)}\n\n[… passage shortened locally …]\n\n${value.slice(-edgeLength)}`,
    excerpted: true,
  };
}

interface WarningDialogOptions {
  onFeedback?: (
    finding: Finding,
    label: FeedbackLabel,
    correctedLabels?: string[],
  ) => void | Promise<void>;
  onAllowlist?: (finding: Finding) => void | Promise<void>;
}

export function showWarningDialog(
  findings: Finding[],
  options: WarningDialogOptions = {},
): Promise<WarningAction> {
  debugLog('UI', 'Warning opened');

  return new Promise((resolve) => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const host = document.createElement('div');
    host.dataset.presendUi = 'warning';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });

    const overlay = document.createElement('div');
    overlay.className = 'overlay';

    const dialog = document.createElement('section');
    dialog.className = 'dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'presend-title');
    dialog.setAttribute('aria-describedby', 'presend-description');

    const heading = document.createElement('div');
    heading.className = 'heading';
    const mark = document.createElement('div');
    mark.className = 'mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = '!';
    const headingText = document.createElement('div');
    const title = document.createElement('h1');
    title.id = 'presend-title';
    title.textContent = 'Check before sending';
    const description = document.createElement('p');
    description.id = 'presend-description';
    description.textContent = `PreSend detected ${findings.length} potential sensitive ${
      findings.length === 1 ? 'item' : 'items'
    }.`;
    headingText.append(title, description);
    heading.append(mark, headingText);

    const findingsContainer = document.createElement('div');
    findingsContainer.className = 'findings';
    findingsContainer.tabIndex = 0;
    findingsContainer.setAttribute('aria-label', 'Detected items');
    const privacy = document.createElement('p');
    privacy.className = 'privacy';
    privacy.textContent = 'Your prompt was scanned locally and was not sent to PreSend.';
    const actions = document.createElement('div');
    actions.className = 'actions';
    for (const [action, label, className] of [
      ['cancel', 'Cancel', 'secondary'],
      ['send-anyway', 'Send Anyway', 'danger'],
      ['redact', 'Redact and Send', 'secondary'],
      ['replace-safe', 'Replace with Safe Example', 'primary'],
    ] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = className;
      button.dataset.action = action;
      button.textContent = label;
      actions.append(button);
    }
    dialog.append(heading, findingsContainer, privacy, actions);
    overlay.append(dialog);

    const style = document.createElement('style');
    style.textContent = `
      :host { --primary: #26313a; --secondary: #3f7896; --tertiary: #a64e46; --surface: #f4f3ef; --surface-muted: #e8e9e6; --border: #c5cbce; --text-muted: #626d75; }
      * { box-sizing: border-box; }
      .overlay { position: fixed; inset: 0; display: grid; place-items: center; padding: 20px; background: rgba(20, 26, 31, .68); font: 13px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .dialog { display: flex; flex-direction: column; width: min(560px, 100%); max-height: min(720px, calc(100vh - 40px)); overflow: hidden; padding: 20px; border: 1px solid var(--border); border-radius: 4px; color: var(--primary); background: var(--surface); }
      .heading { display: flex; gap: 10px; align-items: flex-start; }
      .mark { flex: 0 0 auto; display: grid; place-items: center; width: 26px; height: 26px; border: 1px solid var(--tertiary); border-radius: 3px; color: var(--tertiary); background: transparent; font-weight: 750; }
      h1 { margin: 0; font-size: 18px; font-weight: 700; line-height: 1.35; }
      p { margin: 5px 0 0; color: var(--text-muted); font-size: 13px; line-height: 1.5; }
      .findings { display: grid; gap: 7px; min-height: 0; margin: 16px 0; overflow-y: auto; overscroll-behavior: contain; }
      .finding { padding: 10px; border: 1px solid var(--border); border-radius: 3px; background: var(--surface-muted); }
      .meta { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; }
      .severity { padding: 2px 6px; border: 1px solid var(--tertiary); border-radius: 3px; color: var(--tertiary); background: transparent; font-size: 11px; font-weight: 700; letter-spacing: .02em; }
      .severity.critical { color: var(--surface); background: var(--tertiary); }
      .confidence { color: var(--text-muted); font-size: 11px; font-weight: 600; }
      .category { color: var(--primary); font-size: 13px; font-weight: 700; }
      .preview { display: grid; gap: 5px; }
      .preview-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .preview-label { color: var(--text-muted); font-size: 11px; font-weight: 700; }
      .preview code { display: block; max-height: 144px; overflow: auto; overscroll-behavior: contain; white-space: pre-wrap; overflow-wrap: anywhere; padding: 8px; border: 1px solid var(--border); border-radius: 3px; color: var(--primary); background: var(--surface); font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; }
      .reveal { min-height: 24px; padding: 3px 7px; color: var(--secondary); border-color: var(--border); background: transparent; font-size: 11px; }
      .explanation { font-size: 13px; }
      .feedback { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 10px; padding-top: 9px; border-top: 1px solid var(--border); }
      .feedback-label, .feedback-status { color: var(--text-muted); font-size: 12px; }
      .feedback button { min-height: 28px; padding: 4px 8px; color: var(--primary); border-color: var(--border); background: transparent; font-size: 12px; }
      .feedback button:disabled { cursor: default; opacity: .65; }
      .feedback-correction { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; width: 100%; }
      .feedback-correction select { min-height: 28px; max-width: 260px; padding: 3px 6px; border: 1px solid var(--border); border-radius: 3px; color: var(--primary); background: var(--surface); font: 12px/1.3 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .allowlist { color: var(--secondary) !important; border-color: var(--secondary) !important; }
      .privacy { padding-top: 2px; font-size: 12px; }
      .actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 7px; margin-top: 16px; }
      button { min-height: 34px; padding: 7px 12px; border: 1px solid var(--border); border-radius: 3px; font: 650 13px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; cursor: pointer; }
      button:focus-visible { outline: 2px solid var(--secondary); outline-offset: 2px; }
      .secondary { color: var(--primary); background: transparent; }
      .danger { color: var(--tertiary); border-color: var(--tertiary); background: transparent; }
      .primary { color: var(--surface); border-color: var(--secondary); background: var(--secondary); }
      @media (prefers-color-scheme: dark) {
        :host { --primary: #d9dee1; --secondary: #78a8bf; --tertiary: #d17a70; --surface: #20272d; --surface-muted: #272f36; --border: #46515a; --text-muted: #a8b0b5; }
      }
    `;

    const renderedFindings = findings.slice(0, 100);
    for (const finding of renderedFindings) {
      const item = document.createElement('article');
      item.className = 'finding';

      const meta = document.createElement('div');
      meta.className = 'meta';
      const severity = document.createElement('span');
      severity.className = `severity ${finding.severity}`;
      severity.textContent = severityLabel(finding);
      const category = document.createElement('span');
      category.className = 'category';
      category.textContent = finding.category;
      const confidence = document.createElement('span');
      confidence.className = 'confidence';
      confidence.textContent = `${confidenceLevel(finding.confidence)} confidence`;
      meta.append(severity, category, confidence);

      const preview = document.createElement('div');
      preview.className = 'preview';
      const previewHeader = document.createElement('div');
      previewHeader.className = 'preview-header';
      const previewLabel = document.createElement('span');
      previewLabel.className = 'preview-label';
      const previewCode = document.createElement('code');

      if (finding.detector === 'semantic') {
        const passage = boundedSemanticPassage(finding.originalValue);
        previewLabel.textContent = passage.excerpted
          ? 'Detected passage (bounded excerpt)'
          : 'Detected passage';
        previewCode.className = 'semantic-preview';
        previewCode.textContent = passage.text;
        previewHeader.append(previewLabel);
      } else {
        previewLabel.textContent = 'Detected value';
        previewCode.textContent = finding.maskedPreview;
        const reveal = document.createElement('button');
        reveal.type = 'button';
        reveal.className = 'reveal';
        reveal.textContent = 'Reveal';
        reveal.setAttribute('aria-pressed', 'false');
        reveal.addEventListener('click', () => {
          const isRevealed = reveal.getAttribute('aria-pressed') === 'true';
          reveal.setAttribute('aria-pressed', String(!isRevealed));
          reveal.textContent = isRevealed ? 'Reveal' : 'Hide';
          previewCode.textContent = isRevealed ? finding.maskedPreview : finding.originalValue;
        });
        previewHeader.append(previewLabel, reveal);
      }
      preview.append(previewHeader, previewCode);
      const explanation = document.createElement('p');
      explanation.className = 'explanation';
      explanation.textContent = finding.explanation;

      const feedback = document.createElement('div');
      feedback.className = 'feedback';
      const feedbackLabel = document.createElement('span');
      feedbackLabel.className = 'feedback-label';
      feedbackLabel.textContent = 'Optional feedback:';
      const feedbackStatus = document.createElement('span');
      feedbackStatus.className = 'feedback-status';
      feedbackStatus.setAttribute('aria-live', 'polite');
      feedback.append(feedbackLabel);

      const saveFeedback = async (label: FeedbackLabel, correctedLabels: string[] = []) => {
        const feedbackButtons = feedback.querySelectorAll<HTMLButtonElement>('button');
        feedbackButtons.forEach((button) => { button.disabled = true; });
        feedbackStatus.textContent = 'Saving locally…';
        try {
          await options.onFeedback?.(finding, label, correctedLabels);
          feedbackStatus.textContent = 'Saved locally';

          if (label === 'not-sensitive' && options.onAllowlist) {
            const allowlistButton = document.createElement('button');
            allowlistButton.type = 'button';
            allowlistButton.className = 'allowlist';
            allowlistButton.textContent = 'Allow this exact value';
            allowlistButton.disabled = false;
            allowlistButton.addEventListener('click', async () => {
              allowlistButton.disabled = true;
              feedbackStatus.textContent = 'Adding exact-value fingerprint…';
              try {
                await options.onAllowlist?.(finding);
                feedbackStatus.textContent = 'Exact value allowed locally';
                allowlistButton.remove();
              } catch {
                feedbackStatus.textContent = 'Could not update allowlist';
                allowlistButton.disabled = false;
              }
            });
            feedback.append(allowlistButton);
          }
        } catch {
          feedbackStatus.textContent = 'Could not save feedback';
          feedbackButtons.forEach((button) => { button.disabled = false; });
        }
      };

      for (const [label, buttonText] of [
        ['correct', 'Correct'],
        ['not-sensitive', 'Not Sensitive'],
        ['wrong-category', 'Wrong Category'],
      ] as const) {
        const feedbackButton = document.createElement('button');
        feedbackButton.type = 'button';
        feedbackButton.textContent = buttonText;
        feedbackButton.addEventListener('click', () => {
          if (label !== 'wrong-category') {
            void saveFeedback(label);
            return;
          }
          feedbackButton.disabled = true;
          const correction = document.createElement('div');
          correction.className = 'feedback-correction';
          const select = document.createElement('select');
          select.setAttribute('aria-label', 'Correct category');
          for (const [value, display] of feedbackCategoryOptions) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = display;
            select.append(option);
          }
          const save = document.createElement('button');
          save.type = 'button';
          save.textContent = 'Save correction';
          save.addEventListener('click', () => void saveFeedback(label, [select.value]));
          correction.append(select, save);
          feedback.insertBefore(correction, feedbackStatus);
          select.focus();
        });
        feedback.append(feedbackButton);
      }

      feedback.append(feedbackStatus);
      item.append(meta, preview, explanation, feedback);
      findingsContainer.append(item);
    }
    if (findings.length > renderedFindings.length) {
      const remaining = document.createElement('p');
      remaining.className = 'explanation';
      remaining.textContent =
        `Showing the first ${renderedFindings.length} of ${findings.length} detected items. All items will be included in the selected action.`;
      findingsContainer.append(remaining);
    }

    shadow.append(style, overlay);
    document.body.append(host);

    const actionButtons = Array.from(
      shadow.querySelectorAll<HTMLButtonElement>('[data-action]'),
    );
    const primaryButton = shadow.querySelector<HTMLButtonElement>('[data-action="replace-safe"]');
    let closed = false;

    const finish = (action: WarningAction) => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', handleKeydown, true);
      host.remove();
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
      resolve(action);
    };

    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish('cancel');
        return;
      }

      const focusable = Array.from(
        shadow.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]'),
      );
      if (event.key !== 'Tab' || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && shadow.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && shadow.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    for (const button of actionButtons) {
      button.addEventListener('click', () => {
        const action = button.dataset.action as WarningAction;
        finish(action);
      });
    }

    document.addEventListener('keydown', handleKeydown, true);
    primaryButton?.focus();
  });
}

export type FileWarningAction =
  | 'redact-copy'
  | 'replace-safe-copy'
  | 'upload-original'
  | 'cancel';

export interface FileWarningDialogOptions {
  allowUploadOriginal?: boolean;
  description?: string;
  privacyText?: string;
  cancelLabel?: string;
}

function highestFileSeverity(findings: Finding[]): Finding['severity'] {
  const rank: Record<Finding['severity'], number> = {
    low: 0,
    medium: 1,
    high: 2,
    critical: 3,
  };
  return findings.reduce<Finding['severity']>(
    (highest, finding) => rank[finding.severity] > rank[highest] ? finding.severity : highest,
    'low',
  );
}

export function showFileWarningDialog(
  results: FileScanResult[],
  options: FileWarningDialogOptions = {},
): Promise<FileWarningAction> {
  debugLog('UI', 'File warning opened');

  return new Promise((resolve) => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const host = document.createElement('div');
    host.dataset.presendUi = 'file-warning';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { --primary: #26313a; --secondary: #3f7896; --tertiary: #a64e46; --surface: #f4f3ef; --surface-muted: #e8e9e6; --border: #c5cbce; --text-muted: #626d75; }
      * { box-sizing: border-box; }
      .overlay { position: fixed; inset: 0; display: grid; place-items: center; padding: 20px; background: rgba(20, 26, 31, .68); font: 13px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .dialog { display: flex; flex-direction: column; width: min(580px, 100%); max-height: min(720px, calc(100vh - 40px)); overflow: hidden; padding: 20px; border: 1px solid var(--border); border-radius: 4px; color: var(--primary); background: var(--surface); }
      h1 { margin: 0; font-size: 18px; font-weight: 700; }
      .intro, .privacy { margin: 6px 0 0; color: var(--text-muted); font-size: 13px; line-height: 1.5; }
      .files { display: grid; gap: 7px; min-height: 0; margin: 16px 0; overflow-y: auto; }
      .file { padding: 10px; border: 1px solid var(--border); border-radius: 3px; background: var(--surface-muted); }
      .file-name { display: block; overflow-wrap: anywhere; color: var(--primary); font-size: 13px; }
      .file-detail { margin-top: 5px; color: var(--text-muted); font-size: 13px; line-height: 1.45; }
      .severity { display: inline-block; margin-left: 6px; padding: 2px 5px; border: 1px solid var(--tertiary); border-radius: 3px; color: var(--tertiary); background: transparent; font-size: 11px; font-weight: 700; text-transform: uppercase; }
      .severity.critical { color: var(--surface); background: var(--tertiary); }
      .actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 7px; margin-top: 16px; }
      button { min-height: 34px; padding: 7px 12px; border: 1px solid var(--border); border-radius: 3px; font: 650 13px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; cursor: pointer; }
      button:focus-visible, .files:focus-visible { outline: 2px solid var(--secondary); outline-offset: 2px; }
      .secondary { color: var(--primary); background: transparent; }
      .danger { color: var(--tertiary); border-color: var(--tertiary); background: transparent; }
      .primary { color: var(--surface); border-color: var(--secondary); background: var(--secondary); }
      @media (prefers-color-scheme: dark) {
        :host { --primary: #d9dee1; --secondary: #78a8bf; --tertiary: #d17a70; --surface: #20272d; --surface-muted: #272f36; --border: #46515a; --text-muted: #a8b0b5; }
      }
    `;

    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    const dialog = document.createElement('section');
    dialog.className = 'dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'presend-file-title');
    dialog.setAttribute('aria-describedby', 'presend-file-description');
    const title = document.createElement('h1');
    title.id = 'presend-file-title';
    title.textContent = 'Check files before upload';
    const description = document.createElement('p');
    description.id = 'presend-file-description';
    description.className = 'intro';
    description.textContent = options.description ??
      'PreSend found sensitive content or could not fully scan the selected file.';
    const files = document.createElement('div');
    files.className = 'files';
    files.tabIndex = 0;
    files.setAttribute('aria-label', 'Selected file scan results');

    for (const result of results) {
      if (result.status === 'scanned' && result.findings.length === 0) continue;
      const item = document.createElement('article');
      item.className = 'file';
      const name = document.createElement('strong');
      name.className = 'file-name';
      name.textContent = result.fileName;
      const detail = document.createElement('div');
      detail.className = 'file-detail';

      if (result.status === 'unscannable') {
        detail.textContent = result.message;
      } else {
        const categories = Array.from(new Set(result.findings.map((finding) => finding.category)));
        const severityValue = highestFileSeverity(result.findings);
        const highestConfidence = Math.max(...result.findings.map((finding) => finding.confidence));
        detail.textContent = `${result.findings.length} potential ${
          result.findings.length === 1 ? 'item' : 'items'
        }: ${categories.join(', ')} · ${confidenceLevel(highestConfidence)} confidence`;
        const severity = document.createElement('span');
        severity.className = `severity ${severityValue}`;
        severity.textContent = severityValue;
        detail.append(severity);
        if (!result.sanitizationAvailable) {
          const note = document.createElement('div');
          note.textContent = 'A structure-safe sanitized copy is unavailable for this format.';
          detail.append(note);
        }
      }
      item.append(name, detail);
      files.append(item);
    }

    const privacy = document.createElement('p');
    privacy.className = 'privacy';
    privacy.textContent = options.privacyText ??
      'Files are read and scanned locally. Your original files are never modified.';
    const actions = document.createElement('div');
    actions.className = 'actions';
    const canSanitize = results.every(
      (result) => result.status === 'scanned' &&
        (result.findings.length === 0 || result.sanitizationAvailable),
    );
    const actionDefinitions: Array<[FileWarningAction, string, string]> = [
      ['cancel', options.cancelLabel ?? 'Cancel', 'secondary'],
    ];
    if (options.allowUploadOriginal !== false) {
      actionDefinitions.push(['upload-original', 'Upload Original Anyway', 'danger']);
    }
    if (canSanitize && options.allowUploadOriginal !== false) {
      actionDefinitions.push(
        ['redact-copy', 'Redact and Upload Copy', 'secondary'],
        ['replace-safe-copy', 'Safe Examples and Upload Copy', 'primary'],
      );
    }
    for (const [action, label, className] of actionDefinitions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.action = action;
      button.className = className;
      button.textContent = label;
      actions.append(button);
    }

    dialog.append(title, description, files, privacy, actions);
    overlay.append(dialog);
    shadow.append(style, overlay);
    document.body.append(host);

    let closed = false;
    const finish = (action: FileWarningAction) => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', handleKeydown, true);
      host.remove();
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
      resolve(action);
    };
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish('cancel');
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        shadow.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]'),
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && shadow.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && shadow.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    for (const button of shadow.querySelectorAll<HTMLButtonElement>('[data-action]')) {
      button.addEventListener('click', () => finish(button.dataset.action as FileWarningAction));
    }
    document.addEventListener('keydown', handleKeydown, true);
    shadow.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.focus();
  });
}
