/**
 * Request body transformation for the Anthropic billing-header plugin.
 *
 * The plugin must mutate the outgoing request body to make Anthropic's
 * classifier attribute the request to a first-party Claude Code
 * invocation. Three layers of transformations:
 *
 *   1. The `system[]` array must start with the Claude Code identity
 *      block (since March 16, 2026 for OAuth Sonnet/Opus).
 *   2. The first system block must ALSO be the billing-attestation
 *      sentinel (`x-anthropic-billing-header: ...`). The two
 *      requirements are satisfied with three entries:
 *        system[0] = identity (Claude Code)
 *        system[1] = billing header (billing attestation)
 *        system[2..] = original content (preserved)
 *      The order matters — Anthropic's cch verification expects the
 *      billing block to be the first system entry; the identity block
 *      must be the very first text the model sees.
 *
 *   3. JSON key order in the serialized body must be deterministic:
 *      `system` first, then `messages`, then everything else. Claude
 *      Code emits the body in this order; our cch hash preimage (see
 *      `cch.ts`) assumes this order.
 */

import { createHash } from 'crypto';
import { BILLING_SALT, CLAUDE_CODE_IDENTITY_TEXT } from './constants';

/** Compute the 3-char SHA-256 suffix cc_version component. */
export function computeVersionSuffix(
  firstUserText: string,
  version: string,
): string {
  const sampled =
    (firstUserText[4] || '0') +
    (firstUserText[7] || '0') +
    (firstUserText[20] || '0');
  return createHash('sha256')
    .update(`${BILLING_SALT}${sampled}${version}`)
    .digest('hex')
    .slice(0, 3);
}

/**
 * Pull the first user-message text from the outgoing request body.
 * Supports string-form content and array-form content with a
 * `{ type: 'text', text }` (Anthropic) or `{ type: 'input_text', text }`
 * (OpenAI-style) block. Returns '' when no user message is found.
 */
export function extractFirstUserText(
  requestBody: Readonly<Record<string, unknown>>,
): string {
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

/**
 * The expected shape of every element we put in `system[]`. We avoid
 * adding `cache_control` to identity/billing blocks (they're never
 * cached; their content changes every request).
 */
interface SystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

function isBillingHeaderBlock(block: SystemBlock): boolean {
  return typeof block.text === 'string' && block.text.startsWith('x-anthropic-billing-header:');
}

function isIdentityBlock(block: SystemBlock): boolean {
  return block.text === CLAUDE_CODE_IDENTITY_TEXT;
}

/** Convert whatever form of `system` upstream provided into a SystemBlock[]. */
function normalizeSystemBlocks(
  rawSystem: unknown,
): SystemBlock[] {
  if (typeof rawSystem === 'string') {
    return [{ type: 'text', text: rawSystem }];
  }
  if (Array.isArray(rawSystem)) {
    const blocks: SystemBlock[] = [];
    for (const entry of rawSystem) {
      if (typeof entry === 'string') {
        blocks.push({ type: 'text', text: entry });
        continue;
      }
      if (entry && typeof entry === 'object') {
        const e = entry as Record<string, unknown>;
        if (typeof e['text'] === 'string') {
          const block: SystemBlock = { type: 'text', text: e['text'] as string };
          if (
            e['cache_control'] &&
            typeof e['cache_control'] === 'object'
          ) {
            block.cache_control = e['cache_control'] as { type: 'ephemeral' };
          }
          blocks.push(block);
        }
      }
    }
    return blocks;
  }
  return [];
}

/** Drop any existing identity or billing-header block (idempotent). */
function stripExistingFingerprint(blocks: SystemBlock[]): SystemBlock[] {
  return blocks.filter(
    (b) => !isIdentityBlock(b) && !isBillingHeaderBlock(b),
  );
}

/**
 * Build the final `system[]` array: identity first, billing header second,
 * then any original blocks (cache_control preserved).
 */
export function buildSystemArray(
  rawSystem: unknown,
  billingBlock: SystemBlock,
): SystemBlock[] {
  const identity: SystemBlock = { type: 'text', text: CLAUDE_CODE_IDENTITY_TEXT };
  const cleaned = stripExistingFingerprint(normalizeSystemBlocks(rawSystem));
  return [identity, billingBlock, ...cleaned];
}

/**
 * Pick the top-level keys to preserve and serialize in Claude Code's order:
 * `system`, `messages`, `model`, `max_tokens`, `tools`, `tool_choice`,
 * `temperature`, `top_p`, `top_k`, `stop_sequences`, `stream`, `metadata`,
 * `thinking`. Unknown keys are NOT preserved (would let unrelated upstream
 * fields contaminate the cch preimage).
 */
const ORDERED_KEYS = [
  'system',
  'messages',
  'model',
  'max_tokens',
  'tools',
  'tool_choice',
  'temperature',
  'top_p',
  'top_k',
  'stop_sequences',
  'stream',
  'metadata',
  'thinking',
] as const;

export function buildFinalBody(
  original: Readonly<Record<string, unknown>>,
  systemArray: SystemBlock[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  out['system'] = systemArray;
  for (const key of ORDERED_KEYS) {
    if (key === 'system') continue; // already set above
    if (key in original) out[key] = original[key];
  }
  return out;
}

/** Stringify a request body without inserting whitespace — wire-faithful. */
export function serializeBody(body: Record<string, unknown>): string {
  return JSON.stringify(body);
}

/** Build the placeholder `x-anthropic-billing-header:` text block. */
export function buildBillingBlock(
  billingHeaderText: string,
): SystemBlock {
  return {
    type: 'text',
    text: `x-anthropic-billing-header: ${billingHeaderText}`,
  };
}

/** Build the `x-anthropic-billing-header` HTTP header value. */
export function buildBillingHeaderValue(
  version: string,
  suffix: string,
  cch: string,
  entrypoint: string,
): string {
  return `cc_version=${version}.${suffix}; cc_entrypoint=${entrypoint}; cch=${cch};`;
}

/**
 * Augment an outgoing Messages URL with `?beta=true`. Claude Code emits
 * this on every OAuth request; absent flags cause 4xx upstream.
 *
 * Returns the URL unchanged when:
 *   - the path is not `/v1/messages`, OR
 *   - `beta=true` is already present.
 *
 * Preserves any existing query params (appends with `&`).
 */
export function withBetaQuery(url: string): string {
  const messagesIdx = url.indexOf('/v1/messages');
  // Only apply to a `/v1/messages` call (with or without query/fragment).
  if (messagesIdx === -1) return url;
  const endpoint = messagesIdx + '/v1/messages'.length;
  const head = url.slice(0, endpoint);
  const tail = url.slice(endpoint);
  if (/[?&]beta=true(?:&|$)/.test(tail)) return url;
  const separator = tail.length === 0 || tail.startsWith('?') ? '' : '&';
  return `${head}${separator}beta=true${tail}`;
}