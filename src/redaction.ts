import type { Finding } from './types';
import { scanText } from './scanner';

function applyFindingReplacements(
  text: string,
  findings: Finding[],
  replacementFor: (finding: Finding) => string,
): string {
  const sortedFindings = [...findings].sort(
    (left, right) => right.startIndex - left.startIndex,
  );
  let redactedText = text;
  let latestAppliedStart = text.length;

  for (const finding of sortedFindings) {
    if (finding.replacementSafe === false) continue;
    const hasValidRange =
      finding.startIndex >= 0 &&
      finding.endIndex > finding.startIndex &&
      finding.endIndex <= text.length;
    const overlapsAppliedFinding = finding.endIndex > latestAppliedStart;

    if (!hasValidRange || overlapsAppliedFinding) {
      continue;
    }

    redactedText =
      redactedText.slice(0, finding.startIndex) +
      replacementFor(finding) +
      redactedText.slice(finding.endIndex);
    latestAppliedStart = finding.startIndex;
  }

  return redactedText;
}

export function redactText(text: string, findings: Finding[]): string {
  return applyFindingReplacements(text, findings, (finding) => finding.replacementValue);
}

const semanticPlaceholders: Record<string, string> = {
  'Business-sensitive information': 'Example_Business_Detail',
  'Customer-specific information': 'Example_Customer',
  'Employee-sensitive information': 'Example_Employee',
  'Non-public financial information': 'Example_Amount',
  'Unreleased product information': 'Example_Product',
  'Security-sensitive information': 'Example_Security_Detail',
  'Legal-sensitive information': 'Example_Legal_Detail',
  'Proprietary technical information': 'Example_Technical_Detail',
};

const semanticContextPatterns: Record<string, RegExp> = {
  'Business-sensitive information': /\b(?:strategy|acquisition|pricing|partnership|pipeline|deal|plan|board)\b/gi,
  'Customer-specific information': /\b(?:customer|client|account|tenant|contract|renewal|deployment)\b/gi,
  'Employee-sensitive information': /\b(?:employee|staff|salary|performance|candidate|leave|medical|termination)\b/gi,
  'Non-public financial information': /\b(?:revenue|forecast|margin|budget|amount|cash|cost|earnings|financial)\b/gi,
  'Unreleased product information': /\b(?:product|launch|feature|roadmap|release|project|codename)\b/gi,
  'Security-sensitive information': /\b(?:security|vulnerability|incident|access|control|exploit|credential)\b/gi,
  'Legal-sensitive information': /\b(?:legal|contract|litigation|settlement|counsel|terms)\b/gi,
  'Proprietary technical information': /\b(?:architecture|algorithm|source|implementation|design|code|technical)\b/gi,
};

function safePlaceholder(finding: Finding): string {
  if (finding.detector === 'semantic') {
    return semanticPlaceholders[finding.category] ?? 'Example_Sensitive_Detail';
  }
  if (finding.detector === 'databaseUrl') {
    const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(finding.originalValue)?.[1]?.toLowerCase();
    return `${scheme ?? 'database'}://dummylink`;
  }
  if (finding.detector === 'email') return 'example@example.com';
  if (finding.detector === 'phoneNumber') return '202-555-0100';
  if (finding.detector === 'internalHostname') return 'example.internal';
  if (finding.detector === 'privateKey') return 'Example_Private_Key';
  if (finding.detector === 'bearerToken' || finding.detector === 'githubToken' ||
      finding.detector === 'stripeKey' || finding.detector === 'slackToken') {
    return 'Example_Token';
  }
  if (finding.detector === 'awsKey' || finding.detector === 'openAiKey' ||
      finding.detector === 'anthropicKey') {
    return 'Example_API_Key';
  }
  if (finding.detector === 'httpHeader') {
    return finding.category === 'Session cookie' ? 'Example_Cookie' : 'Example_API_Key';
  }
  if (finding.category === 'Password') return 'Example_Password';
  if (finding.category === 'API key') return 'Example_API_Key';
  if (finding.category === 'Access token') return 'Example_Token';
  if (finding.category === 'Private key value') return 'Example_Private_Key';
  if (finding.category === 'Assigned secret') return 'Example_Secret';
  return 'Example_Sensitive_Value';
}

function countMatches(value: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  return Array.from(value.matchAll(pattern)).length;
}

function capturedRange(value: string, pattern: RegExp): { start: number; end: number } | null {
  const match = pattern.exec(value);
  const captured = match?.[1];
  if (!match || !captured) return null;
  const capturedOffset = match[0].lastIndexOf(captured);
  const start = match.index + capturedOffset;
  return { start, end: start + captured.length };
}

function smallestSemanticValue(value: string, category: string): { start: number; end: number } | null {
  if (category === 'Customer-specific information') {
    return capturedRange(
      value,
      /\b(?:[Cc]ustomer|[Cc]lient|[Aa]ccount|[Tt]enant)\s+(?:named\s+)?([A-Z][\w&.-]*(?:\s+[A-Z][\w&.-]*){0,2})/,
    );
  }
  if (category === 'Employee-sensitive information') {
    return capturedRange(
      value,
      /\b(?:[Ee]mployee|[Ss]taff member|[Cc]andidate)\s+(?:named\s+)?([A-Z][\w'.-]*(?:\s+[A-Z][\w'.-]*){0,2})/,
    );
  }
  if (category === 'Non-public financial information') {
    return capturedRange(
      value,
      /([$€£]\s*\d[\d,]*(?:\.\d+)?\s*(?:%|percent|million|billion|thousand|[KMB])?)/i,
    ) ?? capturedRange(
      value,
      /(?:^|[^\w])((?:\d[\d,]*(?:\.\d+)?)\s*(?:%|percent|million|billion|thousand|[KMB]))(?=$|[^\w])/i,
    );
  }
  if (category === 'Unreleased product information') {
    return capturedRange(
      value,
      /\b(?:[Pp]roject|[Pp]roduct|[Ff]eature|[Cc]odename)\s+([A-Z][\w.-]*(?:\s+[A-Z][\w.-]*){0,2})/,
    );
  }
  return capturedRange(
    value,
    /\b((?:20\d{2}|19\d{2})[-/]\d{1,2}[-/]\d{1,2}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,\s*(?:19|20)\d{2})?)\b/i,
  );
}

function narrowSemanticFinding(text: string, finding: Finding): Finding {
  const start = Math.max(0, finding.startIndex);
  const end = Math.min(text.length, finding.endIndex);
  if (end <= start) return finding;

  const passage = text.slice(start, end);
  const segments = Array.from(
    passage.matchAll(/[\s\S]+?(?:[!?;]+|\.(?=\s|$)|\r?\n|$)/g),
  );
  if (segments.length === 0) return finding;
  const contextPattern = semanticContextPatterns[finding.category];
  let selected = segments[0]!;

  if (segments.length > 1 && contextPattern) {
    const ranked = segments
      .map((segment, index) => ({ segment, index, score: countMatches(segment[0], contextPattern) }))
      .sort((left, right) => right.score - left.score || left.index - right.index);
    if ((ranked[0]?.score ?? 0) === 0) return finding;
    selected = ranked[0]!.segment;
  } else if (segments.length > 1) {
    return finding;
  }

  const raw = selected[0];
  const segmentOffset = selected.index ?? 0;
  const leadingWhitespace = raw.length - raw.trimStart().length;
  const withoutLeading = raw.slice(leadingWhitespace);
  const contentLength = withoutLeading.replace(/[\s.!?;]+$/g, '').length;
  if (contentLength === 0) return finding;
  const narrowedStart = start + segmentOffset + leadingWhitespace;
  const narrowedEnd = narrowedStart + contentLength;
  const selectedValue = text.slice(narrowedStart, narrowedEnd);
  const semanticValue = smallestSemanticValue(selectedValue, finding.category);
  const finalStart = semanticValue ? narrowedStart + semanticValue.start : narrowedStart;
  const finalEnd = semanticValue ? narrowedStart + semanticValue.end : narrowedEnd;

  return {
    ...finding,
    startIndex: finalStart,
    endIndex: finalEnd,
    originalValue: text.slice(finalStart, finalEnd),
  };
}

export function replaceWithSafeExamples(text: string, findings: Finding[]): string {
  const replacementsByOriginalValue = new Map<string, string>();
  const replacementFor = (finding: Finding): string => {
    const existingReplacement = replacementsByOriginalValue.get(finding.originalValue);
    if (existingReplacement) {
      return existingReplacement;
    }
    const safeExample = safePlaceholder(finding);
    replacementsByOriginalValue.set(finding.originalValue, safeExample);
    return safeExample;
  };

  const targetedFindings = findings.map((finding) =>
    finding.detector === 'semantic' ? narrowSemanticFinding(text, finding) : finding,
  );
  const replaced = applyFindingReplacements(text, targetedFindings, replacementFor);
  const remainingFindings = scanText(replaced);
  if (remainingFindings.length === 0) return replaced;
  return applyFindingReplacements(replaced, remainingFindings, replacementFor);
}
