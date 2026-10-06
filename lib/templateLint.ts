/**
 * Deliverability lint for the outreach template — advisory warnings shown
 * live in Automation Settings. Pure and dependency-free so the browser can
 * run the exact same checks the compose form does.
 *
 * These are heuristics, not gates: nothing here blocks a send.
 */

export interface TemplateLintInput {
  subject: string;
  body: string;
  intervalSeconds?: number;
}

/** Phrases that trip spam filters more often than they win replies. */
const SPAM_PHRASES = [
  "act now",
  "100% free",
  "free money",
  "guaranteed",
  "risk-free",
  "risk free",
  "no credit card",
  "winner",
  "congratulations",
  "click here",
  "limited time",
  "buy now",
  "order now",
  "cash bonus",
  "earn extra",
  "double your",
  "exclusive deal",
  "special promotion",
  "investment opportunity",
  "make money fast",
  "no obligation",
  "urgent response",
  "don't delete",
  "once in a lifetime",
];

const SHORTENER_PATTERN = /\b(bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd|ow\.ly|cutt\.ly)\/\S*/i;

/**
 * Warnings for one subject/body pair. Order is presentation order —
 * subject issues first, then body, then pacing.
 */
export function lintTemplate({ subject, body, intervalSeconds }: TemplateLintInput): string[] {
  const issues: string[] = [];
  const subjectTrimmed = subject.trim();
  const bodyTrimmed = body.trim();

  if (subjectTrimmed.length > 80) {
    issues.push("Subject is longer than 80 characters — shorter subjects read (and deliver) better.");
  }
  if (/^(re|fwd?)\s*:/i.test(subjectTrimmed)) {
    issues.push('Subject starts with “Re:/FW:” without an existing thread — a classic spam signal.');
  }
  if (/(^|\s)[A-Z]{4,}(\s|$)/.test(subjectTrimmed) && subjectTrimmed === subjectTrimmed.toUpperCase()) {
    issues.push("Subject is ALL CAPS.");
  }
  if (/!{3,}|\?{3,}/.test(subjectTrimmed)) {
    issues.push("Subject has “!!!” / “???” — tone it down.");
  }

  const haystack = `${subjectTrimmed}\n${bodyTrimmed}`.toLowerCase();
  for (const phrase of SPAM_PHRASES) {
    if (haystack.includes(phrase)) {
      issues.push(`Contains “${phrase}” — spam filters flag it and it hurts reply rates.`);
    }
  }
  if (SHORTENER_PATTERN.test(haystack)) {
    issues.push("Shortened links (bit.ly etc.) look untrustworthy — paste the full URL.");
  }
  if (/!{3,}/.test(bodyTrimmed)) {
    issues.push("Body has three or more exclamation marks in a row.");
  }

  const shoutyWords = (bodyTrimmed.match(/(^|\s)[A-Z]{4,}(?=\s|$)/g) ?? []).length;
  if (shoutyWords >= 3) {
    issues.push(`Body shouts in ${shoutyWords} ALL-CAPS words — capitalize normally.`);
  }

  if (bodyTrimmed.length > 0 && bodyTrimmed.length < 40) {
    issues.push("Body is very short — a sentence or two more feels less like a blast.");
  }
  if (bodyTrimmed.length > 600 && !bodyTrimmed.includes("\n\n")) {
    issues.push("Body is a single wall of text — add paragraph breaks.");
  }

  if (intervalSeconds !== undefined && intervalSeconds > 0 && intervalSeconds < 10) {
    issues.push("Sending faster than 10s apart risks Gmail throttling — 30–60s is safer.");
  }

  return issues;
}
