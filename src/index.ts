/**
 * Fork-only plugins for mnfst/manifest.
 *
 * Each plugin implements the {@link RequestTransformPlugin} interface and is
 * auto-loaded by the host (installed via `npm run apply`) via
 * `require('manifest-plugins').plugins`.
 *
 * To add a new plugin:
 *   1. Create `src/plugins/<name>/plugin.ts` implementing the interface.
 *   2. Add it to the `plugins` array below.
 *   3. Add the same export path in the `package.json` `files` field if
 *      the plugin ships its own source files (currently only `src/host/*`
 *      and `dist/*` are shipped — the in-tree `src/index.ts` references the
 *      compiled `dist/plugins/...` paths via ts-jest's module resolution).
 *
 * Re-run `npm run apply` against the Manifest checkout, then re-build the
 * Docker image to pick up the new plugin. No overlay edits required.
 */
import { AnthropicBillingHeaderPlugin } from './plugins/anthropic-billing-header/plugin';

export const plugins: ReadonlyArray<RequestTransformPlugin> = Object.freeze([
  new AnthropicBillingHeaderPlugin(),
]);

/**
 * The host calls each plugin's `transformRequest(decision)` synchronously
 * before forwarding the outgoing request. Plugins can:
 *   - Add / overwrite headers (e.g. OAuth billing headers).
 *   - Mutate the request body (e.g. inject a static system-prompt preamble).
 *   - Replace the upstream URL (rare; e.g. shadow-route to a staging endpoint).
 *
 * Each field in the return value is optional. Unspecified fields fall back to
 * the values the host already computed from the upstream Manifest pipeline.
 *
 * Plugin errors MUST be non-fatal: the host catches and logs them and
 * continues with the original request. Never throw to abort the request.
 */
export interface RequestTransformDecision {
  /** Endpoint key (e.g. `'anthropic'`, `'openai'`, `'byteplus-anthropic'`). */
  readonly endpointKey: string;
  /** Routing-layer provider id (e.g. `'anthropic'`, `'custom:foo'`). */
  readonly provider: string;
  /** Model name with vendor prefix stripped. */
  readonly bareModel: string;
  /** Resolved API key / OAuth token for the upstream call. */
  readonly apiKey: string;
  /** `'api_key' | 'subscription' | undefined`. */
  readonly authType: string | undefined;
  /** Inbound API mode (chat_completions | responses | messages). */
  readonly apiMode?: string;
  /** Whether the caller asked for streaming. */
  readonly stream: boolean;
  /** Outgoing URL the host computed. */
  readonly url: string;
  /** Outgoing headers the host computed. */
  readonly headers: Readonly<Record<string, string>>;
  /** Outgoing request body the host computed. */
  readonly requestBody: Readonly<Record<string, unknown>>;
}

export interface RequestTransformResult {
  url?: string;
  headers?: Record<string, string>;
  requestBody?: Record<string, unknown>;
}

export interface RequestTransformPlugin {
  transformRequest(decision: RequestTransformDecision): RequestTransformResult | undefined;
}

export { AnthropicBillingHeaderPlugin } from './plugins/anthropic-billing-header/plugin';