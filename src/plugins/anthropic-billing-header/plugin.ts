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
  CC_ANTHROPIC_BETA,
  CC_ANTHROPIC_VERSION,
  CC_ENTRYPOINT,
  CC_USER_AGENT,
  CC_X_APP,
  CCH_PLACEHOLDER,
  DEFAULT_CC_VERSION,
} from './constants';
import {
  buildBillingBlock,
  buildFinalBody,
  buildSystemArray,
  computeVersionSuffix,
  extractFirstUserText,
  serializeBody,
  type SystemBlock,
  withBetaQuery,
} from './body';
import {
  prependMovedContentToFirstUserMessage,
  relocateSystemContent,
} from './system-relocation';
import { cchHasherReady, computeCchForBody } from './cch';

export { cchHasherReady };

export const ANTHROPIC_BILLING_HEADER_PLUGIN_KIND: PluginKind = 'transform';

function readRelocateEnabled(): boolean {
  const raw = process.env['MANIFEST_CC_RELOCATE'];
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'no' && v !== 'off';
}

export const ANTHROPIC_BILLING_HEADER_PLUGIN_METADATA: PluginMetadata = Object.freeze({
  id: 'anthropic-billing-header',
  name: 'Anthropic billing header',
  version: '0.5.0',
  description:
    'Injects Anthropic subscription billing header + body fingerprint (xxHash64 cch, billing-first system[], fingerprint HTTP headers, beta=true).',
  kind: ANTHROPIC_BILLING_HEADER_PLUGIN_KIND,
});

export class AnthropicBillingHeaderPlugin implements RequestTransformPlugin {
  static readonly metadata: PluginMetadata = ANTHROPIC_BILLING_HEADER_PLUGIN_METADATA;
  transformRequest(
    decision: RequestTransformDecision,
  ): RequestTransformResult | undefined {
    // Gate: only Anthropic + subscription OAuth
    const isAnthropic = decision.endpointKey === 'anthropic';
    const isSubscription = decision.authType === 'subscription';
    if (!isAnthropic || !isSubscription) return undefined;

    const rawSystem = decision.requestBody['system'];

    // S6: Relocate opencode-fingerprinted system[] entries to the first user
    // message so Anthropic's billing classifier routes the request against the
    // subscription pool instead of the extra-usage pool.
    let bodyForSigning: Readonly<Record<string, unknown>> = decision.requestBody;
    let systemSource: unknown = rawSystem;
    if (readRelocateEnabled()) {
      let relocated: { readonly kept: readonly SystemBlock[]; readonly moved: string };
      try {
        relocated = relocateSystemContent(rawSystem, {});
      } catch {
        relocated = { kept: [], moved: '' };
      }
      systemSource = relocated.kept;
      if (relocated.moved !== '') {
        try {
          bodyForSigning = prependMovedContentToFirstUserMessage(
            decision.requestBody,
            relocated.moved,
            {},
          );
        } catch {
          bodyForSigning = decision.requestBody;
          systemSource = rawSystem;
        }
      }
    }

    const firstUserText = extractFirstUserText(bodyForSigning);
    const version = process.env['MANIFEST_CC_VERSION'] || DEFAULT_CC_VERSION;
    const suffix = computeVersionSuffix(firstUserText, version);

    // Placeholder cch=00000 to compute the body bytes the real cch hashes.
    const placeholderHeaderValue = `cc_version=${version}.${suffix}; cc_entrypoint=${CC_ENTRYPOINT}; cch=${CCH_PLACEHOLDER};`;
    const placeholderBillingBlock = buildBillingBlock(placeholderHeaderValue);
    const placeholderSystemArray = buildSystemArray(systemSource, placeholderBillingBlock);

    const placeholderBody = buildFinalBody(bodyForSigning, placeholderSystemArray);
    const serializedBody = serializeBody(placeholderBody);

    const envCch = process.env['MANIFEST_CCH_VALUE'];
    const cchOverride = envCch?.trim().replace(/^cch=/, '');
    const cch = cchOverride && /^[0-9a-f]{5}$/.test(cchOverride)
      ? cchOverride
      : computeCchForBody(serializedBody, version);

    const finalHeaderValue = `cc_version=${version}.${suffix}; cc_entrypoint=${CC_ENTRYPOINT}; cch=${cch};`;
    const finalBillingBlock = buildBillingBlock(finalHeaderValue);

    // Replace only systemArray[0] with the final billing block (placeholder
    // → final), preserving the relocated/non-relocated original system entries
    // verbatim.
    const finalSystemArray = placeholderSystemArray.map((block, idx) =>
      idx === 0 ? finalBillingBlock : block,
    );

    const finalFinalBody = buildFinalBody(bodyForSigning, finalSystemArray);
    void serializeBody(finalFinalBody);

    const finalUrl = withBetaQuery(decision.url);

    return {
      url: finalUrl,
      headers: {
        ...decision.headers,
        'x-anthropic-billing-header': finalHeaderValue,
        'user-agent': CC_USER_AGENT,
        'anthropic-beta': CC_ANTHROPIC_BETA,
        'anthropic-version': CC_ANTHROPIC_VERSION,
        'x-app': CC_X_APP,
      },
      requestBody: finalFinalBody as Readonly<Record<string, unknown>>,
    };
  }
}

// Re-export the test-only consumer for the eager hasher init promise.
// Kept separate from the production class export so the registry can tree-shake.
void cchHasherReady;
