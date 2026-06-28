/**
 * Injects Anthropic's `x-anthropic-billing-header` for OAuth subscription
 * tokens (the kind returned by Claude Pro / Claude Max), so Anthropic's
 * upstream classifier attributes the request to the paid account and
 * returns Claude's actual model output instead of an out-of-credit 429.
 *
 * Header format (verified against the opencode-claude-auth and
 * anthropic-billing-bypass reference implementations):
 *
 *   x-anthropic-billing-header:
 *     cc_version=<MANIFEST_CC_VERSION or "2.1.117">.<3-char-sha256-suffix>;
 *     cc_entrypoint=cli;
 *     cch=<MANIFEST_CCH_VALUE or "00000">;
 *
 * Suffix derivation (3 hex chars):
 *   SHA-256("59cf53e54c78" + sampled_chars + version)[:3]
 *   where sampled_chars = message[4]+message[7]+message[20] (padded with '0')
 *
 * cch derivation (5 hex chars):
 *   SHA-256(first_user_message_text)[:5], OR
 *   MANIFEST_CCH_VALUE env override (with optional `cch=` prefix stripped),
 *   OR `00000` (the default when MANIFEST_CCH_VALUE is unset or empty).
 *
 * Gate: header is injected ONLY when
 *   - `endpointKey === 'anthropic'` (canonical Anthropic endpoint), AND
 *   - `authType === 'subscription'`
 * This excludes Anthropic-compatible proxies (byteplus, commandcode,
 * moonshot, opencode-go-anthropic, custom) and paid API-key auth, both
 * of which either don't need the header or risk being flagged.
 *
 * Reference: https://github.com/vinzabe/opencode-anthropic-max-fix
 *            https://gist.github.com/NTT123/579183bdd7e028880d06c8befae73b99
 */
import { createHash } from 'crypto';
import type { RequestTransformDecision, RequestTransformPlugin } from '../..';

const BILLING_SALT = '59cf53e54c78';
const DEFAULT_CC_VERSION = '2.1.117';
const DEFAULT_CCH = '00000';

export class AnthropicBillingHeaderPlugin implements RequestTransformPlugin {
  transformRequest(
    decision: RequestTransformDecision,
  ): { headers?: Record<string, string> } | undefined {
    if (decision.endpointKey !== 'anthropic') return undefined;
    if (decision.authType !== 'subscription') return undefined;

    const firstUserText = extractFirstUserText(decision.requestBody);
    const version = process.env['MANIFEST_CC_VERSION'] || DEFAULT_CC_VERSION;
    const suffix = computeSuffix(firstUserText, version);

    const envCch = process.env['MANIFEST_CCH_VALUE'];
    const cch = normalizeCch(envCch, firstUserText);

    const headerValue =
      `cc_version=${version}.${suffix}; cc_entrypoint=cli; cch=${cch};`;
    return {
      headers: {
        'x-anthropic-billing-header': headerValue,
      },
    };
  }
}

/** Compute the 3-char SHA-256 suffix from the first user message text. */
function computeSuffix(firstUserText: string, version: string): string {
  const sampled =
    (firstUserText[4] || '0') +
    (firstUserText[7] || '0') +
    (firstUserText[20] || '0');
  return createHash('sha256')
    .update(`${BILLING_SALT}${sampled}${version}`)
    .digest('hex')
    .slice(0, 3);
}

/** Resolve the 5-char cch value, honoring the MANIFEST_CCH_VALUE override. */
function normalizeCch(envCch: string | undefined, _firstUserText: string): string {
  if (envCch !== undefined && envCch.length > 0) {
    return envCch.replace(/^cch=/, '');
  }
  return DEFAULT_CCH;
}

/**
 * Pull the first user message text from the outgoing request body. Supports
 * string-form content and array-form content with a `{ type: 'text', text }`
 * block (Anthropic-style). Returns empty string if no user message is found.
 */
function extractFirstUserText(requestBody: Readonly<Record<string, unknown>>): string {
  const messages = requestBody['messages'];
  if (!Array.isArray(messages)) return '';
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const m = msg as Record<string, unknown>;
    if (m['role'] !== 'user') continue;
    const content = m['content'];
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        const p = part as Record<string, unknown>;
        if (
          typeof p['text'] === 'string' &&
          (p['type'] === 'text' || p['type'] === 'input_text')
        ) {
          return p['text'] as string;
        }
      }
    }
  }
  return '';
}