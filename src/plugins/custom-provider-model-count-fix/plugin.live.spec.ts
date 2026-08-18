/**
 * @jest-environment jsdom
 *
 * Live-execution tests for CustomProviderModelCountFixPlugin.
 *
 * Runs the actual emitted IIFE in a `vm` sandbox backed by jsdom's DOM,
 * asserting the patch behavior end-to-end for all five surfaces (S1, S2,
 * S3, S5, S6). This is the strongest "the patch lands correctly" assertion
 * we can make in CI without a real Manifest backend running.
 *
 * Why `vm` + jsdom instead of pure jsdom: the script reads
 * `window.location.pathname` to detect the current page. jsdom makes
 * `window.location` read-only and un-configurable, so we cannot stub the
 * pathname from a test. `vm.createContext` gives us full control over the
 * script's environment while jsdom provides the real DOM implementation
 * (querySelector, createTreeWalker, MutationObserver, etc.).
 */
import * as vm from 'vm';
import { CUSTOM_PROVIDER_MODEL_COUNT_FIX_SCRIPT } from './plugin';

// ─────────────────────────────────────────────────────────────────────────────
// Canned API response data
// ─────────────────────────────────────────────────────────────────────────────

const UUID_A = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const UUID_B = 'b2c3d4e5-f6a7-8901-bcde-f23456789012';
const UUID_C = 'c3d4e5f6-a7b8-9012-cdef-345678901234';

const CUSTOM_ROWS = [
  {
    provider: `custom:${UUID_A}`,
    provider_display_name: 'claude-proxy',
    display_name: 'claude-opus-5',
    id: `custom:${UUID_A}/claude-opus-5`,
    model_name: 'claude-opus-5',
  },
  {
    provider: `custom:${UUID_A}`,
    provider_display_name: 'claude-proxy',
    display_name: 'claude-sonnet-4',
    id: `custom:${UUID_A}/claude-sonnet-4`,
    model_name: 'claude-sonnet-4',
  },
  {
    provider: `custom:${UUID_A}`,
    provider_display_name: 'claude-proxy',
    display_name: 'claude-haiku-3',
    id: `custom:${UUID_A}/claude-haiku-3`,
    model_name: 'claude-haiku-3',
  },
];

const OTHER_ROWS = [
  {
    provider: 'openai',
    provider_display_name: 'OpenAI',
    display_name: 'gpt-4',
    id: 'openai/gpt-4',
    model_name: 'gpt-4',
  },
  {
    provider: 'anthropic',
    provider_display_name: 'Anthropic',
    display_name: 'claude-3-opus',
    id: 'anthropic/claude-3-opus',
    model_name: 'claude-3-opus',
  },
];

const ALL_ROWS = [...CUSTOM_ROWS, ...OTHER_ROWS];

// S6 needs two distinct custom providers with distinct display names
// so the label map can resolve both UUIDs.
const S6_ROWS = [
  {
    provider: `custom:${UUID_A}`,
    provider_display_name: 'claude-proxy',
    display_name: 'claude-opus-5',
    id: `custom:${UUID_A}/claude-opus-5`,
    model_name: 'claude-opus-5',
  },
  {
    provider: `custom:${UUID_B}`,
    provider_display_name: 'another-cp',
    display_name: 'claude-sonnet-4',
    id: `custom:${UUID_B}/claude-sonnet-4`,
    model_name: 'claude-sonnet-4',
  },
  ...OTHER_ROWS,
];

// ─────────────────────────────────────────────────────────────────────────────
// Mock fetch factory
// ─────────────────────────────────────────────────────────────────────────────

function mockFetchResponse(rows: unknown[]) {
  const impl = () =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(rows),
      text: () => Promise.resolve(JSON.stringify(rows)),
      status: 200,
      statusText: 'OK',
    } as Response);
  return jest.fn().mockImplementation(impl);
}

// ─────────────────────────────────────────────────────────────────────────────
// DOM builders for each surface
// ─────────────────────────────────────────────────────────────────────────────

function buildS1DOM(): { table: HTMLTableElement; modelsCell: HTMLTableCellElement } {
  const table = document.createElement('table');
  table.className = 'data-table';
  const tbody = document.createElement('tbody');
  const tr = document.createElement('tr');

  const nameCell = document.createElement('td');
  nameCell.textContent = 'claude-proxy';
  const typeCell = document.createElement('td');
  typeCell.textContent = 'custom';
  const connCell = document.createElement('td');
  connCell.textContent = 'connected';
  const modelsCell = document.createElement('td');
  modelsCell.textContent = '0';

  tr.appendChild(nameCell);
  tr.appendChild(typeCell);
  tr.appendChild(connCell);
  tr.appendChild(modelsCell);
  tbody.appendChild(tr);
  table.appendChild(tbody);
  document.body.appendChild(table);

  return { table, modelsCell };
}

function buildS2DOM(): { table: HTMLTableElement; noteSpan: HTMLSpanElement } {
  const table = document.createElement('table');
  table.className = 'data-table';
  const tbody = document.createElement('tbody');
  const tr = document.createElement('tr');

  const nameCell = document.createElement('td');
  nameCell.textContent = 'claude-proxy';
  const typeCell = document.createElement('td');
  typeCell.textContent = 'custom';
  const connCell = document.createElement('td');
  connCell.textContent = 'connected';
  const modelsCell = document.createElement('td');
  modelsCell.textContent = '0';

  // S2: sibling span with "models: 0" text inside the same row
  const noteSpan = document.createElement('span');
  noteSpan.textContent = 'models: 0';
  modelsCell.appendChild(noteSpan);

  tr.appendChild(nameCell);
  tr.appendChild(typeCell);
  tr.appendChild(connCell);
  tr.appendChild(modelsCell);
  tbody.appendChild(tr);
  table.appendChild(tbody);
  document.body.appendChild(table);

  return { table, noteSpan };
}

function buildS3DOM(): { labelSpan: HTMLSpanElement; valueSpan: HTMLSpanElement } {
  const wrapper = document.createElement('span');
  const labelSpan = document.createElement('span');
  labelSpan.textContent = 'Models:';
  const valueSpan = document.createElement('span');
  valueSpan.textContent = '0';

  wrapper.appendChild(labelSpan);
  wrapper.appendChild(document.createTextNode(' '));
  wrapper.appendChild(valueSpan);
  document.body.appendChild(wrapper);

  return { labelSpan, valueSpan };
}

function buildS5DOM(): { table: HTMLTableElement; modelsCell: HTMLTableCellElement } {
  const table = document.createElement('table');
  table.className = 'data-table';
  const tbody = document.createElement('tbody');
  const tr = document.createElement('tr');

  const nameCell = document.createElement('td');
  nameCell.textContent = 'claude-proxy';
  const typeCell = document.createElement('td');
  typeCell.textContent = 'custom';
  const connCell = document.createElement('td');
  connCell.textContent = 'connected';
  const modelsCell = document.createElement('td');
  modelsCell.textContent = '0';

  tr.appendChild(nameCell);
  tr.appendChild(typeCell);
  tr.appendChild(connCell);
  tr.appendChild(modelsCell);
  tbody.appendChild(tr);
  table.appendChild(tbody);
  document.body.appendChild(table);

  return { table, modelsCell };
}

function buildS6DOM(): { container: HTMLDivElement; textNodeA: Text; textNodeB: Text } {
  const container = document.createElement('div');
  container.className = 'routing-modal';

  const spanA = document.createElement('span');
  const textNodeA = document.createTextNode(`custom:${UUID_A}`);
  spanA.appendChild(textNodeA);

  const spanB = document.createElement('span');
  const textNodeB = document.createTextNode(`custom:${UUID_B}`);
  spanB.appendChild(textNodeB);

  container.appendChild(spanA);
  container.appendChild(spanB);
  document.body.appendChild(container);

  return { container, textNodeA, textNodeB };
}

// ─────────────────────────────────────────────────────────────────────────────
// Script runner: executes the IIFE in a vm sandbox with jsdom's DOM
// ─────────────────────────────────────────────────────────────────────────────

interface RunOptions {
  pathname: string;
  fetchMock: jest.Mock;
}

function runScript({ pathname, fetchMock }: RunOptions): void {
  // Build a sandbox that exposes jsdom's DOM but with a configurable
  // location.pathname. The script reads window.location.pathname to
  // detect the current page, so we shadow it in the sandbox.
  const sandbox: Record<string, unknown> = {
    // DOM globals from jsdom
    document,
    NodeFilter,
    MutationObserver,
    // Configurable location
    location: { pathname },
    // Registry
    __manifestPluginsDashboardTransform: [] as unknown[],
    // Standard globals the script may use
    console,
    Promise,
    fetch: fetchMock,
    encodeURIComponent,
    decodeURIComponent,
    Number,
    Object,
    Array,
    String,
    RegExp,
    Math,
    Error,
    JSON,
    Boolean,
    Date,
    parseFloat,
    parseInt,
    isNaN,
    isFinite,
    setTimeout: () => 0,
    setInterval: () => 0,
    clearTimeout: () => undefined,
    clearInterval: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(CUSTOM_PROVIDER_MODEL_COUNT_FIX_SCRIPT, sandbox, { timeout: 5000 });
}

function getRegistryEntry(): { id: string; version: string; install: () => void } {
  // After runScript, the registry lives on the sandbox's window object.
  // We re-run the script to get a fresh registry, or we can capture it.
  // For simplicity, we run the script and then invoke install() from
  // the registry entry that was pushed.
  // This helper is not used directly — see runScriptAndInstall below.
  throw new Error('Use runScriptAndInstall instead');
}

// Track MutationObserver instances so we can disconnect them between tests.
// Without this, observers from previous tests fire when subsequent tests
// mutate the shared jsdom document, causing cross-test pollution.
const activeObservers: MutationObserver[] = [];

function TrackingMutationObserver(callback: MutationCallback): MutationObserver {
  const obs = new MutationObserver(callback);
  activeObservers.push(obs);
  return obs;
}

function runScriptAndInstall({ pathname, fetchMock }: RunOptions): void {
  const sandbox: Record<string, unknown> = {
    document,
    NodeFilter,
    MutationObserver: TrackingMutationObserver,
    location: { pathname },
    __manifestPluginsDashboardTransform: [] as unknown[],
    console,
    Promise,
    fetch: fetchMock,
    encodeURIComponent,
    decodeURIComponent,
    Number,
    Object,
    Array,
    String,
    RegExp,
    Math,
    Error,
    JSON,
    Boolean,
    Date,
    parseFloat,
    parseInt,
    isNaN,
    isFinite,
    setTimeout: () => 0,
    setInterval: () => 0,
    clearTimeout: () => undefined,
    clearInterval: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(CUSTOM_PROVIDER_MODEL_COUNT_FIX_SCRIPT, sandbox, { timeout: 5000 });

  // Invoke the plugin's install() — the same function the host calls
  // on DOMContentLoaded.
  const registry = sandbox.__manifestPluginsDashboardTransform as Array<{
    id: string;
    version: string;
    install: () => void;
  }>;
  const entry = registry.find((e) => e.id === 'custom-provider-model-count-fix');
  if (!entry) {
    throw new Error('Plugin did not register itself on __manifestPluginsDashboardTransform');
  }
  entry.install();
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe('CustomProviderModelCountFixPlugin (live)', () => {
  beforeEach(() => {
    // Reset the DOM between tests
    document.body.innerHTML = '';
  });

  afterEach(() => {
    // Disconnect all MutationObservers created during the test so they
    // don't fire when subsequent tests mutate the shared jsdom document.
    for (const obs of activeObservers) {
      obs.disconnect();
    }
    activeObservers.length = 0;
  });

  // ─────────────────────────────────────────────────────────────────────────
  // S1: Per-agent Connections page — Models column <td>
  // ─────────────────────────────────────────────────────────────────────────
  it('S1: patches the Models <td> on /harnesses/Playground/providers', async () => {
    const { modelsCell } = buildS1DOM();
    const fetchMock = mockFetchResponse(ALL_ROWS);

    runScriptAndInstall({
      pathname: '/harnesses/Playground/providers',
      fetchMock,
    });

    // Allow the fetch promise to resolve
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(modelsCell.textContent).toContain('3');
    expect(modelsCell.dataset.mwpModelCountPatched).toBe('true');
    expect(modelsCell.querySelector('.mwp-model-count-patch-note')).not.toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // S2: Agent-list subscription note — "models: N" span
  // ─────────────────────────────────────────────────────────────────────────
  it('S2: patches the "models: 0" span on /harnesses/Playground/providers', async () => {
    const { noteSpan } = buildS2DOM();
    const fetchMock = mockFetchResponse(ALL_ROWS);

    runScriptAndInstall({
      pathname: '/harnesses/Playground/providers',
      fetchMock,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(noteSpan.textContent).toBe('models: 3');
    expect(noteSpan.dataset.mpCountFix).toBe('s2');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // S3: ConnectionDetail page — "Models:" label + value span
  // ─────────────────────────────────────────────────────────────────────────
  it('S3: patches the value span on /providers/connections/abc-123', async () => {
    const { valueSpan } = buildS3DOM();
    const fetchMock = mockFetchResponse(ALL_ROWS);

    runScriptAndInstall({
      pathname: '/providers/connections/abc-123',
      fetchMock,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(valueSpan.textContent).toContain('3');
    expect(valueSpan.dataset.mwpModelCountPatched).toBe('true');
    expect(valueSpan.querySelector('.mwp-model-count-patch-note')).not.toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // S5: /providers connections-list page — per-row badge
  // ─────────────────────────────────────────────────────────────────────────
  it('S5: patches the Models <td> on /providers', async () => {
    const { modelsCell } = buildS5DOM();
    const fetchMock = mockFetchResponse(ALL_ROWS);

    runScriptAndInstall({
      pathname: '/providers',
      fetchMock,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(modelsCell.textContent).toContain('3');
    expect(modelsCell.dataset.mpCountFix).toBe('s5');
    expect(modelsCell.querySelector('.mwp-model-count-patch-note')).not.toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // S6: Routing picker page — "custom:<uuid>" label relabel
  // ─────────────────────────────────────────────────────────────────────────
  it('S6: relabels "custom:<uuid>" text nodes on /harnesses/Playground/routing', async () => {
    const { container, textNodeA, textNodeB } = buildS6DOM();
    const fetchMock = mockFetchResponse(S6_ROWS);

    runScriptAndInstall({
      pathname: '/harnesses/Playground/routing',
      fetchMock,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(textNodeA.textContent).toBe('claude-proxy');
    expect(textNodeB.textContent).toBe('another-cp');
    // Parent elements should have the s6 marker
    const parentA = textNodeA.parentElement;
    const parentB = textNodeB.parentElement;
    expect(parentA?.dataset.mpCountFix).toBe('s6');
    expect(parentB?.dataset.mpCountFix).toBe('s6');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // S6 (root /routing path): same behavior on the root routing URL
  // ─────────────────────────────────────────────────────────────────────────
  it('S6: relabels "custom:<uuid>" text nodes on /routing', async () => {
    const { textNodeA, textNodeB } = buildS6DOM();
    const fetchMock = mockFetchResponse(S6_ROWS);

    runScriptAndInstall({
      pathname: '/routing',
      fetchMock,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(textNodeA.textContent).toBe('claude-proxy');
    expect(textNodeB.textContent).toBe('another-cp');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Defensive: fetch returns [] — leaves upstream 0 text intact
  // ─────────────────────────────────────────────────────────────────────────
  it('leaves upstream 0 text intact when fetch returns []', async () => {
    const { modelsCell } = buildS1DOM();
    const fetchMock = mockFetchResponse([]);

    runScriptAndInstall({
      pathname: '/harnesses/Playground/providers',
      fetchMock,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(modelsCell.textContent).toBe('0');
    expect(modelsCell.dataset.mwpModelCountPatched).toBeUndefined();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Defensive: DOM has no matching surface — leaves everything untouched
  // ─────────────────────────────────────────────────────────────────────────
  it('leaves everything untouched when DOM has no matching surface', async () => {
    // Build a DOM that does NOT match any surface (no table, no spans)
    const div = document.createElement('div');
    div.textContent = 'unrelated content';
    document.body.appendChild(div);
    const fetchMock = mockFetchResponse(ALL_ROWS);

    runScriptAndInstall({
      pathname: '/harnesses/Playground/providers',
      fetchMock,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(div.textContent).toBe('unrelated content');
    expect(div.dataset.mwpModelCountPatched).toBeUndefined();
    expect(div.dataset.mpCountFix).toBeUndefined();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Defensive: re-running install() is idempotent — no double-patch
  // ─────────────────────────────────────────────────────────────────────────
  it('is idempotent: re-running install() does not double-patch', async () => {
    const { modelsCell } = buildS1DOM();
    const fetchMock = mockFetchResponse(ALL_ROWS);

    const sandbox: Record<string, unknown> = {
      document,
      NodeFilter,
      MutationObserver: TrackingMutationObserver,
      location: { pathname: '/harnesses/Playground/providers' },
      __manifestPluginsDashboardTransform: [] as unknown[],
      console,
      Promise,
      fetch: fetchMock,
      encodeURIComponent,
      decodeURIComponent,
      Number,
      Object,
      Array,
      String,
      RegExp,
      Math,
      Error,
      JSON,
      Boolean,
      Date,
      parseFloat,
      parseInt,
      isNaN,
      isFinite,
      setTimeout: () => 0,
      setInterval: () => 0,
      clearTimeout: () => undefined,
      clearInterval: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(CUSTOM_PROVIDER_MODEL_COUNT_FIX_SCRIPT, sandbox, { timeout: 5000 });

    const registry = sandbox.__manifestPluginsDashboardTransform as Array<{
      id: string;
      version: string;
      install: () => void;
    }>;
    const entry = registry.find((e) => e.id === 'custom-provider-model-count-fix');
    if (!entry) throw new Error('Plugin not registered');

    // First install
    entry.install();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const firstText = modelsCell.textContent;
    const firstNoteCount = modelsCell.querySelectorAll('.mwp-model-count-patch-note').length;

    // Second install — should be a no-op due to the dataset marker
    entry.install();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(modelsCell.textContent).toBe(firstText);
    expect(modelsCell.querySelectorAll('.mwp-model-count-patch-note').length).toBe(firstNoteCount);
    expect(modelsCell.dataset.mwpModelCountPatched).toBe('true');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Defensive: S6 with response missing provider_display_name — leaves UUID intact
  // ─────────────────────────────────────────────────────────────────────────
  it('S6: leaves upstream UUID label intact when provider_display_name is missing', async () => {
    const rowsMissingDisplayName = [
      {
        provider: `custom:${UUID_A}`,
        // provider_display_name is intentionally missing
        display_name: 'claude-opus-5',
        id: `custom:${UUID_A}/claude-opus-5`,
        model_name: 'claude-opus-5',
      },
    ];
    const { textNodeA } = buildS6DOM();
    const fetchMock = mockFetchResponse(rowsMissingDisplayName);

    runScriptAndInstall({
      pathname: '/harnesses/Playground/routing',
      fetchMock,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    // The UUID label should remain unchanged
    expect(textNodeA.textContent).toBe(`custom:${UUID_A}`);
    const parent = textNodeA.parentElement;
    expect(parent?.dataset.mpCountFix).toBeUndefined();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Defensive: fetchAvailableModels counts rows missing provider_display_name
  // ─────────────────────────────────────────────────────────────────────────
  it('counts custom-provider rows even when provider_display_name is missing', async () => {
    const rowsMissingDisplayName = [
      {
        provider: `custom:${UUID_A}`,
        display_name: 'claude-opus-5',
        id: `custom:${UUID_A}/claude-opus-5`,
        model_name: 'claude-opus-5',
      },
      {
        provider: `custom:${UUID_A}`,
        display_name: 'claude-sonnet-4',
        id: `custom:${UUID_A}/claude-sonnet-4`,
        model_name: 'claude-sonnet-4',
      },
      {
        provider: `custom:${UUID_B}`,
        display_name: 'claude-haiku-3',
        id: `custom:${UUID_B}/claude-haiku-3`,
        model_name: 'claude-haiku-3',
      },
    ];
    const { valueSpan } = buildS3DOM();
    const fetchMock = mockFetchResponse(rowsMissingDisplayName);

    runScriptAndInstall({
      pathname: '/providers/connections/abc-123',
      fetchMock,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    // All 3 custom rows must be counted despite missing provider_display_name.
    // The S3 patcher falls back to totalCustom when no per-connection scope
    // is found, so the value span should show '3'.
    expect(valueSpan.textContent).toContain('3');
    expect(valueSpan.dataset.mwpModelCountPatched).toBe('true');
    expect(valueSpan.querySelector('.mwp-model-count-patch-note')).not.toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // S3 configured-count: ConnectionDetail uses the Edit-form models column,
  // not the routing-picker count
  // ─────────────────────────────────────────────────────────────────────────
  it('S3: ConnectionDetail shows the configured model count from the custom-providers endpoint, not the picker count', async () => {
    const { valueSpan } = buildS3DOM();

    // The routing picker returns 13 custom rows (the over-counted value
    // the user saw), while the operator configured exactly 3 models on
    // this connection's custom provider. The patch must show 3.
    const pickerRows = Array.from({ length: 13 }, (_, i) => ({
      provider: `custom:${UUID_A}`,
      provider_display_name: 'claude-proxy',
      display_name: `model-${i}`,
      id: `custom:${UUID_A}/model-${i}`,
      model_name: `model-${i}`,
    }));
    const connectionDetail = {
      connection: {
        id: 'conn-1',
        provider: `custom:${UUID_A}`,
        auth_type: 'api_key',
        label: 'claude-proxy',
        cached_model_count: 0,
        key_prefix: null,
        connected_at: '2026-01-01T00:00:00Z',
        is_active: true,
        last_used_at: null,
      },
      agents: [],
      model_usage: [],
      recent_messages: [],
    };
    const customProviders = [
      {
        id: UUID_A,
        name: 'claude-proxy',
        base_url: 'http://localhost:9997/agy/v1',
        api_kind: 'anthropic',
        has_api_key: true,
        models: [
          { id: 'claude-opus-5' },
          { id: 'claude-sonnet-4' },
          { id: 'claude-haiku-3' },
        ],
        created_at: '2026-01-01T00:00:00Z',
      },
    ];

    const fetchMock = jest.fn().mockImplementation((url: string) => {
      let body: unknown = [];
      if (url.indexOf('/api/v1/provider-analytics/connection-detail') === 0) {
        body = connectionDetail;
      } else if (url.indexOf('/api/v1/routing/Playground/custom-providers') === 0) {
        body = customProviders;
      } else if (url.indexOf('/available-models') !== -1) {
        body = pickerRows;
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
        status: 200,
        statusText: 'OK',
      } as Response);
    });

    runScriptAndInstall({
      pathname: '/providers/connections/conn-1',
      fetchMock,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    // The configured count (3) wins over the picker count (13).
    expect(valueSpan.textContent).toContain('3');
    expect(valueSpan.textContent).not.toContain('13');
    expect(valueSpan.dataset.mwpModelCountPatched).toBe('true');
    expect(valueSpan.querySelector('.mwp-model-count-patch-note')).not.toBeNull();
    expect(valueSpan.textContent).toContain('(patched: this connection)');

    // Both per-connection endpoints were queried.
    const calledUrls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calledUrls.some((u) => u.indexOf('/api/v1/provider-analytics/connection-detail?connection_id=conn-1') === 0)).toBe(true);
    expect(calledUrls.some((u) => u.indexOf('/api/v1/routing/Playground/custom-providers') === 0)).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // S3 fallback: per-connection lookup fails → picker total with fallback subtitle
  // ─────────────────────────────────────────────────────────────────────────
  it('S3: falls back to the picker total when the configured-models lookup fails', async () => {
    const { valueSpan } = buildS3DOM();

    const fetchMock = jest.fn().mockImplementation((url: string) => {
      if (url.indexOf('/api/v1/provider-analytics/connection-detail') === 0) {
        return Promise.resolve({
          ok: false,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve('boom'),
          status: 500,
          statusText: 'Server Error',
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(ALL_ROWS),
        text: () => Promise.resolve(JSON.stringify(ALL_ROWS)),
        status: 200,
        statusText: 'OK',
      } as Response);
    });

    runScriptAndInstall({
      pathname: '/providers/connections/conn-1',
      fetchMock,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    // ALL_ROWS has 3 custom rows → totalCustom = 3, with the fallback subtitle.
    expect(valueSpan.textContent).toContain('3');
    expect(valueSpan.dataset.mwpModelCountPatched).toBe('true');
    expect(valueSpan.textContent).toContain('scoping unavailable');
  });
});
