# `anthropic-billing-header` plugin (v0.5.0)

Injects Anthropic's `x-anthropic-billing-header` HTTP header AND mutates the
request body so that OAuth subscription requests (Claude Pro / Max) count
against the subscription pool — not the third-party "extra usage" pool.

## Why

Anthropic has **four independent detection vectors** for OAuth
subscriptions that all have to pass. As of June 2026:

1. **`x-anthropic-billing-header`** — must have a recent `cc_version` AND
   a freshly-computed `cch` body attestation. Stale or placeholder cch
   routes to extra usage.
2. **`system[0]` content** for OAuth accounts (since March 16, 2026) —
   the first block of the `system[]` array MUST be EXACTLY
   `"You are Claude Code, Anthropic's official CLI for Claude."`.
   Without it, Sonnet/Opus return HTTP 400.
3. **`?beta=true` query string** on `/v1/messages` for OAuth requests.
4. **System-prompt content classifier** (since April 4, 2026) — when
   `system[]` accumulates >~4–4.5k chars of non-Claude-Code orchestration
   content, Anthropic flips the request into the overage/extra-usage
   billing lane even on a valid subscription. The classifier is
   multi-feature (volume + lexical fingerprints), so truncating the
   prompt alone is not enough — fingerprint-bearing blocks must be
   moved out of `system[]`.

The error message `"You're out of extra usage. Add more at claude.ai/settings/usage
and keep going."` is the standard symptom for any of these failing.

The 0.1.0 → 0.5.0 evolution:

| Version | Failure mode | Fix |
| --- | --- | --- |
| 0.1.0 | Stale `cc_version` (2.1.117), static `cch=SHA-256(message)[:5]` | (Original plugin) |
| 0.2.0 | New `cch=xxHash64(body)` requirement + current `cc_version=2.1.196` | Replaced cch algorithm; added hash-wasm |
| 0.3.0 | OAuth system identity check (March 2026) + body-attestation preimage transform (v2.1.172+) + seed rotation (`0x6E…` → `0x4D…`) | Added identity block + preimage transform |
| 0.4.0 | Billing header order requirement (`system[0]` = billing, `system[1]` = identity) + Claude Code fingerprint headers | Reordered system[]; added User-Agent, anthropic-beta, x-app, anthropic-version headers |
| 0.5.0 | System-content classifier flips to overage lane when system[] >4–4.5k chars of non-Claude-Code content (opencode's 8k+ `anthropic.txt` plus AGENTS.md puts every request past threshold) | Surgical relocation: opencode-fingerprinted blocks are moved from `system[]` to the first user message; clean blocks stay in `system[]` to preserve prompt-cache prefixes |

## What it does

For each authenticated subscription call to `/v1/messages`, the plugin:

0. **Relocates opencode-fingerprinted system[] entries to the first user
   message** so Anthropic's content classifier routes against the
   subscription pool, not the overage pool. (Opt-out via
   `MANIFEST_CC_RELOCATE=false`.)
1. Computes the `cc_version` suffix (SHA-256 salt + sampled message chars + version).
2. Resolves the correct xxHash64 seed for the current Claude Code version
   (current seed is `0x4D659218E32A3268`, used by v2.1.138+).
3. Builds a placeholder request body with `cch=00000`, `system[0]` =
   identity block, `system[1]` = billing attestation block.
4. Applies the v2.1.172+ cch preimage transform (blank `model` value,
   strip `max_tokens` field) and computes the xxHash64.
5. Replaces the placeholder `cch=00000` with the computed 5-char hex value
   in both the HTTP header AND in `system[1]`.
6. Sets `?beta=true` on the URL (idempotent).
7. Returns `{ url, headers, requestBody }` — the host replaces
   `requestBody` wholesale (no shallow-merge) so JSON key order matches
   Claude Code's wire format (`system, messages, model, max_tokens, ...`).

## Outbound header (HTTP)

```http
x-anthropic-billing-header: cc_version=2.1.196.<3-char-sha256-suffix>; cc_entrypoint=cli; cch=<5-char-hex>;
```

Where:

- `2.1.196` is `MANIFEST_CC_VERSION` or `DEFAULT_CC_VERSION` (latest Claude
  Code release as of 2026-06-29).
- The 3-char suffix is SHA-256(`59cf53e54c78` + `message[4]+message[7]+message[20]` + version)[:3]
  (where missing chars pad with `'0'`).
- `cch` is the xxHash64 attestation computed over the body with the
  preimage transform applied (see `body.ts`).

## Outbound body (system[] order)

```json
{
  "system": [
    { "type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude." },
    { "type": "text", "text": "x-anthropic-billing-header: cc_version=...; cc_entrypoint=cli; cch=..." },
    ...original system content (cache_control preserved if present)
  ],
  "messages": [ ... ],
  "model": "...",
  "max_tokens": ...,
  ...
}
```

## Outbound URL (query)

```
https://api.anthropic.com/v1/messages?beta=true
```

## Environment knobs

| Var | Default | Purpose |
| --- | --- | --- |
| `MANIFEST_CC_VERSION` | `2.1.196` | Claude Code version stamped into `cc_version`. Bump when Anthropic ships a new release. |
| `MANIFEST_CCH_VALUE` | (empty) | Override the body-attested `cch`. Empty → body attestation. Set to a 5-hex value to pin it (e.g. during seed rotation). |
| `MANIFEST_CC_RELOCATE` | `true` | When `true` (or unset), the plugin surgically relocates opencode-fingerprinted `system[]` blocks to the first user message to keep Anthropic's content classifier from flipping the request into the overage lane. Set to `false` to disable relocation (v0.4.0 behavior). |

If Anthropic rotates the seed, update `SEED_CURRENT` in `cch.ts` to the
new constant (extract from the Bun binary using the oracle-pair method
in `BYK/loreai` or `router-for-me/CLIProxyAPI`).

## Algorithm reference

The cch algorithm and seed rotation history are verified against multiple
sources (extracted from Claude Code's compiled Bun binary):

- [BYK/loreai `packages/gateway/src/cch.ts`](https://github.com/BYK/loreai/blob/main/packages/gateway/src/cch.ts) — Go reference; version → seed registry for v2.1.138 through v2.1.196
- [marco-jardim/opencode-anthropic-fix docs](https://github.com/marco-jardim/opencode-anthropic-fix/blob/HEAD/docs/claude-code-reverse-engineering.md) — reverse-engineering writeup; cch preimage transform
- [a10k.co "Reverse Engineering Claude Code's Request Signing"](https://a10k.co/b/reverse-engineering-claude-code-cch.html) — original Bun-disassembly post
- [router-for-me/CLIProxyAPI `claude_signing.go`](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/runtime/executor/claude_signing.go) — Go signing reference
- [anthropics/claude-code#40515](https://github.com/anthropics/claude-code/issues/40515), [hoblin/anima#233](https://github.com/hoblin/anima/issues/233) — system identity requirement

The xxHash64 implementation is the canonical xxHash64 WASM build from
[Daninet/hash-wasm](https://github.com/Daninet/hash-wasm) (MIT).

## Gate

The plugin emits its transforms ONLY when:

- `endpointKey === 'anthropic'` (canonical Anthropic endpoint), AND
- `authType === 'subscription'`

Anthropic-compatible proxies (byteplus, commandcode, moonshot,
opencode-go-anthropic, custom) and paid API-key auth are skipped —
neither needs the header or risk being flagged.

## Known limitations

1. **`tools[]` shape detector** (added late June 2026). Some Anthropic-compatible
   clients get a 400 from a tools-list-shape classifier unrelated to
   the cch / system-identity fixes. This plugin does NOT rewrite tool
   names (PascalCase-ing per PascalCase workarounds is unsafe without a
   response/tool-call mapping layer). If you hit this, the workaround
   is to use a smaller tool list or strip optional fields.
2. **Seed rotation**. When Anthropic rotates the seed, the plugin's
   emitted cch will fail upstream validation. Update `SEED_CURRENT`
   in `cch.ts` and bump the plugin version.
3. **System-prompt content classifier**. The classifier is
   multi-feature (volume + lexical fingerprints). The 0.5.0
   relocation handles the known opencode fingerprints. If Anthropic
   adds new fingerprints to its classifier, update
   `OPENCODE_SYSTEM_FINGERPRINTS` in `body.ts`.

## Relocation behavior (v0.5.0+)

When `MANIFEST_CC_RELOCATE` is enabled (default), the plugin classifies
each entry of `system[]` against these fingerprint patterns:

| Regex | What it catches |
| --- | --- |
| `/\bopencode\b/i` | Any literal "opencode" / "OpenCode" reference |
| `/anomalyco/` | The fork that owns the opencode source repo |
| `/Workspace root folder/` | The env-block marker opencode emits |
| `/<directories>/` | The workspace XML marker |
| `/is a git repo:/i` | The git-status env-block marker |
| `/TodoWrite/` | Opencode's todo-tool name |

Entries that match ANY of these patterns are moved (with a
`[moved from system]` marker) to the first user message. Clean entries
remain in `system[]` so prompt-cache prefixes stay cache-eligible. If
no entries match, the request is unchanged from v0.4.0.

The relocation runs **before** the cch body build, so the cch
attestation reflects the relocated body bytes (not the original).
This is verified by the S6-relocate-5 test in `plugin.spec.ts`.
