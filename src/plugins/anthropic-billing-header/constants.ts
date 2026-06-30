/**
 * Constants for the Anthropic billing-header plugin.
 *
 * Every value here corresponds to one of:
 *   - A field in the `x-anthropic-billing-header` HTTP header
 *   - A classification rule Anthropic's servers run on the request
 *   - A bundle-version constant baked into Claude Code's compiled Bun binary
 *
 * Most values are version-sensitive. When Anthropic bumps the classifier
 * or rotates the seed, bump these and the plugin metadata version.
 */

/** Salt for the 3-char hex cc_version suffix (extracted from Claude Code). */
export const BILLING_SALT = '59cf53e54c78';

/**
 * Latest published Claude Code version as of 2026-06-29.
 * Track https://github.com/anthropics/claude-code/releases and bump when
 * Anthropic ships a new release; otherwise requests route to "extra usage".
 */
export const DEFAULT_CC_VERSION = '2.1.196';

/**
 * Anthropic requires the first block of any OAuth-authenticated Messages
 * request's `system[]` array to be exactly this string. Without it,
 * Sonnet/Opus return HTTP 400 (Haiku is exempt). Effective March 16, 2026.
 *
 * Reference: github.com/anthropics/claude-code/issues/40515 and
 * github.com/hoblin/anima/issues/233 — the rule is byte-exact:
 *   - "You are Claude Code, Anthropic's official CLI for Claude." (57 chars)
 *   - Must be the FIRST element of a JSON `system` array
 *   - Must be `{ type: "text", text: "..." }` form; plain string fails
 *
 * Only applies to `authType === 'subscription'` (OAuth bearer tokens).
 * API key auth paths skip this entirely.
 */
export const CLAUDE_CODE_IDENTITY_TEXT =
  "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * cc_entrypoint values emitted by Claude Code (`cli`, `sdk-cli`, or
 * `claude-code-github-action`). We always emit `cli` because opencode
 * most closely resembles a CLI invocation; downstream proxies that
 * inspect entrypoint to differentiate subscription vs third-party
 * accept `cli` for both SDK and CLI invocations.
 */
export const CC_ENTRYPOINT = 'cli';

/** Static fallback when the body attestation cannot run. */
export const CCH_PLACEHOLDER = '00000';

/** Mask the xxHash64 result to its lower 20 bits (= 5 hex chars). */
export const CCH_MASK = 0xfffffn;

/**
 * Anthropic expects `?beta=true` on `/v1/messages` for OAuth-subscription
 * requests (see Claude Code's fetch interceptor and the
 * `pnpm`/`anthropic-sdk-typescript` SDK behavior for OAuth accounts).
 * Adding it is safe for both OAuth and API-key paths; absence is what
 * triggers 400s for OAuth subscriptions.
 */
export const MESSAGES_BETA_QUERY_PARAM = 'beta=true';

/**
 * Exact prefix emitted by Claude Code as the billing-attestation system
 * block. Stored verbatim (lowercase, ASCII) so we can construct an
 * identical anchor.
 */
export const BILLING_HEADER_BLOCK_PREFIX = 'x-anthropic-billing-header:';
