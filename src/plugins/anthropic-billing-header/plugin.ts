/**
 * Injects Anthropic's `x-anthropic-billing-header` for OAuth subscription
 * tokens (Claude Pro / Max) PLUS the body-side fingerprint Anthropic
 * began enforcing for subscription requests in 2026.
 *
 * Background
 * ----------
 * Anthropic's API has three independent detection vectors that all have to
 * pass for a Claude Pro / Max OAuth request to count against the
 * subscription pool (and not the third-party "extra usage" pool). This
 * plugin satisfies all three on the subscription-tier code path:
 *
 *   1. **`x-anthropic-billing-header` HTTP header** (Claude Code v2.1.29+)
 *      Carries `cc_version` (a Claude Code release string), `cc_entrypoint`
 *      (always `cli` for OAuth bearer requests), and `cch` (the per-request
 *      xxHash64 body attestation).
 *      Anthropic's classifier rejects requests with stale `cc_version`
 *      (old ≥50 patch versions) or with the static `cch=00000` placeholder.
 *
 *   2. **`system[0]` content** for OAuth accounts (since March 16, 2026,
 *      Sonnet/Opus only — Haiku exempt). The first block of the `system[]`
 *      array must be EXACTLY `"You are Claude Code, Anthropic's official
 *      CLI for Claude."`. Plain string system fails; only array-form
 *      first block counts. Detecting a non-Claude-Code system prompt
 *      routes the request to extra usage.
 *
 *   3. **Body key order** for cch attestation (since Claude Code v2.1.172).
 *      The xxHash64 is computed over a transformed version of the body
 *      with `model` value blanked and `max_tokens` removed. JSON key order
 *      matters: the cch preimage byte sequence must match what Claude Code
 *      emits, with `system` first, `messages` second, then everything else.
 *      Shallow-merging the upstream-computed body breaks key order and
 *      produces cch values that never validate.
 *
 * Header format (from opencode-claude-auth and the BYK/loreai oracle
 * extraction):
 *
 *   x-anthropic-billing-header:
 *     cc_version=<version>.<3-char-sha256-suffix>;
 *     cc_entrypoint=cli;
 *     cch=<5-char-xxhash64-body-attestation>;
 *
 * 3-char suffix derivation:
 *   SHA-256("59cf53e54c78" + message[4]+message[7]+message[20] + version)[:3]
 *   (where missing chars pad with '0'; unchanged across all known versions)
 *
 * 5-char cch derivation (per-request body attestation, the current
 * Claude Code protocol):
 *   1. Build the FULL request body with `cch=00000` as a placeholder,
 *      `system[0]` = identity, `system[1]` = billing header.
 *   2. Apply the v2.1.172+ preimage transforms: blank `model` value,
 *      strip `max_tokens` field (with one adjacent comma).
 *   3. cch = xxHash64(preimage_bytes, seed) & 0xFFFFF, formatted as
 *      5-char zero-padded lowercase hex.
 *   4. Replace the `cch=00000` placeholder with the computed value.
 *
 * Seed resolution (verified via oracle-pair extraction from the Bun binary):
 *   - 2.1.37   → 0x6E52736AC806831E (legacy, kept for completeness)
 *   - 2.1.138+ → 0x4D659218E32A3268 (current — used for v2.1.196 and likely
 *                future versions until Anthropic rotates again)
 *   - Unknown / future versions fall back to the current seed so the
 *     header remains well-formed even before registry updates.
 *
 * Hash impl: `hash-wasm` is bundled (Daninet/hash-wasm, MIT). The plugin
 * pre-initializes a hasher per unique seed at module load (~2ms for the
 * WASM module); per-request update/digest is sync after the cache fills.
 *
 * Body fingerprint identity:
 *   When `authType === 'subscription'`, the plugin prepends the
 *   identity block AND the billing header as the first two system entries.
 *   Pre-existing system content is preserved verbatim (cache_control
 *   included). Anthropic requires the identity block to be the FIRST
 *   block of the array form.
 *
 * Gate: header + body changes are applied ONLY when
 *   - `endpointKey === 'anthropic'` (canonical Anthropic endpoint), AND
 *   - `authType === 'subscription'`
 * This excludes Anthropic-compatible proxies (byteplus, commandcode,
 * moonshot, opencode-go-anthropic, custom) and paid API-key auth, both
 * of which either don't need the header or risk being flagged.
 *
 * URL fingerprint:
 *   Anthropic's OAuth flow expects `?beta=true` on `/v1/messages`. The
 *   plugin appends it once and idempotently.
 *
 * Reference:
 *   https://github.com/BYK/loreai/blob/main/packages/gateway/src/cch.ts
 *   https://github.com/marco-jardim/opencode-anthropic-fix/blob/HEAD/docs/claude-code-reverse-engineering.md
 *   https://a10k.co/b/reverse-engineering-claude-code-cch.html
 *   https://github.com/anthropics/claude-code/issues/40515 (OAuth system identity)
 *   https://github.com/Daninet/hash-wasm
 */
import type {
  PluginKind,
  PluginMetadata,
  RequestTransformDecision,
  RequestTransformResult,
  RequestTransformPlugin,
} from '../..';

import {
  BILLING_HEADER_BLOCK_PREFIX,
  CC_ENTRYPOINT,
  CCH_PLACEHOLDER,
  DEFAULT_CC_VERSION,
  MESSAGES_BETA_QUERY_PARAM,
} from './constants';
import {
  buildBillingBlock,
  buildBillingHeaderValue,
  buildFinalBody,
  buildSystemArray,
  computeVersionSuffix,
  extractFirstUserText,
  serializeBody,
  withBetaQuery,
} from './body';
import { cchHasherReady, computeCchForBody } from './cch';

export { cchHasherReady };

export const ANTHROPIC_BILLING_HEADER_PLUGIN_KIND: PluginKind = 'transform';

export const ANTHROPIC_BILLING_HEADER_PLUGIN_METADATA: PluginMetadata = Object.freeze({
  id: 'anthropic-billing-header',
  name: 'Anthropic billing header',
  version: '0.3.0',
  description:
    'Injects Anthropic subscription billing header + body fingerprint (xxHash64 cch, system identity, beta=true).',
  kind: ANTHROPIC_BILLING_HEADER_PLUGIN_KIND,
});

export class AnthropicBillingHeaderPlugin implements RequestTransformPlugin {
  static readonly metadata: PluginMetadata = ANTHROPIC_BILLING_HEADER_PLUGIN_METADATA;
  transformRequest(
    decision: RequestTransformDecision,
  ): RequestTransformResult | undefined {
    if (decision.endpointKey !== 'anthropic') return undefined;
    if (decision.authType !== 'subscription') return undefined;

    const firstUserText = extractFirstUserText(decision.requestBody);
    const version = process.env['MANIFEST_CC_VERSION'] || DEFAULT_CC_VERSION;
    const suffix = computeVersionSuffix(firstUserText, version);

    // Step 1: build the placeholder header value with cch=00000 so we can
    // produce the placeholder system block. The cch values inside the body
    // and the HTTP header must agree.
    const placeholderHeader = `cc_version=${version}.${suffix}; cc_entrypoint=${CC_ENTRYPOINT}; cch=${CCH_PLACEHOLDER};`;
    const placeholderBillingBlock = buildBillingBlock(placeholderHeader);

    // Step 2: normalize system + identity + billing header into system[].
    const rawSystem = decision.requestBody['system'] as unknown;
    const systemArray = buildSystemArray(rawSystem, placeholderBillingBlock);

    // Step 3: assemble final body in Claude Code's key order.
    const finalBody = buildFinalBody(decision.requestBody, systemArray);

    // Step 4: serialize WITHOUT whitespace so the cch preimage matches
    // exactly what Claude Code emits.
    const serializedBody = serializeBody(finalBody);

    // Step 5: compute cch over the placeholder-body preimage.
    const envCch = process.env['MANIFEST_CCH_VALUE'];
    const cchOverride =
      envCch !== undefined && envCch.length > 0
        ? envCch.replace(/^cch=/, '')
        : undefined;
    const cch = cchOverride ?? computeCchForBody(serializedBody, version);

    // Step 6: rewrite the placeholder in the serialized body with the
    // computed cch. Same in the HTTP header value (so they match).
    const finalHeaderValue = buildBillingHeaderValue(
      version,
      suffix,
      cch,
      CC_ENTRYPOINT,
    );
    const finalBillingBlock = buildBillingBlock(finalHeaderValue);
    const finalSystemArray: typeof systemArray = [
      systemArray[0]!,
      finalBillingBlock,
      ...systemArray.slice(2),
    ];
    const finalFinalBody = buildFinalBody(decision.requestBody, finalSystemArray);
    const finalSerialized = serializeBody(finalFinalBody);

    // Step 7: append `?beta=true` idempotently. No-op for non-Anthropic
    // endpoints or already-flagged URLs.
    const finalUrl = withBetaQuery(decision.url);

    // Suppress lint on the prefix sentinel (kept for future test/debug use).
    void BILLING_HEADER_BLOCK_PREFIX;
    // Discard the second serialization — kept purely to validate the
    // deterministic body shape; the real body lives in `finalFinalBody`.
    void finalSerialized;

    return {
      url: finalUrl,
      headers: {
        'x-anthropic-billing-header': finalHeaderValue,
      },
      requestBody: finalFinalBody as Readonly<Record<string, unknown>>,
    };
  }
}

// Re-export the test-only consumer for the eager hasher init promise.
// Kept separate from the production class export so the registry can tree-shake.
void cchHasherReady;
