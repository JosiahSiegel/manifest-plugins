/**
 * cch attestation module for the Anthropic billing-header plugin.
 *
 * The `cch` field of `x-anthropic-billing-header` is a per-request xxHash64
 * attestation computed over the FULL serialized request body with the
 * `model` value blanked and `max_tokens` removed (Claude Code v2.1.172+).
 *
 * The xxHash64 seed is a 64-bit constant baked into Claude Code's compiled
 * Bun binary. It ROTATES occasionally. The current verified seed
 * (`0x4D659218E32A3268`) is used by Claude Code v2.1.138 and later,
 * including the current v2.1.196.
 *
 * Reference (oracle-pair extraction):
 *   https://github.com/BYK/loreai/blob/main/packages/gateway/src/cch.ts
 *   https://github.com/marco-jardim/opencode-anthropic-fix/blob/HEAD/docs/claude-code-reverse-engineering.md
 *
 * Algorithm:
 *   1. Build the request body JSON with `cch=00000` placeholder
 *   2. Apply the v2.1.172+ preimage transform: blank `model` value,
 *      remove `max_tokens` field
 *   3. cch = xxHash64(preimage_bytes, seed) & 0xFFFFF → 5-char hex
 *   4. Replace `cch=00000` with computed value
 */

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

import { CCH_MASK, CCH_PLACEHOLDER } from './constants';

/**
 * Version → seed registry. Verified by oracle-pair extraction from
 * the Claude Code Bun binary. Bump `CURRENT_FALLBACK_SEED` when
 * Anthropic ships a new seed for a future Claude Code release.
 *
 * The hash-wasm API takes the seed as (seedLow, seedHigh) 32-bit
 * halves to preserve precision (Claude Code's seed exceeds JS
 * Number.MAX_SAFE_INTEGER).
 */
interface SeedPair {
  readonly seedHigh: number;
  readonly seedLow: number;
}

const SEED_2_1_37: SeedPair = { seedHigh: 0x6e52736a, seedLow: 0xc806831e };
/** Verified current seed (v2.1.138+ through v2.1.196 as of 2026-06-29). */
const SEED_CURRENT: SeedPair = { seedHigh: 0x4d659218, seedLow: 0xe32a3268 };

/**
 * Map of Claude Code version → seed. Versions not listed fall back to
 * SEED_CURRENT. Add new versions here when the extraction tool
 * publishes a new seed (see BYK/loreai commit log for the pattern).
 */
const VERSION_SEEDS: Record<string, SeedPair> = {
  '2.1.37': SEED_2_1_37,
  '2.1.138': SEED_CURRENT,
  '2.1.139': SEED_CURRENT,
  '2.1.140': SEED_CURRENT,
  '2.1.141': SEED_CURRENT,
  '2.1.142': SEED_CURRENT,
  '2.1.143': SEED_CURRENT,
  '2.1.144': SEED_CURRENT,
  '2.1.145': SEED_CURRENT,
  '2.1.146': SEED_CURRENT,
  '2.1.147': SEED_CURRENT,
  '2.1.148': SEED_CURRENT,
  '2.1.149': SEED_CURRENT,
  '2.1.150': SEED_CURRENT,
  '2.1.153': SEED_CURRENT,
  '2.1.154': SEED_CURRENT,
  '2.1.156': SEED_CURRENT,
  '2.1.157': SEED_CURRENT,
  '2.1.158': SEED_CURRENT,
  '2.1.159': SEED_CURRENT,
  '2.1.160': SEED_CURRENT,
  '2.1.161': SEED_CURRENT,
  '2.1.162': SEED_CURRENT,
  '2.1.163': SEED_CURRENT,
  '2.1.165': SEED_CURRENT,
  '2.1.166': SEED_CURRENT,
  '2.1.167': SEED_CURRENT,
  '2.1.168': SEED_CURRENT,
  '2.1.169': SEED_CURRENT,
  '2.1.170': SEED_CURRENT,
  '2.1.172': SEED_CURRENT,
  '2.1.173': SEED_CURRENT,
  '2.1.175': SEED_CURRENT,
  '2.1.176': SEED_CURRENT,
  '2.1.177': SEED_CURRENT,
  '2.1.178': SEED_CURRENT,
  '2.1.179': SEED_CURRENT,
  '2.1.181': SEED_CURRENT,
  '2.1.182': SEED_CURRENT,
  '2.1.183': SEED_CURRENT,
  '2.1.185': SEED_CURRENT,
  '2.1.186': SEED_CURRENT,
  '2.1.187': SEED_CURRENT,
  '2.1.190': SEED_CURRENT,
  '2.1.191': SEED_CURRENT,
  '2.1.193': SEED_CURRENT,
  '2.1.195': SEED_CURRENT,
  '2.1.196': SEED_CURRENT,
};

function resolveSeed(version: string): SeedPair {
  // Exact match
  const exact = VERSION_SEEDS[version];
  if (exact !== undefined) return exact;

  // Unknown / future version — fall back to the current seed so signing
  // still produces a value (the cch may not validate, but our header
  // shape is correct, and the upgrade path is to add an entry above).
  return SEED_CURRENT;
}

// =============================================================================
// Per-seed hasher cache
// =============================================================================
//
// Each unique seed gets its own xxHash64 hasher. The hash-wasm WASM module
// is initialized once via the same promise; the sync per-request API is then
// idempotent and ~µs/call.

interface CchHasher {
  init: () => unknown;
  update: (data: Buffer) => unknown;
  digest: (outputType: 'hex' | 'binary') => string | Uint8Array;
}

const hasherCache: Map<string, CchHasher> = new Map();

function hasherCacheKey(pair: SeedPair): string {
  return `${pair.seedHigh.toString(16)}:${pair.seedLow.toString(16)}`;
}

/**
 * Initialize one hasher per unique SeedPair used by the registry. Called
 * once at module load; subsequent reads from `hasherCache` are sync.
 *
 * The returned promise is also re-exported so tests can `await` it for
 * deterministic assertions instead of racing the WASM compile.
 */
function initAllHashers(): Promise<void> {
  const pairs = new Set<string>();
  for (const version of Object.keys(VERSION_SEEDS)) {
    pairs.add(hasherCacheKey(resolveSeed(version)));
  }
  return Promise.all(
    Array.from(pairs).map(async (key) => {
      if (hasherCache.has(key)) return;
      const pair = VERSION_SEEDS[
        Object.keys(VERSION_SEEDS).find((v) => hasherCacheKey(VERSION_SEEDS[v]!) === key) ?? ''
      ];
      // Fallback for the synthetic key from the closure: re-derive from any
      // version with the same pair.
      let resolvedPair: SeedPair | undefined = pair;
      if (resolvedPair === undefined) {
        for (const v of Object.keys(VERSION_SEEDS)) {
          const p = VERSION_SEEDS[v]!;
          if (hasherCacheKey(p) === key) {
            resolvedPair = p;
            break;
          }
        }
      }
      if (resolvedPair === undefined) return;
      try {
        const hasher = await hashWasm.createXXHash64(
          resolvedPair.seedLow,
          resolvedPair.seedHigh,
        );
        hasherCache.set(key, hasher);
      } catch {
        /* swallow: cold-start fallback to 00000 is documented */
      }
    }),
  ).then(() => undefined);
}

const initHasherPromise: Promise<void> = initAllHashers();

/**
 * Awaitable for tests and explicit module-load readiness checks.
 * Production code does NOT need to await this — see notes above.
 */
export const cchHasherReady: Promise<void> = initHasherPromise;

// =============================================================================
// cch preimage transform (v2.1.172+)
// =============================================================================
//
// Anthropic's classifier hashes a transformed version of the request body,
// NOT the wire body, when computing cch. The transform is verified by
// capturing the live hash input under a debugger (BYK/loreai quality/CCH.md):
//   1. `cch=<5hex>` → `cch=00000` (the placeholder we always emit)
//   2. the `model` VALUE removed: `"model":"sonnet-4"` → `"model":""`
//   3. the `max_tokens` field removed (with the adjacent comma stripped):
//      `"max_tokens":64000,` → `` (real binary strips the trailing comma)
//
// We always apply both edits — both are no-ops when the field is absent
// (test bodies or worker requests without `max_tokens`), keeping the
// function safe to call unconditionally.

const MODEL_VALUE_RE = /("model":")[^"]*(")/;
const MAX_TOKENS_FIELD_RE = /"max_tokens":\d+,|,"max_tokens":\d+/;

/**
 * Transform a serialized request body into the exact byte sequence
 * Claude Code (>= 2.1.172) feeds to xxHash64 when computing the `cch`
 * billing hash. Then hash it with the version-resolved seed.
 *
 * Returns the formatted 5-char lowercase hex cch token, or
 * `CCH_PLACEHOLDER` (`00000`) if anything throws.
 */
export function computeCchForBody(
  serializedBody: string,
  version: string,
): string {
  const hasher = hasherCache.get(hasherCacheKey(resolveSeed(version)));
  if (hasher === undefined) return CCH_PLACEHOLDER;

  try {
    const preimage = serializedBody
      .replace(MODEL_VALUE_RE, '$1$2')
      .replace(MAX_TOKENS_FIELD_RE, '');
    hasher.init();
    hasher.update(Buffer.from(preimage, 'utf8'));
    const hexDigest = hasher.digest('hex') as string;
    // hexDigest is a 16-char zero-padded hex of the full 64-bit hash.
    // Mask to lower 20 bits and reformat to 5 lowercase hex chars.
    const fullHash = BigInt(`0x${hexDigest}`);
    return (fullHash & CCH_MASK).toString(16).padStart(5, '0');
  } catch {
    return CCH_PLACEHOLDER;
  }
}
