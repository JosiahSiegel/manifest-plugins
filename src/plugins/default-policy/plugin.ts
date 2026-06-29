/**
 * DefaultPolicyPlugin — provides the default `RequestPolicyPlugin` policy
 * for users who want sensible Manifest behavior out of the box.
 *
 * Context: the upstream Manifest code is hardcoded with
 * `CONCURRENCY_MAX = 10` and a 1000-message per-request cap. This plugin
 * reproduces the friendly defaults that the manifest-plugins project
 * considers appropriate for typical agent workloads:
 *   - `concurrencyMax: 10`  — matches the source-code `DEFAULT_CONCURRENCY_MAX`
 *   - `maxMessagesPerRequest: null`  — "no cap" (Infinity). Users running
 *     long-loop agents want the M301 cap disabled by default.
 *
 * Operators who want a different policy (e.g. higher cap, lower cap,
 * strict message limit) write a new plugin and put it earlier in the
 * `plugins` array. The host's first-non-null-wins semantics makes
 * plugin ordering meaningful.
 *
 * Build-time exclusion: the user can disable this plugin via
 * `manifest-plugins.config.json` without forking the repo (see
 * `config.example.json` and the README for details).
 */
import type {
  PluginKind,
  PluginMetadata,
  RateLimitPolicy,
  RequestPolicyPlugin,
} from '../..';

const DEFAULT_CONCURRENCY_MAX = 10;

export const DEFAULT_POLICY_PLUGIN_KIND: PluginKind = 'policy';

export const DEFAULT_POLICY_PLUGIN_METADATA: PluginMetadata = Object.freeze({
  id: 'default-policy',
  name: 'Default policy',
  version: '0.1.0',
  description: 'Applies default request policy settings.',
  kind: DEFAULT_POLICY_PLUGIN_KIND,
});

export class DefaultPolicyPlugin implements RequestPolicyPlugin {
  static readonly metadata: PluginMetadata = DEFAULT_POLICY_PLUGIN_METADATA;
  getRateLimitPolicy(): RateLimitPolicy {
    return {
      concurrencyMax: DEFAULT_CONCURRENCY_MAX,
      maxMessagesPerRequest: null,
    };
  }
}