import {
  findChatGptFileInput,
  findComposer as findChatGptComposer,
  findSendButton as findChatGptSendButton,
  getStatusMount as getChatGptStatusMount,
  isChatGptPage,
  isEnterSubmission as isChatGptEnterSubmission,
  isSendButtonEvent as isChatGptSendButtonEvent,
  readComposerText as readChatGptComposerText,
  replaceComposerText as replaceChatGptComposerText,
  resumeChatGptSubmission,
} from './chatgpt';
import {
  findClaudeComposer,
  findClaudeFileInput,
  findClaudeSendButton,
  getClaudeStatusMount,
  isClaudeEnterSubmission,
  isClaudePage,
  isClaudeSendButtonEvent,
  readClaudeComposerText,
  replaceClaudeComposerText,
  resumeClaudeSubmission,
} from './claude';
import {
  findDeepSeekComposer,
  findDeepSeekFileInput,
  findDeepSeekSendButton,
  getDeepSeekStatusMount,
  isDeepSeekEnterSubmission,
  isDeepSeekPage,
  isDeepSeekSendButtonEvent,
  readDeepSeekComposerText,
  replaceDeepSeekComposerText,
  resumeDeepSeekSubmission,
} from './deepseek';
import {
  findGeminiComposer,
  findGeminiFileInput,
  hasGeminiFileInterceptionControl,
  findGeminiSendButton,
  getGeminiStatusMount,
  isGeminiEnterSubmission,
  isGeminiPage,
  isGeminiSendButtonEvent,
  readGeminiComposerText,
  replaceGeminiComposerText,
  resumeGeminiSubmission,
} from './gemini';
import {
  findGrokComposer,
  findGrokFileInput,
  findGrokSendButton,
  getGrokStatusMount,
  isGrokEnterSubmission,
  isGrokPage,
  isGrokSendButtonEvent,
  readGrokComposerText,
  replaceGrokComposerText,
  resumeGrokSubmission,
} from './grok';
import {
  findPerplexityComposer,
  findPerplexityFileInput,
  findPerplexitySendButton,
  getPerplexityStatusMount,
  isPerplexityEnterSubmission,
  isPerplexityPage,
  isPerplexitySendButtonEvent,
  readPerplexityComposerText,
  replacePerplexityComposerText,
  resumePerplexitySubmission,
} from './perplexity';

export type SupportedSiteId =
  | 'chatgpt'
  | 'claude'
  | 'gemini'
  | 'perplexity'
  | 'deepseek'
  | 'grok';

export interface SiteIntegration {
  id: SupportedSiteId;
  name: string;
  scope: string;
  supportsDynamicFileInput?: boolean;
  hasFileInterceptionControl?: (
    documentRoot?: Document,
    composer?: HTMLElement,
  ) => boolean;
  matchesPage: (locationLike?: Pick<Location, 'hostname'>) => boolean;
  findComposer: (documentRoot?: Document) => HTMLElement | null;
  readComposerText: (composer: HTMLElement) => string;
  replaceComposerText: (composer: HTMLElement, text: string) => void;
  isSendButtonEvent: (event: MouseEvent, composer: HTMLElement) => boolean;
  isEnterSubmission: (event: KeyboardEvent, composer: HTMLElement) => boolean;
  getStatusMount: (composer: HTMLElement) => HTMLElement;
  resumeSubmission: (composer: HTMLElement) => boolean;
  findSendButton: (composer: HTMLElement, documentRoot?: Document) => HTMLElement | null;
  findFileInput: (
    documentRoot?: Document,
    composer?: HTMLElement,
  ) => HTMLInputElement | null;
}

export const siteIntegrations: readonly SiteIntegration[] = [
  {
    id: 'chatgpt', name: 'ChatGPT', scope: 'ChatGPT', matchesPage: isChatGptPage,
    findComposer: findChatGptComposer, readComposerText: readChatGptComposerText,
    replaceComposerText: replaceChatGptComposerText, isSendButtonEvent: isChatGptSendButtonEvent,
    isEnterSubmission: isChatGptEnterSubmission, getStatusMount: getChatGptStatusMount,
    resumeSubmission: resumeChatGptSubmission, findSendButton: findChatGptSendButton,
    findFileInput: findChatGptFileInput,
  },
  {
    id: 'claude', name: 'Claude', scope: 'Claude', matchesPage: isClaudePage,
    supportsDynamicFileInput: true,
    findComposer: findClaudeComposer, readComposerText: readClaudeComposerText,
    replaceComposerText: replaceClaudeComposerText, isSendButtonEvent: isClaudeSendButtonEvent,
    isEnterSubmission: isClaudeEnterSubmission, getStatusMount: getClaudeStatusMount,
    resumeSubmission: resumeClaudeSubmission, findSendButton: findClaudeSendButton,
    findFileInput: findClaudeFileInput,
  },
  {
    id: 'gemini', name: 'Gemini', scope: 'Gemini', matchesPage: isGeminiPage,
    supportsDynamicFileInput: true,
    hasFileInterceptionControl: hasGeminiFileInterceptionControl,
    findComposer: findGeminiComposer, readComposerText: readGeminiComposerText,
    replaceComposerText: replaceGeminiComposerText, isSendButtonEvent: isGeminiSendButtonEvent,
    isEnterSubmission: isGeminiEnterSubmission, getStatusMount: getGeminiStatusMount,
    resumeSubmission: resumeGeminiSubmission, findSendButton: findGeminiSendButton,
    findFileInput: findGeminiFileInput,
  },
  {
    id: 'perplexity', name: 'Perplexity', scope: 'Perplexity', matchesPage: isPerplexityPage,
    supportsDynamicFileInput: true,
    findComposer: findPerplexityComposer, readComposerText: readPerplexityComposerText,
    replaceComposerText: replacePerplexityComposerText,
    isSendButtonEvent: isPerplexitySendButtonEvent,
    isEnterSubmission: isPerplexityEnterSubmission, getStatusMount: getPerplexityStatusMount,
    resumeSubmission: resumePerplexitySubmission, findSendButton: findPerplexitySendButton,
    findFileInput: findPerplexityFileInput,
  },
  {
    id: 'deepseek', name: 'DeepSeek', scope: 'DeepSeek', matchesPage: isDeepSeekPage,
    findComposer: findDeepSeekComposer, readComposerText: readDeepSeekComposerText,
    replaceComposerText: replaceDeepSeekComposerText, isSendButtonEvent: isDeepSeekSendButtonEvent,
    isEnterSubmission: isDeepSeekEnterSubmission, getStatusMount: getDeepSeekStatusMount,
    resumeSubmission: resumeDeepSeekSubmission, findSendButton: findDeepSeekSendButton,
    findFileInput: findDeepSeekFileInput,
  },
  {
    id: 'grok', name: 'Grok', scope: 'Grok', matchesPage: isGrokPage,
    findComposer: findGrokComposer, readComposerText: readGrokComposerText,
    replaceComposerText: replaceGrokComposerText, isSendButtonEvent: isGrokSendButtonEvent,
    isEnterSubmission: isGrokEnterSubmission, getStatusMount: getGrokStatusMount,
    resumeSubmission: resumeGrokSubmission, findSendButton: findGrokSendButton,
    findFileInput: findGrokFileInput,
  },
];

export function getSiteIntegration(
  locationLike: Pick<Location, 'hostname'> = window.location,
): SiteIntegration | null {
  return siteIntegrations.find((integration) => integration.matchesPage(locationLike)) ?? null;
}

export function siteNameForHostname(hostname: string): string | null {
  return getSiteIntegration({ hostname } as Location)?.name ?? null;
}
