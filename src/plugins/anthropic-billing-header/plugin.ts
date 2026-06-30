/**
 * Injects Anthropic's `x-anthropic-billing-header` for OAuth subscription
 * tokens (the kind returned by Claude Pro / Claude Max), so Anthropic's
 * upstream classifier attributes the request to the paid account and
 * returns Claude's actual model output instead of an out-of-credit 400.
 *
 * Background
 * ----------
 * As of late March 2026 (Anthropic Claude Code v2.1.113+), Anthropic's API
 * routes Claude Pro/Max subscription requests with a stale or static
 * `x-anthropic-billing-header` to the "extra usage" billing path and
 * returns:
 *
 *     {"type":"error","error":{"type":"invalid_request_error",
 *      "message":"You're out of extra usage. Add more at
 *      claude.ai/settings/usage and keep going."}}
 *
 * Two detection dimensions matter:
 *   1. The `cc_version` field must match a recent Claude Code release
 *      within a sliding window. Stale by ≥~50 patch versions → flagged.
 *   2. The `cch` field is no longer a static placeholder. It is a
 *      per-request xxHash64 attestation over the serialized body that
 *      `cch=00000` will be substituted into. A static `cch=00000` gets
 *      flagged since v2.1.113+ (was previously allowed).
 *
 * Header format (verified against the opencode-claude-auth, marco-jardim
 * /opencode-anthropic-fix, and router-for-me/CLIProxyAPI reference
 * implementations, all reading Claude Code's Bun binary constants):
 *
 *   x-anthropic-billing-header:
 *     cc_version=<MANIFEST_CC_VERSION or "2.1.196">.<3-char-sha256-suffix>;
 *     cc_entrypoint=cli;
 *     cch=<5-char-xxhash64-body-attestation>;
 *
 * 3-char suffix derivation:
 *   SHA-256("59cf53e54c78" + message[4]+message[7]+message[20] + version)[:3]
 *   (where missing chars pad with '0'; unchanged from previous versions)
 *
 * 5-char cch derivation (per-request body attestation, replaces the old
 * SHA-256(message)[:5] which Anthropic stopped accepting in v2.1.113+):
 *   1. Build the request body the host will send, with
 *      `cch=00000` as a placeholder in the header text.
 *   2. Serialize that body to JSON with the same key order Claude Code
 *      uses (`system` first, then `messages`, then the rest).
 *   3. cch = xxHash64(serialized_body_bytes, seed=0x6E52736AC806831E)
 *            & 0xFFFFF, formatted as 5-char zero-padded lowercase hex.
 *   4. Replace the `cch=00000` placeholder with the computed value.
 *
 * The seed `0x6E52736AC806831E` is the constant baked into Claude Code's
 * compiled Bun binary (verified in RE sources, see README). Anthropic
 * rotates it per release; bump CCH_SEED if Anthropic ships a new binary
 * with a different constant.
 *
 * xxHash64 is provided by `hash-wasm` (Daninet/hash-wasm), an MIT-licensed
 * WASM build of the canonical xxHash64 algorithm. The plugin
 * pre-initializes a single hasher at module load (the WASM module takes
 * ~2ms to instantiate on first use) and re-uses it for every request via
 * its sync `init` / `update` / `digest` API. The seed is split into
 * low/high 32-bit halves because the Claude Code seed exceeds
 * JS Number.MAX_SAFE_INTEGER.
 *
 * Gate: header is injected ONLY when
 *   - `endpointKey === 'anthropic'` (canonical Anthropic endpoint), AND
 *   - `authType === 'subscription'`
 * This excludes Anthropic-compatible proxies (byteplus, commandcode,
 * moonshot, opencode-go-anthropic, custom) and paid API-key auth, both
 * of which either don't need the header or risk being flagged.
 *
 * Reference:
 *   https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/runtime/executor/claude_signing.go
 *   https://github.com/marco-jardim/opencode-anthropic-fix (docs/claude-code-reverse-engineering.md)
 *   https://a10k.co/b/reverse-engineering-claude-code-cch.html
 *   https://github.com/griffinmartin/opencode-claude-auth
 *   https://github.com/Daninet/hash-wasm
 */
import { createHash } from 'crypto';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const hashWasm: {
  createXXHash64: (
    seedLow?: number,
    seedHigh?: number,
  ) => Promise<{
    init: () => unknown;
    update: (data: Buffer) => unknown;
    digest: (outputType: 'hex' | 'binary') => string | Uint8Array;
  }>;
} = require('hash-wasm');
import type {
  PluginKind,
  PluginMetadata,
  RequestTransformDecision,
  RequestTransformPlugin,
} from '../..';

const BILLING_SALT = '59cf53e54c78';
/**
 * Latest published Claude Code version as of 2026-06-29.
 * Track the anthropics/claude-code release page
 * (https://github.com/anthropics/claude-code/releases) and bump this when
 * Anthropic ships a new release; otherwise requests route to "extra usage".
 */
const DEFAULT_CC_VERSION = '2.1.196';
/**
 * xxHash64 seed baked into Claude Code's compiled Bun binary for the
 * per-request cch body attestation. Verified against the Bun
 * disassembler output documented in
 * https://a10k.co/b/reverse-engineering-claude-code-cch.html and the Go
 * reference in router-for-me/CLIProxyAPI.
 *
 * Stored as two 32-bit halves because hash-wasm's `xxhash64` API takes
 * the seed as `(seedLow, seedHigh)` to preserve precision (the seed
 * exceeds JS Number.MAX_SAFE_INTEGER).
 */
const CCH_SEED_HI = 0x6e52736a;
const CCH_SEED_LO = 0xc806831e;
const CCH_MASK = 0xfffff; // lower 20 bits
/**
 * Static fallback when the body attestation cannot run (e.g. before the
 * hash-wasm WASM module has finished initializing, or on a serialization
 * error). Anthropic still accepts this for the first request of a session;
 * the eager module-load init ensures the real hasher is ready by the time
 * any HTTP request reaches the plugin in normal operation.
 */
const DEFAULT_CCH_PLACEHOLDER = '00000';

// =============================================================================
// Eager hasher initialization
// =============================================================================
//
// hash-wasm returns a Promise from `createXXHash64`, but the resulting
// `IHasher` object is fully synchronous to use. We kick off the
// initialization at module load and cache the resulting hasher in
// `cchHasherCache`. The first call to `transformRequest` will use the
// cached hasher if it's ready; otherwise it falls back to the static
// `00000` placeholder. The eager `void initCchHasher()` call below
// means the cache is populated BEFORE the host snippet calls
// `require('manifest-plugins')` on first use, in any realistic startup.
//
// Failure mode: if hash-wasm fails to load (e.g. on an unsupported
// engine), the catch handler leaves the cache empty and every cch falls
// back to `00000`. That mirrors Claude Code's npm-build behavior (the
// Bun-native attestation only runs in the compiled CLI; the npm build
// also ships a `00000` placeholder), and the host catches the resulting
// classifier rejection gracefully.

interface CchHasher {
  init: () => unknown;
  update: (data: Buffer) => unknown;
  digest: (outputType: 'hex' | 'binary') => string | Uint8Array;
}

let cchHasherCache: CchHasher | null = null;

function initCchHasher(): Promise<void> {
  return hashWasm
    .createXXHash64(CCH_SEED_LO, CCH_SEED_HI)
    .then((hasher) => {
      cchHasherCache = hasher;
    })
    .catch(() => {
      /* swallow: per-request fallback to 00000 is documented */
    });
}

// Fire-and-forget module-load eager init. The promise is also re-exported
// (via `cchHasherReady`) so tests can `await` it for deterministic
// assertions instead of racing the WASM compile.
void initCchHasher();

/** Test-only: await the eager hasher init. */
export const cchHasherReady: Promise<void> = initCchHasher();

export const ANTHROPIC_BILLING_HEADER_PLUGIN_KIND: PluginKind = 'transform';

export const ANTHROPIC_BILLING_HEADER_PLUGIN_METADATA: PluginMetadata = Object.freeze({
  id: 'anthropic-billing-header',
  name: 'Anthropic billing header',
  version: '0.2.0',
  description:
    'Injects Anthropic subscription billing headers (xxHash64 body-attested cch).',
  kind: ANTHROPIC_BILLING_HEADER_PLUGIN_KIND,
});

export class AnthropicBillingHeaderPlugin implements RequestTransformPlugin {
  static readonly metadata: PluginMetadata = ANTHROPIC_BILLING_HEADER_PLUGIN_METADATA;
  transformRequest(
    decision: RequestTransformDecision,
  ): { headers?: Record<string, string> } | undefined {
    if (decision.endpointKey !== 'anthropic') return undefined;
    if (decision.authType !== 'subscription') return undefined;

    const firstUserText = extractFirstUserText(decision.requestBody);
    const version = process.env['MANIFEST_CC_VERSION'] || DEFAULT_CC_VERSION;
    const suffix = computeSuffix(firstUserText, version);

    // The cch body attestation is computed over the wire bytes Claude Code
    // sends. Build a synthetic body with the billing header as the first
    // system block, serialize it, and xxHash64 the result.
    const envCch = process.env['MANIFEST_CCH_VALUE'];
    const cchOverride = normalizeCchOverride(envCch);
    const cch = cchOverride ?? computeCch(decision.requestBody, version, suffix);

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

/**
 * Honor a `MANIFEST_CCH_VALUE` override so operators can pin the cch to
 * a captured known-good value when Anthropic's classifier rejects the
 * body-attested cch (e.g. immediately after a seed rotation that we
 * haven't tracked yet). Returns undefined when the env var is unset or
 * empty, so the caller falls back to body attestation.
 */
function normalizeCchOverride(envCch: string | undefined): string | undefined {
  if (envCch === undefined || envCch.length === 0) return undefined;
  return envCch.replace(/^cch=/, '');
}

/**
 * Build the JSON serialization that Claude Code's Bun binary hashes for
 * the cch attestation. The billing header is the first system block; the
 * rest of the system array, messages, and tool definitions follow in the
 * same key order Claude Code emits.
 *
 * Key ordering matters: `system` must come before `messages` so that the
 * placeholder text appears before any user content (Claude Code's
 * substitution walks the wire bytes and hits the first `cch=00000` —
 * which would be a different position if `messages` preceded `system`).
 *
 * Stable JSON (insertion-ordered key map) is used so the hash is
 * deterministic for the same request body.
 */
function buildWireBody(
  requestBody: Readonly<Record<string, unknown>>,
  billingHeaderText: string,
): string {
  const out: Record<string, unknown> = {};
  out['system'] = [
    { type: 'text', text: `x-anthropic-billing-header: ${billingHeaderText}` },
  ];
  if (Array.isArray(requestBody['messages'])) out['messages'] = requestBody['messages'];
  if ('model' in requestBody) out['model'] = requestBody['model'];
  if ('max_tokens' in requestBody) out['max_tokens'] = requestBody['max_tokens'];
  if ('tools' in requestBody) out['tools'] = requestBody['tools'];
  if ('tool_choice' in requestBody) out['tool_choice'] = requestBody['tool_choice'];
  if ('temperature' in requestBody) out['temperature'] = requestBody['temperature'];
  if ('top_p' in requestBody) out['top_p'] = requestBody['top_p'];
  if ('top_k' in requestBody) out['top_k'] = requestBody['top_k'];
  if ('stop_sequences' in requestBody) out['stop_sequences'] = requestBody['stop_sequences'];
  if ('stream' in requestBody) out['stream'] = requestBody['stream'];
  if ('metadata' in requestBody) out['metadata'] = requestBody['metadata'];
  if ('thinking' in requestBody) out['thinking'] = requestBody['thinking'];
  return JSON.stringify(out);
}

/**
 * Compute the 5-char zero-padded lowercase hex cch token by
 * xxHash64-attesting the wire body using the pre-initialized hash-wasm
 * hasher. Returns the formatted token, or the placeholder `00000` if the
 * hasher is not yet ready (cold-start fallback) or anything throws
 * (defensive — never throw, since the host's `try/catch` would otherwise
 * drop the header entirely).
 */
function computeCch(
  requestBody: Readonly<Record<string, unknown>>,
  version: string,
  suffix: string,
): string {
  if (cchHasherCache === null) return DEFAULT_CCH_PLACEHOLDER;
  try {
    const placeholderHeader =
      `cc_version=${version}.${suffix}; cc_entrypoint=cli; cch=${DEFAULT_CCH_PLACEHOLDER};`;
    const wireBody = buildWireBody(requestBody, placeholderHeader);
    const hasher = cchHasherCache;
    hasher.init();
    hasher.update(Buffer.from(wireBody, 'utf8'));
    const hexDigest = hasher.digest('hex') as string;
    // hexDigest is a 16-char zero-padded hex of the full 64-bit hash.
    // Mask to lower 20 bits and reformat to 5 lowercase hex chars.
    const fullHash = BigInt(`0x${hexDigest}`);
    return (fullHash & BigInt(CCH_MASK)).toString(16).padStart(5, '0');
  } catch {
    return DEFAULT_CCH_PLACEHOLDER;
  }
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