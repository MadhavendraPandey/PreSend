import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { CONFIG, debugLog } from '../src/config';
import {
  allowlistFinding,
  filterAllowlistedFindings,
  saveFindingFeedback,
} from '../src/feedback';
import {
  createSanitizedFile,
  getFileExtension,
  getFileSelectionLimitMessage,
  getSupportedFileFormat,
  scanLocalFile,
  type FileScanOptions,
  type FileScanResult,
} from '../src/files';
import { recordFindingsHistory } from '../src/history';
import { applySubmissionDecision, ComposerMonitor } from '../src/monitor';
import { scanText } from '../src/scanner';
import { scanWithSemanticFallback } from '../src/semantic';
import { getSiteIntegration } from '../src/sites';
import {
  getSettings,
  storageMessageTypes,
} from '../src/storage';
import type {
  HistoryAction,
  IntegrationHealth,
  PreSendSettings,
  SiteName,
  WarningAction,
} from '../src/types';
import {
  showFileWarningDialog,
  showWarningDialog,
  type FileWarningAction,
} from '../src/ui';

const supportedMatches = [
  'https://chatgpt.com/*',
  'https://claude.ai/*',
  'https://gemini.google.com/*',
  'https://perplexity.ai/*',
  'https://www.perplexity.ai/*',
  'https://chat.deepseek.com/*',
  'https://grok.com/*',
];

function stopSiteEvent(event: Event): void {
  if (event.cancelable) event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

function historyAction(action: WarningAction | FileWarningAction): HistoryAction | null {
  if (action === 'redact' || action === 'redact-copy') return 'redacted';
  if (action === 'replace-safe' || action === 'replace-safe-copy') return 'safe-example';
  if (action === 'send-anyway' || action === 'upload-original') return 'sent-anyway';
  if (action === 'cancel') return 'cancelled';
  return null;
}

function isLikelyDynamicAttachmentInput(input: HTMLInputElement): boolean {
  const descriptor = [
    input.id,
    input.name,
    input.accept,
    input.getAttribute('aria-label') ?? '',
    input.getAttribute('data-testid') ?? '',
  ].join(' ');
  if (input.multiple || /attach|upload|document|composer|prompt|pdf|docx/i.test(descriptor)) {
    return true;
  }
  const acceptedTypes = input.accept
    .split(',')
    .map((type) => type.trim().toLowerCase())
    .filter(Boolean);
  return acceptedTypes.length > 0 && acceptedTypes.some((type) => !type.startsWith('image/'));
}

export default defineContentScript({
  matches: supportedMatches,
  runAt: 'document_start',
  main() {
    const integration = getSiteIntegration();
    if (!integration) return;

    let settings: PreSendSettings | null = null;
    let activeComposer: HTMLElement | null = null;
    let monitor: ComposerMonitor | null = null;
    let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
    let warningOpen = false;
    let fileWarningOpen = false;
    let fileTransactionActive = false;
    let bypassNextSubmission = false;
    const sessionAllowlistedValues = new Set<string>();
    const processingFileInputs = new WeakSet<HTMLInputElement>();
    const bypassFileEvents = new WeakMap<HTMLInputElement, number>();

    const isProtectionEnabled = () => Boolean(
      settings?.protectionEnabled && settings.sites[integration.id],
    );

    const currentIntegrationHealth = (textAvailable: boolean): IntegrationHealth => {
      const enabled = isProtectionEnabled();
      const fileInputAvailable =
        integration.findFileInput(document, activeComposer ?? undefined) !== null;
      const dynamicInterceptionConfirmed = Boolean(
        integration.supportsDynamicFileInput &&
        integration.hasFileInterceptionControl?.(document, activeComposer ?? undefined),
      );
      const fileAvailable = enabled && textAvailable &&
        (fileInputAvailable || dynamicInterceptionConfirmed);
      return {
        site: integration.name as SiteName,
        siteId: integration.id,
        protectionEnabled: enabled,
        siteRecognized: true,
        composerDetected: textAvailable,
        monitoringActive: enabled && textAvailable,
        textProtection: enabled && textAvailable ? 'protected' : 'unavailable',
        fileProtection: fileAvailable ? 'protected' : 'unavailable',
        protection: enabled && textAvailable ? 'protected' : 'unavailable',
        scanner: enabled && textAvailable ? 'ready' : 'unavailable',
        updatedAt: Date.now(),
      };
    };

    const updateHealth = (textAvailable: boolean) => {
      const health = currentIntegrationHealth(textAvailable);
      void browser.runtime.sendMessage({
        type: storageMessageTypes.saveIntegrationHealth,
        health,
      }).catch(() => {
        // The popup reports unavailable if the extension background is unreachable.
      });
    };

    const handleInput = () => monitor?.handleInput();
    const handlePaste = () => monitor?.handlePaste();

    const detachComposer = () => {
      if (activeComposer) {
        activeComposer.removeEventListener('input', handleInput);
        activeComposer.removeEventListener('paste', handlePaste);
      }
      monitor?.dispose();
      activeComposer = null;
      monitor = null;
    };

    const attachToComposer = (composer: HTMLElement) => {
      detachComposer();
      activeComposer = composer;
      monitor = new ComposerMonitor({
        readText: () => activeComposer ? integration.readComposerText(activeComposer) : '',
        onStateChange: () => {},
        scanner: async (text) => {
          const deterministicFindings = scanText(text, settings?.detectors);
          const findings = await scanWithSemanticFallback(
            text,
            deterministicFindings,
            Boolean(settings?.semanticDetection),
          );
          return findings.filter(
            (finding) => !sessionAllowlistedValues.has(finding.originalValue),
          );
        },
        findingFilter: filterAllowlistedFindings,
      });
      composer.addEventListener('input', handleInput);
      composer.addEventListener('paste', handlePaste);
      updateHealth(true);
      debugLog(integration.scope, 'Composer detected');
    };

    const refreshIntegration = () => {
      if (!settings) return;
      if (!isProtectionEnabled()) {
        detachComposer();
        updateHealth(false);
        return;
      }

      const composer = integration.findComposer();
      if (composer && composer !== activeComposer) {
        attachToComposer(composer);
        return;
      }
      if (!composer) {
        if (activeComposer) detachComposer();
        updateHealth(false);
        return;
      }
      updateHealth(true);
    };

    const scheduleIntegrationRefresh = () => {
      if (recoveryTimer !== undefined) return;
      recoveryTimer = setTimeout(() => {
        recoveryTimer = undefined;
        refreshIntegration();
      }, CONFIG.integrationRecoveryDelayMs);
    };

    const recordTextOutcome = (action: WarningAction, findings: ReturnType<typeof scanText>) => {
      const mappedAction = historyAction(action);
      if (!mappedAction) return;
      void recordFindingsHistory(integration.id, findings, mappedAction).catch(() => {
        debugLog('History', 'Could not save local activity metadata');
      });
    };

    const countSessionCheck = (warningCount: number) => {
      void browser.runtime.sendMessage({
        type: storageMessageTypes.recordSessionCheck,
        warningCount,
      }).catch(() => {
        debugLog('Storage', 'Session counters could not be updated');
      });
    };

    const interceptSubmission = (event: Event) => {
      if (bypassNextSubmission) {
        bypassNextSubmission = false;
        return;
      }
      if (!isProtectionEnabled()) return;
      if (!activeComposer || !monitor) {
        updateHealth(false);
        return;
      }
      const submittedComposer = activeComposer;
      const submittedMonitor = monitor;
      const submissionContextIsCurrent = (expectedText: string) =>
        activeComposer === submittedComposer &&
        submittedComposer.isConnected &&
        integration.readComposerText(submittedComposer) === expectedText;

      // If the site's send control has changed, fail open instead of trapping submission.
      if (!integration.findSendButton(submittedComposer)) {
        updateHealth(false);
        return;
      }

      stopSiteEvent(event);
      if (warningOpen) return;
      warningOpen = true;

      void submittedMonitor.finalScan()
        .then(async ({ text, findings: activeFindings }) => {
          if (!submissionContextIsCurrent(text)) {
            updateHealth(Boolean(activeComposer));
            return;
          }
          countSessionCheck(activeFindings.length);
          if (activeFindings.length === 0) {
            bypassNextSubmission = true;
            const resumed = integration.resumeSubmission(submittedComposer);
            if (!resumed) bypassNextSubmission = false;
            return;
          }

          const action = await showWarningDialog(activeFindings, {
            onFeedback: (finding, feedbackLabel, correctedLabels) =>
              saveFindingFeedback(finding, feedbackLabel, correctedLabels),
            onAllowlist: async (finding) => {
              await allowlistFinding(finding);
              sessionAllowlistedValues.add(finding.originalValue);
            },
          });

          if (
            action !== 'cancel' &&
            !submissionContextIsCurrent(text)
          ) {
            updateHealth(Boolean(activeComposer));
            return;
          }

          let submissionResumed = false;
          let expectedSubmissionText = text;
          await applySubmissionDecision({
            action,
            originalText: text,
            findings: activeFindings,
            replaceText: (nextText) => {
              expectedSubmissionText = nextText;
              integration.replaceComposerText(submittedComposer, nextText);
            },
            submit: async () => {
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
              if (!submissionContextIsCurrent(expectedSubmissionText)) {
                updateHealth(Boolean(activeComposer));
                return;
              }
              bypassNextSubmission = true;
              submissionResumed = integration.resumeSubmission(submittedComposer);
              if (!submissionResumed) {
                bypassNextSubmission = false;
                updateHealth(false);
              }
            },
            focusComposer: () => {
              if (submittedComposer.isConnected) submittedComposer.focus();
              else activeComposer?.focus();
            },
          });
          if (action !== 'send-anyway' || submissionResumed) {
            recordTextOutcome(action, activeFindings);
          }
        })
        .catch(() => {
          // The semantic stage fails closed into deterministic results. Reaching this
          // catch means the fresh scan itself failed, so do not trap the site's send.
          if (submittedComposer.isConnected) {
            bypassNextSubmission = true;
            const resumed = integration.resumeSubmission(submittedComposer);
            if (!resumed) bypassNextSubmission = false;
          }
        })
        .finally(() => {
          warningOpen = false;
        });
    };

    const handleDocumentClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('button,[role="button"]')) {
        return;
      }
      refreshIntegration();
      if (activeComposer && integration.isSendButtonEvent(event, activeComposer)) {
        interceptSubmission(event);
      }
    };

    const handleDocumentKeydown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter') return;
      refreshIntegration();
      if (activeComposer && integration.isEnterSubmission(event, activeComposer)) {
        interceptSubmission(event);
      }
    };

    const replayFileSelection = (input: HTMLInputElement, files?: File[]): boolean => {
      if (!input.isConnected) return false;
      try {
        if (files) {
          const transfer = new DataTransfer();
          for (const file of files) transfer.items.add(file);
          input.files = transfer.files;
        }
        bypassFileEvents.set(input, 2);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      } catch {
        bypassFileEvents.delete(input);
        return false;
      }
    };

    const fileScanOptions = (): FileScanOptions => {
      const detectorSettings = settings ? { ...settings.detectors } : undefined;
      return {
        scanner: (text) => scanText(text, detectorSettings),
      };
    };

    const selectionLimitResults = (
      files: File[],
      message: string,
    ): FileScanResult[] => {
      const onlyFile = files.length === 1 ? files[0] : undefined;
      return [{
        status: 'unscannable',
        fileName: onlyFile?.name ?? `${files.length} selected files`,
        fileSize: files.reduce((total, file) => total + Math.max(0, file.size), 0),
        extension: onlyFile ? getFileExtension(onlyFile.name) : null,
        format: onlyFile ? getSupportedFileFormat(onlyFile) : null,
        findings: [],
        sanitizationAvailable: false,
        reason: 'extraction-limit-exceeded',
        message,
      }];
    };

    const recordFileOutcome = (action: FileWarningAction, results: FileScanResult[]) => {
      const mappedAction = historyAction(action);
      if (!mappedAction) return;
      const findings = results.flatMap((result) =>
        result.status === 'scanned' ? result.findings : [],
      );
      if (findings.length > 0) {
        void recordFindingsHistory(integration.id, findings, mappedAction).catch(() => {
          debugLog('History', 'Could not save local file activity metadata');
        });
      }
    };

    const createSanitizedSelection = async (
      originalFiles: File[],
      results: FileScanResult[],
      mode: 'redact' | 'replace-safe',
      scanOptions: FileScanOptions,
    ): Promise<File[] | null> => {
      const output: File[] = [];
      for (let index = 0; index < originalFiles.length; index += 1) {
        const file = originalFiles[index];
        const result = results[index];
        if (!file || !result) return null;
        if (result.status !== 'scanned' || result.findings.length === 0) {
          output.push(file);
          continue;
        }
        const sanitized = await createSanitizedFile(file, mode, {
          ...scanOptions,
          // Reuse the exact reviewed findings even if settings change while the dialog is open.
          scanner: () => result.findings,
        });
        if (sanitized.status !== 'created') return null;
        output.push(sanitized.file);
      }
      return output;
    };

    const processSelectedFiles = async (input: HTMLInputElement, originalFiles: File[]) => {
      const scanOptions = fileScanOptions();
      const limitMessage = getFileSelectionLimitMessage(originalFiles);
      const results: FileScanResult[] = limitMessage
        ? selectionLimitResults(originalFiles, limitMessage)
        : [];
      if (!limitMessage) {
        for (const file of originalFiles) {
          results.push(await scanLocalFile(file, scanOptions));
        }
      }
      const issues = results.filter(
        (result) => result.status === 'unscannable' || result.findings.length > 0,
      );
      const warningCount = issues.reduce(
        (count, result) => count + (result.status === 'scanned' ? result.findings.length : 1),
        0,
      );
      countSessionCheck(warningCount);

      if (issues.length === 0) {
        if (!replayFileSelection(input, originalFiles)) {
          updateHealth(Boolean(activeComposer));
        }
        return;
      }

      fileWarningOpen = true;
      try {
        const action = await showFileWarningDialog(results);
        if (action === 'cancel') {
          recordFileOutcome(action, results);
          input.value = '';
          return;
        }
        if (action === 'upload-original') {
          if (replayFileSelection(input, originalFiles)) {
            recordFileOutcome(action, results);
          }
          return;
        }

        const sanitizedFiles = await createSanitizedSelection(
          originalFiles,
          results,
          action === 'redact-copy' ? 'redact' : 'replace-safe',
          scanOptions,
        );
        if (!sanitizedFiles || !replayFileSelection(input, sanitizedFiles)) {
          input.value = '';
          updateHealth(Boolean(activeComposer));
          return;
        }
        recordFileOutcome(action, results);
      } finally {
        fileWarningOpen = false;
      }
    };

    const handleFileEvent = (event: Event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || input.type !== 'file') return;

      const bypassCount = bypassFileEvents.get(input) ?? 0;
      if (bypassCount > 0) {
        if (bypassCount === 1) bypassFileEvents.delete(input);
        else bypassFileEvents.set(input, bypassCount - 1);
        return;
      }
      if (!isProtectionEnabled()) return;
      refreshIntegration();
      const protectedInput = activeComposer
        ? integration.findFileInput(document, activeComposer)
        : null;
      const dynamicAttachmentInput = integration.supportsDynamicFileInput &&
        isLikelyDynamicAttachmentInput(input);
      if (input !== protectedInput && !dynamicAttachmentInput) return;

      if (fileTransactionActive || processingFileInputs.has(input) || fileWarningOpen) {
        stopSiteEvent(event);
        input.value = '';
        return;
      }
      const selectedFiles = Array.from(input.files ?? []);
      if (selectedFiles.length === 0) return;

      // Capture both native input and change before page handlers can start an upload.
      stopSiteEvent(event);
      input.value = '';
      fileTransactionActive = true;
      processingFileInputs.add(input);
      void processSelectedFiles(input, selectedFiles)
        .catch(() => {
          input.value = '';
          updateHealth(Boolean(activeComposer));
          debugLog('File', 'Selected files could not be processed');
        })
        .finally(() => {
          processingFileInputs.delete(input);
          fileTransactionActive = false;
        });
    };

    const handleUnsupportedFileGesture = (event: DragEvent | ClipboardEvent) => {
      const transfer = 'dataTransfer' in event ? event.dataTransfer : event.clipboardData;
      const files = Array.from(transfer?.files ?? []);
      if (files.length === 0 || !isProtectionEnabled()) return;

      refreshIntegration();
      if (!activeComposer) return;
      const target = event.target;
      const mount = integration.getStatusMount(activeComposer);
      if (
        !(target instanceof Node) ||
        !(target === activeComposer || activeComposer.contains(target) || mount.contains(target))
      ) {
        return;
      }

      stopSiteEvent(event);
      if (fileTransactionActive || fileWarningOpen) return;

      fileTransactionActive = true;
      fileWarningOpen = true;
      countSessionCheck(files.length);
      const message =
        'File protection unavailable on this site for drag-and-drop or pasted files. Use the attachment button so PreSend can scan before upload.';
      const results = selectionLimitResults(files, message);
      void showFileWarningDialog(results, {
        allowUploadOriginal: false,
        cancelLabel: 'Close',
        description: 'File protection unavailable on this site for this upload method.',
        privacyText: 'PreSend blocked this upload method without reading file contents.',
      }).finally(() => {
        fileWarningOpen = false;
        fileTransactionActive = false;
      });
    };

    window.addEventListener('input', handleFileEvent, true);
    window.addEventListener('change', handleFileEvent, true);
    window.addEventListener('drop', handleUnsupportedFileGesture, true);
    window.addEventListener('paste', handleUnsupportedFileGesture, true);
    document.addEventListener('click', handleDocumentClick, true);
    document.addEventListener('keydown', handleDocumentKeydown, true);

    const startObserver = () => {
      if (!document.documentElement) return;
      const observer = new MutationObserver(scheduleIntegrationRefresh);
      observer.observe(document.documentElement, { childList: true, subtree: true });
      refreshIntegration();
    };

    browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || (!changes.settings && !changes.storageSchemaVersion)) return;
      void getSettings().then((nextSettings) => {
        settings = nextSettings;
        refreshIntegration();
      }).catch(() => {
        updateHealth(false);
      });
    });

    browser.runtime.onMessage.addListener((message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === storageMessageTypes.getCurrentIntegrationHealth
      ) {
        // Mutation recovery is intentionally throttled, so refresh synchronously when the
        // popup asks. This prevents an SPA route change from reporting the previous composer.
        refreshIntegration();
        const textMonitoringActive = Boolean(activeComposer?.isConnected && monitor);
        return Promise.resolve(currentIntegrationHealth(textMonitoringActive));
      }
      return undefined;
    });

    void getSettings().then((loadedSettings) => {
      settings = loadedSettings;
      if (document.documentElement) startObserver();
      else document.addEventListener('DOMContentLoaded', startObserver, { once: true });
    }).catch(() => {
      settings = null;
      updateHealth(false);
      debugLog(integration.scope, 'Local settings unavailable; protection failed open');
    });
  },
});
