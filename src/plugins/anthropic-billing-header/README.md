# `anthropic-billing-header` plugin

Injects Anthropic's `x-anthropic-billing-header` for OAuth subscription tokens (Claude Pro / Max).

## Why

Anthropic's upstream API rejects Claude Pro / Max OAuth tokens with `429 out of credit` when the request lacks the `x-anthropic-billing-header`. Anthropic uses the header to attribute the request to the paid account; without it, the classifier assumes third-party usage and 429s.

## What it does

When the routing layer resolves a request to the canonical Anthropic endpoint (`endpointKey === 'anthropic'`) with subscription auth (`authType === 'subscription'`), the plugin adds:

```http
x-anthropic-billing-header: cc_version=<version>.<suffix>; cc_entrypoint=cli; cch=<cch>;
```

- `version` is `MANIFEST_CC_VERSION` or `2.1.117` (latest Claude Code version).
- `suffix` is `SHA-256("59cf53e54c78" + sampled_chars + version)[:3]` where `sampled_chars = message[4]+message[7]+message[20]` (padded with `'0'`).
- `cch` is `MANIFEST_CCH_VALUE` (with optional `cch=` prefix stripped) or `00000` when env is unset/empty.

Anthropic-compatible proxies (byteplus, commandcode, moonshot, opencode-go-anthropic, custom) and paid API-key auth are skipped — neither needs the spoof header.

## Environment knobs

| Var                   | Default   | Purpose                                                                                       |
| --------------------- | --------- | --------------------------------------------------------------------------------------------- |
| `MANIFEST_CC_VERSION` | `2.1.117` | Claude Code version stamped into `cc_version`. Bump when Anthropic rotates the classifier.   |
| `MANIFEST_CCH_VALUE`  | (empty)   | Overrides the SHA-derived `cch` token. Empty → `00000`. Set to a hex value to force a token. |

## Algorithm reference

The 3-char suffix and 5-char cch derivation mirror the open-source implementations verified against Anthropic's classifier:

- [vinzabe/opencode-anthropic-max-fix](https://github.com/vinzabe/opencode-anthropic-max-fix)
- [grifinmartin/opencode-claude-auth](https://github.com/griffinmartin/opencode-claude-auth)
- [NTT123 Gist](https://gist.github.com/NTT123/579183bdd7e028880d06c8befae73b99)

The `MANIFEST_CCH_VALUE` empty-string → `00000` default matches the ex-machina-co fork convention; flip to a real SHA-256 by setting the env var if Anthropic's classifier starts rejecting static values.