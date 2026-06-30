#!/usr/bin/env node
/**
 * plugins-cli.mjs
 * ===============
 *
 * Operator CLI for managing installed plugins at runtime.
 *
 * Subcommands:
 *   list                     — print every installed plugin + its enabled state
 *   enable <id>              — set <id> enabled in the state file
 *   disable <id>             — set <id> disabled in the state file
 *   reset                    — delete the state file (plugins return to defaults)
 *   reload                   — re-read the state file from disk (used when
 *                              a file editor wrote it out-of-band; the admin
 *                              server also exposes this via POST /api/plugins/reload)
 *
 * The CLI writes the SAME state file the admin API uses. The path comes
 * from MANIFEST_PLUGINS_STATE_FILE (default /app/data/plugin-state.json).
 *
 * Exit codes:
 *   0  success
 *   2  bad args (missing subcommand, missing id, unknown id)
 *   3  unknown plugin id
 *   4  I/O error
 *
 * Usage examples:
 *   node scripts/plugins-cli.mjs list
 *   node scripts/plugins-cli.mjs disable default-policy
 *   node scripts/plugins-cli.mjs enable default-policy
 *   node scripts/plugins-cli.mjs reset
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');

const DEFAULT_STATE_FILE = '/app/data/plugin-state.json';

function getStateFile() {
  return process.env['MANIFEST_PLUGINS_STATE_FILE'] || DEFAULT_STATE_FILE;
}

// --- Inlined load/save (mirrors src/registry/state.ts) ------------------------
// We inline because the CLI may be invoked before `npm run build`, and
// we want a single source of truth. The behavior is identical to
// `src/registry/state.ts::loadPluginState`/`savePluginState`. If the two
// drift, the admin API + the CLI will disagree — keep them in sync.

function loadPluginState(filePath) {
  if (!existsSync(filePath)) return {};
  let text;
  try { text = readFileSync(filePath, 'utf-8'); }
  catch (err) { console.warn(`[manifest-plugins] could not read state file ${filePath}: ${err.message}`); return {}; }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (err) { console.warn(`[manifest-plugins] state file ${filePath} is not valid JSON: ${err.message}`); return {}; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const out = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

function savePluginState(filePath, state) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpRoot = mkdtempSync(join(tmpdir(), 'mwp-state-'));
  const tmpFile = join(tmpRoot, 'state.json');
  try {
    writeFileSync(tmpFile, JSON.stringify(state, null, 2) + '\n', 'utf-8');
    renameSync(tmpFile, filePath);
  } finally {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
}

// --- Plugin discovery (read src/plugins/*/plugin.ts and extract ids) -----------
// Mirrors `src/registry/discover.ts` but at a coarser grain: we only need
// the id and the class name, not the instance. The regex matches
// `id: '<kebab-case-id>'` inside the `Object.freeze({ ... })` metadata
// literal that every plugin file ships.

import { readdirSync } from 'node:fs';

function discoverPluginsFromSource() {
  const pluginsDir = join(REPO_ROOT, 'src', 'plugins');
  if (!existsSync(pluginsDir)) return [];
  const out = [];
  for (const child of readdirSync(pluginsDir)) {
    if (child.startsWith('.')) continue;
    const pluginFile = join(pluginsDir, child, 'plugin.ts');
    if (!existsSync(pluginFile)) continue;
    const text = readFileSync(pluginFile, 'utf-8');
    // Match `id: 'kebab-case'` inside the metadata literal.
    const idMatch = text.match(/id:\s*['"]([a-z][a-z0-9-]*)['"]/);
    const nameMatch = text.match(/name:\s*['"]([^'"]+)['"]/);
    if (idMatch === null) continue;
    const id = idMatch[1];
    const name = nameMatch !== null ? nameMatch[1] : id;

    // `kind:` in the metadata literal may be a string literal
    // (`kind: 'transform'`) OR a constant reference
    // (`kind: ANTHROPIC_BILLING_HEADER_PLUGIN_KIND`). When it's a
    // constant, we look up the const's value elsewhere in the same
    // file (`const FOO_PLUGIN_KIND: PluginKind = 'transform';`).
    let kind = 'unknown';
    const kindLiteral = text.match(/kind:\s*['"]([a-z-]+)['"]/);
    if (kindLiteral !== null) {
      kind = kindLiteral[1];
    } else {
      const kindConst = text.match(/kind:\s*([A-Z][A-Z0-9_]+)/);
      if (kindConst !== null) {
        const constName = kindConst[1];
        const constValue = text.match(
          new RegExp(`const\\s+${constName}[^=]*=\\s*['"]([a-z-]+)['"]`),
        );
        if (constValue !== null) kind = constValue[1];
      }
    }

    out.push({ id, name, kind, directory: child });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

// --- Subcommand handlers -------------------------------------------------------

function usage() {
  process.stdout.write([
    'Usage: node scripts/plugins-cli.mjs <subcommand> [args]',
    '',
    'Subcommands:',
    '  list                     print every installed plugin and its enabled state',
    '  enable <id>              mark <id> enabled in the state file',
    '  disable <id>             mark <id> disabled in the state file',
    '  reset                    delete the state file (plugins return to defaults)',
    '  reload                   re-read the state file (out-of-band updates)',
    '',
    'Environment:',
    '  MANIFEST_PLUGINS_STATE_FILE   override the state file path',
    '                               (default: /app/data/plugin-state.json)',
    '',
    'Examples:',
    '  node scripts/plugins-cli.mjs list',
    '  node scripts/plugins-cli.mjs disable default-policy',
    '  node scripts/plugins-cli.mjs enable default-policy',
    '  node scripts/plugins-cli.mjs reset',
    '',
  ].join('\n'));
}

function cmdList(stateFile) {
  const plugins = discoverPluginsFromSource();
  const persisted = loadPluginState(stateFile);
  if (plugins.length === 0) {
    process.stdout.write('(no plugins found under src/plugins/)\n');
    return 0;
  }
  const header = ['PLUGIN ID'.padEnd(34), 'KIND'.padEnd(18), 'ENABLED', 'NAME'];
  process.stdout.write(header.join('  ') + '\n');
  process.stdout.write('-'.repeat(80) + '\n');
  for (const plugin of plugins) {
    // enabled defaults to true unless persisted state has an entry.
    const enabled = persisted[plugin.id] === undefined ? true : persisted[plugin.id];
    const marker = enabled ? '  yes  ' : '  no   ';
    const line = [
      plugin.id.padEnd(34),
      plugin.kind.padEnd(18),
      marker,
      plugin.name,
    ];
    process.stdout.write(line.join('  ') + '\n');
  }
  return 0;
}

function cmdEnable(stateFile, id) {
  const plugins = discoverPluginsFromSource();
  const known = plugins.find((p) => p.id === id);
  if (known === undefined) {
    process.stderr.write(`error: unknown plugin id '${id}'\n`);
    process.stderr.write(`  known ids: ${plugins.map((p) => p.id).join(', ')}\n`);
    return 3;
  }
  const state = loadPluginState(stateFile);
  state[id] = true;
  savePluginState(stateFile, state);
  process.stdout.write(`enabled: ${id}\n`);
  return 0;
}

function cmdDisable(stateFile, id) {
  const plugins = discoverPluginsFromSource();
  const known = plugins.find((p) => p.id === id);
  if (known === undefined) {
    process.stderr.write(`error: unknown plugin id '${id}'\n`);
    process.stderr.write(`  known ids: ${plugins.map((p) => p.id).join(', ')}\n`);
    return 3;
  }
  const state = loadPluginState(stateFile);
  state[id] = false;
  savePluginState(stateFile, state);
  process.stdout.write(`disabled: ${id}\n`);
  return 0;
}

function cmdReset(stateFile) {
  if (existsSync(stateFile)) {
    rmSync(stateFile, { force: true });
    process.stdout.write(`deleted: ${stateFile}\n`);
  } else {
    process.stdout.write(`(state file does not exist: ${stateFile})\n`);
  }
  return 0;
}

function cmdReload(stateFile) {
  // The CLI itself doesn't hold runtime state — `reload` re-reads the
  // file and prints the current effective state. The admin server
  // exposes the same operation via POST /api/plugins/reload which
  // mutates the in-memory registry. When run via the CLI, the user
  // is expected to also call the admin server (or restart the
  // process) to pick up the new state.
  if (!existsSync(stateFile)) {
    process.stdout.write(`(no state file at ${stateFile}; all plugins use defaults)\n`);
    return 0;
  }
  const state = loadPluginState(stateFile);
  process.stdout.write(`current persisted state (${stateFile}):\n`);
  for (const [id, enabled] of Object.entries(state)) {
    process.stdout.write(`  ${id}: ${enabled ? 'enabled' : 'disabled'}\n`);
  }
  process.stdout.write('(restart the admin server to apply — or call POST /api/plugins/reload)\n');
  return 0;
}

// --- Entry point ---------------------------------------------------------------

function main(argv) {
  const args = argv.slice(2);
  const subcommand = args[0];
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    usage();
    return subcommand === undefined ? 2 : 0;
  }
  const stateFile = getStateFile();
  switch (subcommand) {
    case 'list':    return cmdList(stateFile);
    case 'enable': {
      const id = args[1];
      if (id === undefined) { process.stderr.write('error: enable requires a plugin id\n'); return 2; }
      return cmdEnable(stateFile, id);
    }
    case 'disable': {
      const id = args[1];
      if (id === undefined) { process.stderr.write('error: disable requires a plugin id\n'); return 2; }
      return cmdDisable(stateFile, id);
    }
    case 'reset':   return cmdReset(stateFile);
    case 'reload':  return cmdReload(stateFile);
    default: {
      process.stderr.write(`error: unknown subcommand '${subcommand}'\n`);
      usage();
      return 2;
    }
  }
}

process.exit(main(process.argv));