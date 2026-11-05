/**
 * Decide whether an upstream error means "you are out of quota / rate limited"
 * (so a fallback is appropriate) versus a genuine request problem that should
 * be shown to Claude Code unchanged (bad model name, invalid request, ...).
 */
const LIMIT_PATTERNS = [
  /usage limit/i,
  /rate.?limit/i,
  /quota/i,
  /too many requests/i,
  /limit (has been )?(reached|exceeded)/i,
  /(session|weekly|hourly|daily|monthly) limit/i,
  /insufficient (credits|balance|funds)/i,
  /out of credits/i,
  /upgrade (your )?plan/i,
  /payment required/i,
];

export function looksLikeLimit(body: string): boolean {
  return LIMIT_PATTERNS.some((re) => re.test(body));
}

export interface LimitCheck {
  status: number;
  body: string;
  triggerStatuses: number[];
}

export function isLimitError({ status, body, triggerStatuses }: LimitCheck): boolean {
  if (triggerStatuses.includes(status)) return true;
  // Some gateways report quota exhaustion as 403 or 400 with a telling message.
  if ((status === 403 || status === 400 || status === 503) && looksLikeLimit(body)) return true;
  return false;
}

export function limitReason(status: number, body: string): string {
  if (status === 402) return 'needs payment or credits (402)';
  if (status === 429)
    return /weekly/i.test(body)
      ? 'hit its weekly limit (429)'
      : /session/i.test(body)
        ? 'hit its session limit (429)'
        : 'is rate limiting (429)';
  if (status === 0) return 'is unreachable';
  return `returned ${status}`;
}
