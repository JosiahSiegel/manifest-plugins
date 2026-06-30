# `anthropic-billing-header` plugin

Injects Anthropic's `x-anthropic-billing-header` for OAuth subscription tokens (Claude Pro / Max).

## Why

Anthropic's upstream API rejects Claude Pro / Max OAuth tokens with **400 "You're out of extra usage"** when the request lacks a valid `x-anthropic-billing-header`. As of late March 2026 (Claude Code v2.1.113+), Anthropic's classifier routes requests to the third-party "extra usage" billing path when:

- The `cc_version` field is too stale (≥ ~50 patch versions behind the current Claude Code release), or
- The `cch` field is the static placeholder `00000` (was previously accepted; no longer).

The error message is misleading — the user is not actually out of extra usage, Anthropic is just refusing to count the request under the subscription quota.

## What it does

When the routing layer resolves a request to the canonical Anthropic endpoint (`endpointKey === 'anthropic'`) with subscription auth (`authType === 'subscription'`), the plugin adds:

```http
x-anthropic-billing-header: cc_version=<version>.<suffix>; cc_entrypoint=cli; cch=<cch>;
```

- `version` is `MANIFEST_CC_VERSION` or `2.1.196` (current Claude Code release as of 2026-06-29).
- `suffix` is `SHA-256("59cf53e54c78" + sampled_chars + version)[:3]` where `sampled_chars = message[4]+message[7]+message[20]` (padded with `'0'`).
- `cch` is the **per-request xxHash64 body attestation** masked to the lower 20 bits, formatted as 5-char zero-padded lowercase hex. The seed is `0x6E52736AC806831E`, baked into Claude Code's compiled Bun binary.

Anthropic-compatible proxies (byteplus, commandcode, moonshot, opencode-go-anthropic, custom) and paid API-key auth are skipped — neither needs the spoof header.

## Environment knobs

| Var                   | Default     | Purpose                                                                                                |
| --------------------- | ----------- | ------------------------------------------------------------------------------------------------------ |
| `MANIFEST_CC_VERSION` | `2.1.196`   | Claude Code version stamped into `cc_version`. Bump when Anthropic ships a new release.                |
| `MANIFEST_CCH_VALUE`  | (empty)     | Overrides the xxHash64-attested `cch` token. Empty → body attestation. Set to a 5-hex value to pin it. |

## Algorithm reference

The xxHash64 body attestation algorithm matches the canonical Claude Code signing protocol, verified against:

- [router-for-me/CLIProxyAPI `claude_signing.go`](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/runtime/executor/claude_signing.go) — Go reference implementation of the exact cch algorithm
- [marco-jardim/opencode-anthropic-fix `docs/claude-code-reverse-engineering.md`](https://github.com/marco-jardim/opencode-anthropic-fix/blob/HEAD/docs/claude-code-reverse-engineering.md) — full reverse-engineering writeup with seed constant
- [a10k.co "Reverse Engineering Claude Code's Request Signing"](https://a10k.co/b/reverse-engineering-claude-code-cch.html) — original RE post that extracted the seed and xxhash64 algorithm from the Bun binary
- [Daninet/hash-wasm](https://github.com/Daninet/hash-wasm) — MIT-licensed WASM build of canonical xxHash64 used by this plugin
- [griffinmartin/opencode-claude-auth](https://github.com/griffinmartin/opencode-claude-auth) — community plugin with a related (but body-rewriting) approach

The `MANIFEST_CCH_VALUE` empty-string → body attestation default matches the upstream Claude Code npm-build behavior (the npm build also ships a `00000` placeholder that the Bun-native client overrides at fetch time; here we always compute the attestation because the hash-wasm hasher is sync after a one-time WASM init).

If Anthropic rotates the xxHash64 seed, update `CCH_SEED_HI` and `CCH_SEED_LO` in `plugin.ts` to the new constant (extracted from the new Bun binary).