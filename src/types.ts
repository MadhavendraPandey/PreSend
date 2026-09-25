export type Severity = 'critical' | 'high' | 'medium' | 'low';

export type DetectorName =
  | 'privateKey'
  | 'awsKey'
  | 'githubToken'
  | 'openAiKey'
  | 'anthropicKey'
  | 'stripeKey'
  | 'slackToken'
  | 'bearerToken'
  | 'databaseUrl'
  | 'secretAssignment'
  | 'jsonSecret'
  | 'httpHeader'
  | 'email'
  | 'phoneNumber'
  | 'internalHostname'
  | 'semantic';

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface FindingFeatures {
  source: 'signature' | 'structured' | 'contextual' | 'semantic';
  lengthBucket: 'short' | 'medium' | 'long' | 'very-long';
  entropyBucket: 'low' | 'medium' | 'high';
  placeholderLike: boolean;
  structures: string[];
}

export interface Finding {
  id: string;
  detector: DetectorName;
  category: string;
  severity: Severity;
  confidence: number;
  startIndex: number;
  endIndex: number;
  originalValue: string;
  maskedPreview: string;
  replacementValue: string;
  safeExampleValue: string;
  explanation: string;
  features: FindingFeatures;
  replacementSafe?: boolean;
}

export type MonitorState =
  | { kind: 'monitoring' }
  | { kind: 'checking' }
  | { kind: 'complete'; findingCount: number }
  | { kind: 'unavailable' };

export type WarningAction = 'replace-safe' | 'redact' | 'send-anyway' | 'cancel';

export type FeedbackLabel = 'correct' | 'not-sensitive' | 'wrong-category';

export type SiteId =
  | 'chatgpt'
  | 'claude'
  | 'gemini'
  | 'perplexity'
  | 'deepseek'
  | 'grok';

export type SiteName =
  | 'ChatGPT'
  | 'Claude'
  | 'Gemini'
  | 'Perplexity'
  | 'DeepSeek'
  | 'Grok';

export type HistoryRetentionDays = 7 | 30 | 90 | null;

export interface SiteSettings {
  chatgpt: boolean;
  claude: boolean;
  gemini: boolean;
  perplexity: boolean;
  deepseek: boolean;
  grok: boolean;
}

export interface DetectorSettings {
  credentials: boolean;
  privateKeys: boolean;
  databaseCredentials: boolean;
  emails: boolean;
  phoneNumbers: boolean;
  internalHosts: boolean;
}

export interface PreSendSettings {
  protectionEnabled: boolean;
  semanticDetection: boolean;
  feedbackContributionEnabled: boolean;
  feedbackContributionConsent: boolean;
  sites: SiteSettings;
  detectors: DetectorSettings;
  history: {
    enabled: boolean;
    retentionDays: HistoryRetentionDays;
  };
}

export type HistoryAction =
  | 'redacted'
  | 'safe-example'
  | 'sent-anyway'
  | 'cancelled';

export interface HistoryEvent {
  id: string;
  timestamp: number;
  site: SiteId;
  categories: string[];
  severity: Severity;
  confidence: ConfidenceLevel;
  action: HistoryAction;
  findingCount: number;
}

export interface FeedbackRecord {
  id: string;
  detector: DetectorName;
  category: string;
  severity: Severity;
  confidence: ConfidenceLevel;
  feedbackLabel: FeedbackLabel;
  timestamp: number;
  valueFingerprint: string;
  features: FindingFeatures;
}

export type ContributionFeedback = 'correct' | 'not_sensitive' | 'wrong_category';

export interface FeedbackContributionPayload {
  text: string;
  predicted_labels: string[];
  predicted_scores: Record<string, number>;
  feedback: ContributionFeedback;
  corrected_labels: string[];
  model_version: string;
  extension_version: string;
  created_at: string;
}

export interface PendingFeedbackContribution {
  id: string;
  payload: FeedbackContributionPayload;
}

export interface AllowlistEntry {
  id: string;
  fingerprint: string;
  detector?: DetectorName;
  category: string;
  createdAt: number;
}

export interface IntegrationHealth {
  site: SiteName;
  siteId?: SiteId;
  protectionEnabled?: boolean;
  protection: 'protected' | 'unavailable';
  scanner: 'ready' | 'unavailable';
  siteRecognized?: boolean;
  composerDetected?: boolean;
  monitoringActive?: boolean;
  textProtection?: 'protected' | 'unavailable';
  fileProtection?: 'protected' | 'unavailable';
  updatedAt: number;
}

export interface SessionStats {
  date: string;
  checks: number;
  warnings: number;
}
