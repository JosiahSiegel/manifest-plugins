# `@josiahsiegel/manifest-plugins`

Request-transform plugins for [mnfst/manifest](https://github.com/mnfst/manifest), applied to any Manifest checkout via `npm run apply`. The plugins themselves are fork-flavored (e.g. Anthropic OAuth billing headers for Claude Pro/Max), but the apply tool works equally well on upstream, a fork, or a plain local clone.

## What this does

`mnfst/manifest` (the upstream model router) is a single-service codebase. This repo holds the **plugin host** (a small TS function pasted into `provider-client.ts` at apply time) and a registry of **plugins** (each implementing `RequestTransformPlugin`). When the plugin host is installed in a Manifest checkout — upstream, fork, or local clone — every outgoing Anthropic (and future) request flows through the plugin chain, letting you inject headers, mutate the body, or rewrite the URL.

The flagship plugin shipped today is `AnthropicBillingHeaderPlugin`, which injects the `x-anthropic-billing-header` required by Anthropic's upstream classifier for OAuth subscription tokens (Claude Pro / Max). Without it, Claude Pro/Max traffic gets 429'd as out-of-credit. Reference: [vinzabe/opencode-anthropic-max-fix](https://github.com/vinzabe/opencode-anthropic-max-fix), [NTT123 Gist](https://gist.github.com/NTT123/579183bdd7e028880d06c8befae73b99).

## Why a plugin repo, not a fork overlay

- The fork housekeeping overlay stays **small and idempotent** — only the message-cap patch, no per-feature patches.
- Plugins can be added/removed without touching the overlay or rebuilding upstream.
- The plugin host is **fail-safe**: if the plugin package is missing, `require('manifest-plugins')` returns nothing inside try/catch and the request continues as-is.
- New plugins (cache warmers, prompt rewriters, model-redirect rules) ship as standalone files.

## Layout

```
manifest-plugins/
├── .gitattributes                   # enforces LF line endings across the repo
├── package.json                     # @josiahsiegel/manifest-plugins
├── tsconfig.json                    # strict TS, LF enforced
├── jest.config.js                   # 100% line + branch + statement coverage
├── src/
│   ├── index.ts                     # plugin registry (export const plugins = [...])
│   ├── host/
│   │   ├── snippet.ts               # the TS source pasted into provider-client.ts
│   │   ├── apply.ts                 # idempotent patcher (applyProviderClientHost)
│   │   ├── cli.ts                   # `npm run apply -- <manifest-checkout>`
│   │   └── verify.ts                # `npm run verify -- <manifest-checkout>`
│   └── plugins/
│       └── anthropic-billing-header/
│           ├── plugin.ts            # the plugin
│           ├── plugin.spec.ts       # 100% coverage
│           └── README.md            # plugin-specific docs
└── tests/
    └── apply.spec.ts                # patcher integration test (runs tsc on patched file)
```

## Setup

```bash
cd manifest-plugins
npm install
npm run build
```

## Apply to a Manifest checkout

```bash
# Default: looks for ../manifest relative to this repo.
npm run apply

# Or specify explicitly:
npm run apply -- /path/to/manifest

# Or via env var:
MANIFEST_CHECKOUT=/path/to/manifest npm run apply

# Also npm-link the package so `require('manifest-plugins')` resolves
# at runtime (do this once; rebuild only needs a re-link):
npm run apply -- --link /path/to/manifest
```

The apply tool is **idempotent** — running it twice is safe. After it has been applied once, subsequent runs report `noop`.

If you build a Docker image from your Manifest checkout, the Dockerfile should `COPY` this repo into the runtime image and `npm link` it (see the Dockerfile template below).

## Verify

```bash
npm run verify                  # checks ../manifest
npm run verify -- /custom/path  # checks an arbitrary checkout
```

Exits 0 if the host is installed, 1 otherwise. Useful as a smoke test before/after a sync run.

## Plugin contract

Every plugin implements:

```ts
interface RequestTransformPlugin {
  transformRequest(decision: RequestTransformDecision):
    | { url?: string; headers?: Record<string, string>; requestBody?: Record<string, unknown> }
    | undefined;
}
```

Plugins receive the routing decision (`endpointKey`, `authType`, `bareModel`, etc.) plus the outgoing `url` / `headers` / `requestBody` the host already computed. Return whatever you want to override; unspecified fields pass through.

Plugin errors are caught by the host and logged; one broken plugin must not break the request. Never throw to abort.

## Adding a new plugin

1. Create `src/plugins/<name>/plugin.ts` implementing `RequestTransformPlugin`.
2. Create `src/plugins/<name>/plugin.spec.ts` with 100% coverage.
3. Add the plugin instance to `plugins` in `src/index.ts`.
4. `npm run apply -- <manifest-checkout>` to pick up the change at runtime.

No overlay edits. No upstream-sync collisions.

## Environment knobs

| Var                     | Default     | Purpose                                                                 |
| ----------------------- | ----------- | ----------------------------------------------------------------------- |
| `MANIFEST_CC_VERSION`   | `2.1.117`   | Claude Code version stamped into `cc_version`. Bump when Anthropic rotates the classifier. |
| `MANIFEST_CCH_VALUE`    | (empty)     | Overrides the SHA-derived `cch` token. Empty → use `00000` (current Anthropic classifier behaviour). Set to a hex value to force a specific token. |

## Line endings

`.gitattributes` enforces LF line endings repo-wide. The plugin-host patch is byte-exact against upstream/main, which is also LF; mixed line endings break the patcher. If you're on Windows, run `git config core.autocrlf false` before cloning to avoid Windows checkout conversions.

## Tests

```bash
npm test
npm run test:coverage
```

Coverage is enforced at 100% lines + branches + statements via `jest.config.js`'s `coverageThreshold.global`. CI fails if any new code path is uncovered.

The `apply.spec.ts` integration test copies upstream's `provider-client.ts` into a tempdir, runs the patcher, asserts idempotency, then runs `tsc --noEmit` against the patched file to ensure the inserted TS is syntactically valid in the real backend tsconfig context.