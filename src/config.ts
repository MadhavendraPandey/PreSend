export const FEEDBACK_BACKEND_URL = 'https://feedback.presend.app/feedback';

export const CONFIG = {
  typingScanDelayMs: 1_500,
  pasteScanDelayMs: 100,
  integrationRecoveryDelayMs: 250,
  debug: false,
  detectors: {
    privateKey: true,
    awsKey: true,
    providerTokens: true,
    bearerToken: true,
    databaseUrl: true,
    secretAssignment: true,
    structuredJson: true,
    httpHeaders: true,
    personalData: true,
    internalHostnames: true,
  },
  supportedSites: [
    'chatgpt.com',
    'claude.ai',
    'gemini.google.com',
    'perplexity.ai',
    'www.perplexity.ai',
    'chat.deepseek.com',
    'grok.com',
  ],
  history: {
    enabledByDefault: false,
    sanitizedPreviewEnabledByDefault: false,
  },
  feedback: {
    maxRecords: 500,
    maxAllowlistEntries: 200,
    maxPendingContributions: 100,
    maxContributionTextCharacters: 5_000,
    backendUrl: FEEDBACK_BACKEND_URL,
    modelVersion: 'minilm-logreg-1354-fp32',
  },
} as const;

export function debugLog(scope: string, message: string): void {
  if (!CONFIG.debug) {
    return;
  }

  // Messages passed here must describe operations only. Never pass prompt text or findings.
  console.debug(`[PreSend][${scope}] ${message}`);
}
