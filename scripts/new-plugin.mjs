#!/usr/bin/env node
/**
 * new-plugin.mjs
 * ==============
 *
 * Scaffolder for new plugins. Generates `src/plugins/<name>/plugin.ts`
 * and `src/plugins/<name>/plugin.spec.ts` from a kind-aware template,
 * so adding a plugin is `npm run new-plugin -- my-name [--kind=...]`
 * followed by `npm test` + `npm run build`.
 *
 * Behavior:
 *   - Validates `<name>` against `^[a-z][a-z0-9-]*$` (kebab-case,
 *     lowercase, starts with a letter). Plugins whose names violate
 *     this would break the file-system walk in
 *     `src/registry/discover.ts` (kebab-case directories only) and
 *     the package.json `plugins` key allowlist in
 *     `scripts/filter-plugins.mjs`.
 *   - Validates `--kind` against the three plugin kinds
 *     (`transform`, `policy`, `routing-override`). The default is
 *     `transform` (lowest risk; request-transform hooks are the
 *     most common pattern).
 *   - Refuses to overwrite an existing directory (exit 3).
 *   - Writes files via `fs.writeFileSync` — no shell exec, no
 *     template engine, no eval. The template is a single tagged
 *     string for each kind, so the output is deterministic.
 *
 * Exit codes:
 *   0  plugin + spec written
 *   1  unexpected I/O error
 *   2  bad input (missing/invalid name, unknown kind, --help shown)
 *   3  target directory already exists
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const VALID_KINDS = new Set(['transform', 'policy', 'routing-override']);

function usage() {
  process.stdout.write(
    [
      'Usage: npm run new-plugin -- <name> [--kind=transform|policy|routing-override]',
      '',
      '  <name>   Plugin directory name (kebab-case, lowercase, starts with a letter)',
      '  --kind   Plugin kind (default: transform)',
      '',
      'Examples:',
      '  npm run new-plugin -- my-header',
      '  npm run new-plugin -- tier-router --kind=routing-override',
      '  npm run new-plugin -- rate-cap --kind=policy',
      '',
    ].join('\n'),
  );
}

function classNameFor(name) {
  // `my-rate-cap` → `MyRateCapPlugin`. The plugin class is always
  // suffixed `Plugin` so the discoverer's regex (`/^export\s+class\s+[A-Z]/`)
  // matches and the class name never collides with the directory name.
  const parts = name.split('-').filter((p) => p.length > 0);
  const pascal = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
  return pascal + 'Plugin';
}

function constantNameFor(name) {
  // `my-rate-cap` → `MY_RATE_CAP_PLUGIN_METADATA`.
  return name.replace(/-/g, '_').toUpperCase() + '_PLUGIN_METADATA';
}

function templatePlugin(name, className, kind, metadataConst) {
  // Each kind's template ships the matching hook method body plus
  // a no-op default. The author replaces the no-op with real logic.
  // We use a switch on `kind` rather than string interpolation so
  // the generated TS is byte-exact.
  switch (kind) {
    case 'transform':
      return [
        `import type {`,
        `  PluginMetadata,`,
        `  RequestTransformDecision,`,
        `  RequestTransformPlugin,`,
        `  RequestTransformResult,`,
        `} from '../..';`,
        ``,
        `export const ${metadataConst} = Object.freeze({`,
        `  id: '${name}',`,
        `  name: '${name}',`,
        `  version: '0.1.0',`,
        `  description: 'TODO: describe ${name}',`,
        `  kind: 'transform' as const,`,
        `});`,
        ``,
        `export class ${className} implements RequestTransformPlugin {`,
        `  static readonly metadata: PluginMetadata = ${metadataConst};`,
        ``,
        `  transformRequest(`,
        `    decision: RequestTransformDecision,`,
        `  ): RequestTransformResult | undefined {`,
        `    // TODO: return { headers?, url?, requestBody? } to override`,
        `    // the host-computed request. Return undefined to pass through.`,
        `    void decision;`,
        `    return undefined;`,
        `  }`,
        `}`,
        ``,
      ].join('\n');
    case 'policy':
      return [
        `import type {`,
        `  PluginMetadata,`,
        `  RateLimitPolicy,`,
        `  RequestPolicyPlugin,`,
        `} from '../..';`,
        ``,
        `export const ${metadataConst} = Object.freeze({`,
        `  id: '${name}',`,
        `  name: '${name}',`,
        `  version: '0.1.0',`,
        `  description: 'TODO: describe ${name}',`,
        `  kind: 'policy' as const,`,
        `});`,
        ``,
        `export class ${className} implements RequestPolicyPlugin {`,
        `  static readonly metadata: PluginMetadata = ${metadataConst};`,
        ``,
        `  getRateLimitPolicy(): RateLimitPolicy | null {`,
        `    // TODO: return { concurrencyMax? }. First non-null field wins;`,
        `    // null falls through to the env/default.`,
        `    return null;`,
        `  }`,
        `}`,
        ``,
      ].join('\n');
    case 'routing-override':
      return [
        `import type {`,
        `  PluginMetadata,`,
        `  RoutingOverrideContext,`,
        `  RoutingOverridePlugin,`,
        `  RoutingOverrideResolvedRouting,`,
        `} from '../..';`,
        ``,
        `export const ${metadataConst} = Object.freeze({`,
        `  id: '${name}',`,
        `  name: '${name}',`,
        `  version: '0.1.0',`,
        `  description: 'TODO: describe ${name}',`,
        `  kind: 'routing-override' as const,`,
        `});`,
        ``,
        `export class ${className} implements RoutingOverridePlugin {`,
        `  static readonly metadata: PluginMetadata = ${metadataConst};`,
        ``,
        `  overrideRouting(`,
        `    ctx: RoutingOverrideContext,`,
        `  ): RoutingOverrideResolvedRouting | null {`,
        `    // TODO: read ctx.headerTiers / ctx.discoveredModels / ctx.headers`,
        `    // and return a resolved routing object to short-circuit upstream`,
        `    // routing. Return null to defer.`,
        `    void ctx;`,
        `    return null;`,
        `  }`,
        `}`,
        ``,
      ].join('\n');
    default:
      // Should be unreachable because we validate `kind` above.
      throw new Error(`unknown kind: ${kind}`);
  }
}

function templateSpec(name, className, metadataConst) {
  return [
    `/**`,
    ` * Unit tests for ${name} (${className}).`,
    ` *`,
    ` * Locks the scaffolder-generated contract:`,
    ` *   - static metadata has a non-empty id and the matching kind`,
    ` *   - the class is constructable without throwing`,
    ` *`,
    ` * The author replaces the no-op test below with the plugin's`,
    ` * specific behavior assertions.`,
    ` */`,
    `import type { PluginMetadata } from '../..';`,
    `import { ${className}, ${metadataConst} } from './plugin';`,
    ``,
    `describe('${className}', () => {`,
    `  it('declares metadata with the scaffolder id and a non-empty shape', () => {`,
    `    expect(${metadataConst}.id).toBe('${name}');`,
    `    expect(${metadataConst}.name).toEqual(expect.any(String));`,
    `    expect((${metadataConst}.name as string).length).toBeGreaterThan(0);`,
    `    expect(${metadataConst}.kind).toEqual(`,
    `      expect.stringMatching(/^(transform|policy|routing-override)$/),`,
    `    );`,
    `  });`,
    ``,
    `  it('exposes the metadata via the static class field', () => {`,
    `    expect(${className}.metadata).toEqual<PluginMetadata>(${metadataConst});`,
    `  });`,
    ``,
    `  it('is constructable without throwing', () => {`,
    `    expect(() => new ${className}()).not.toThrow();`,
    `  });`,
    `});`,
    ``,
  ].join('\n');
}

function parseArgs(argv) {
  // argv[0] = node, argv[1] = script path. We accept both `--kind=value`
  // and `--kind value` for ergonomics.
  const args = argv.slice(2);
  let name = null;
  let kind = 'transform';
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--kind' && i + 1 < args.length) {
      kind = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--kind=')) {
      kind = arg.slice('--kind='.length);
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`unknown flag: ${arg}`);
    }
    if (name === null) {
      name = arg;
      continue;
    }
    throw new Error(`unexpected positional: ${arg}`);
  }
  return { name, kind };
}

function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`new-plugin: ${msg}\n`);
    usage();
    process.exit(2);
  }

  const { name, kind } = parsed;

  if (name === null || name.length === 0) {
    process.stderr.write('new-plugin: missing <name>\n');
    usage();
    process.exit(2);
  }
  if (!NAME_RE.test(name)) {
    process.stderr.write(
      `new-plugin: invalid name '${name}' (must match ^[a-z][a-z0-9-]*$ — kebab-case, lowercase, starts with a letter)\n`,
    );
    process.exit(2);
  }
  if (!VALID_KINDS.has(kind)) {
    process.stderr.write(
      `new-plugin: invalid --kind '${kind}' (must be one of: transform, policy, routing-override)\n`,
    );
    process.exit(2);
  }

  const className = classNameFor(name);
  const metadataConst = constantNameFor(name);
  const targetDir = join(REPO_ROOT, 'src', 'plugins', name);
  const pluginPath = join(targetDir, 'plugin.ts');
  const specPath = join(targetDir, 'plugin.spec.ts');

  if (existsSync(targetDir)) {
    process.stderr.write(
      `new-plugin: target directory already exists: ${targetDir}\n`,
    );
    process.exit(3);
  }

  try {
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(pluginPath, templatePlugin(name, className, kind, metadataConst), 'utf-8');
    writeFileSync(specPath, templateSpec(name, className, metadataConst), 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`new-plugin: failed to write files: ${msg}\n`);
    process.exit(1);
  }

  process.stdout.write(
    [
      `new-plugin: wrote ${pluginPath}`,
      `new-plugin: wrote ${specPath}`,
      `new-plugin: kind=${kind} class=${className} id=${name}`,
      '',
      'Next steps:',
      `  1. Edit src/plugins/${name}/plugin.ts to implement the plugin logic`,
      `  2. Replace the TODO test in src/plugins/${name}/plugin.spec.ts`,
      '  3. Run `npm test && npm run build`',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

main();