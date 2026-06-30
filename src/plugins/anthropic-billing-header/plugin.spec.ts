import { AnthropicBillingHeaderPlugin } from './plugin';
import {
  cchHasherReady,
  computeCchForBody,
} from './cch';
import {
  buildBillingBlock,
  buildFinalBody,
  buildSystemArray,
  computeVersionSuffix,
  extractFirstUserText,
  serializeBody,
} from './body';
import {
  prependMovedContentToFirstUserMessage,
  relocateSystemContent,
} from './system-relocation';
import { CCH_PLACEHOLDER, CLAUDE_CODE_IDENTITY_TEXT } from './constants';
import type { RequestTransformDecision } from '../..';

const ENV_KEYS = ['MANIFEST_CC_VERSION', 'MANIFEST_CCH_VALUE', 'MANIFEST_CC_RELOCATE'] as const;
type EnvKey = (typeof ENV_KEYS)[number];

const snapshot: Record<EnvKey, string | undefined> = {
  MANIFEST_CC_VERSION: undefined,
  MANIFEST_CCH_VALUE: undefined,
  MANIFEST_CC_RELOCATE: undefined,
};

function setEnv(values: Partial<Record<EnvKey, string>>): void {
  for (const key of ENV_KEYS) {
    if (key in values) {
      const v = values[key];
      if (v === undefined) delete process.env[key];
      else process.env[key] = v;
    }
  }
}

function resetEnv(): void {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key]!;
  }
}

beforeAll(async () => {
  // Wait for the hash-wasm WASM modules to instantiate so per-request
  // xxHash64 calls don't race the cold-start (and accidentally fall
  // back to the `00000` placeholder).
  await cchHasherReady;
});

beforeEach(() => {
  for (const key of ENV_KEYS) snapshot[key] = process.env[key];
  setEnv({
    MANIFEST_CC_VERSION: undefined,
    MANIFEST_CCH_VALUE: undefined,
    MANIFEST_CC_RELOCATE: undefined,
  });
});

afterEach(() => {
  resetEnv();
});

function makeDecision(
  overrides: Partial<RequestTransformDecision> = {},
): RequestTransformDecision {
  return {
    endpointKey: 'anthropic',
    provider: 'anthropic',
    bareModel: 'claude-sonnet-4-20250514',
    apiKey: 'sk-ant-oat01-fake',
    authType: 'subscription',
    apiMode: 'chat_completions',
    stream: false,
    url: 'https://api.anthropic.com/v1/messages',
    headers: {},
    requestBody: {
      messages: [{ role: 'user', content: 'Hello world from a test prompt' }],
    },
    ...overrides,
  };
}

// =============================================================================
// Plugin metadata
// =============================================================================

describe('AnthropicBillingHeaderPlugin (metadata)', () => {
  it('ships metadata version 0.5.0 (S6 fingerprint relocation)', () => {
    expect(AnthropicBillingHeaderPlugin.metadata.version).toBe('0.5.0');
  });
});

// =============================================================================
// Gate behavior (unchanged from 0.2.0)
// =============================================================================

describe('AnthropicBillingHeaderPlugin (gating)', () => {
  it('skips the billing header when authType is api_key (S3)', () => {
    const plugin = new AnthropicBillingHeaderPlugin();
    const result = plugin.transformRequest(
      makeDecision({ authType: 'api_key' }),
    );
    expect(result).toBeUndefined();
  });

  it('skips the billing header for Anthropic-compatible proxies', () => {
    const plugin = new AnthropicBillingHeaderPlugin();
    const result = plugin.transformRequest(
      makeDecision({ endpointKey: 'byteplus-anthropic' }),
    );
    expect(result).toBeUndefined();
  });

  it('skips the billing header when authType is undefined', () => {
    const plugin = new AnthropicBillingHeaderPlugin();
    const result = plugin.transformRequest(makeDecision({ authType: undefined }));
    expect(result).toBeUndefined();
  });
});

// =============================================================================
// S1 — Happy path: subscription auth on canonical Anthropic
// =============================================================================

describe('AnthropicBillingHeaderPlugin (S1 happy path)', () => {
  it('returns url, headers, and requestBody for subscription auth', () => {
    const plugin = new AnthropicBillingHeaderPlugin();
    const result = plugin.transformRequest(makeDecision());

    expect(result).toBeDefined();
    expect(result).toHaveProperty('url');
    expect(result).toHaveProperty('headers');
    expect(result).toHaveProperty('requestBody');
  });

  it('appends ?beta=true to /v1/messages URL with correct separator', () => {
    const plugin = new AnthropicBillingHeaderPlugin();
    const result = plugin.transformRequest(makeDecision())!;

    // Exact URL must be the endpoint with a proper ?beta=true query.
    // Regression: v0.3.0 produced ".../v1/messagesbeta=true" (missing ?)
    // causing upstream not_found_error.
    expect(result.url).toBe('https://api.anthropic.com/v1/messages?beta=true');
  });

  it('does not duplicate beta=true when already present', () => {
    const plugin = new AnthropicBillingHeaderPlugin();
    const result = plugin.transformRequest(
      makeDecision({ url: 'https://api.anthropic.com/v1/messages?beta=true' }),
    )!;

    expect(result.url).toBe('https://api.anthropic.com/v1/messages?beta=true');
  });

  it('appends beta=true with & when other query params exist', () => {
    const plugin = new AnthropicBillingHeaderPlugin();
    const result = plugin.transformRequest(
      makeDecision({ url: 'https://api.anthropic.com/v1/messages?stream=true' }),
    )!;

    expect(result.url).toBe('https://api.anthropic.com/v1/messages?stream=true&beta=true');
  });

  it('leaves non-/v1/messages URLs untouched', () => {
    const plugin = new AnthropicBillingHeaderPlugin();
    const result = plugin.transformRequest(
      makeDecision({ url: 'https://api.anthropic.com/v1/something_else' }),
    )!;
    // Plugin either returns a rewrite or a no-op for unsupported URLs;
    // either way beta=true must NOT appear on a wrong path.
    expect(result.url).not.toContain('beta=true');
  });

  it('injects the cch billing header for subscription auth on canonical Anthropic', () => {
    const plugin = new AnthropicBillingHeaderPlugin();
    const result = plugin.transformRequest(makeDecision())!;

    expect(result.headers!['x-anthropic-billing-header']).toMatch(
      /^cc_version=2\.1\.196\.[0-9a-f]{3}; cc_entrypoint=cli; cch=[0-9a-f]{5};$/,
    );
  });

  it('mints a freshly computed cch (not the static 00000 placeholder)', () => {
    const plugin = new AnthropicBillingHeaderPlugin();
    const header = plugin.transformRequest(makeDecision())!.headers![
      'x-anthropic-billing-header'
    ]!;
    expect(header).not.toMatch(/cch=00000;/);
  });

  it('returns requestBody whose system[0] is the billing header block', () => {
    const plugin = new AnthropicBillingHeaderPlugin();
    const result = plugin.transformRequest(makeDecision())!;
    const body = result.requestBody as Record<string, unknown>;
    const system = body['system'];

    expect(Array.isArray(system)).toBe(true);
    const arr = system as Array<Record<string, unknown>>;
    expect(arr[0]?.['text']).toMatch(
      /^x-anthropic-billing-header: cc_version=2\.1\.196\.[0-9a-f]{3}; cc_entrypoint=cli; cch=[0-9a-f]{5};$/,
    );
  });

  it('places the Claude Code identity in system[1] (after billing header)', () => {
    const plugin = new AnthropicBillingHeaderPlugin();
    const result = plugin.transformRequest(makeDecision())!;
    const body = result.requestBody as Record<string, unknown>;
    const system = body['system'] as Array<Record<string, unknown>>;

    expect(system[1]).toEqual({
      type: 'text',
      text: 'You are Claude Code, Anthropic\'s official CLI for Claude.',
    });
  });

  it('preserves pre-existing system blocks after billing + identity', () => {
    const plugin = new AnthropicBillingHeaderPlugin();
    const result = plugin.transformRequest(
      makeDecision({
        requestBody: {
          system: 'Original system prompt',
          messages: [{ role: 'user', content: 'Hello' }],
        },
      }),
    )!;
    const body = result.requestBody as Record<string, unknown>;
    const system = body['system'] as Array<Record<string, unknown>>;

    expect(system).toHaveLength(3);
    expect(system[0]!.text).toMatch(/^x-anthropic-billing-header:/);
    expect(system[1]!.text).toMatch(/^You are Claude Code/);
    expect(system[2]).toEqual({ type: 'text', text: 'Original system prompt' });
  });

  it('preserves cache_control on pre-existing system blocks', () => {
    const plugin = new AnthropicBillingHeaderPlugin();
    const result = plugin.transformRequest(
      makeDecision({
        requestBody: {
          system: [
            {
              type: 'text',
              text: 'Tool instructions',
              cache_control: { type: 'ephemeral' },
            },
          ],
          messages: [{ role: 'user', content: 'Hello' }],
        },
      }),
    )!;
    const body = result.requestBody as Record<string, unknown>;
    const system = body['system'] as Array<Record<string, unknown>>;

    // Billing + identity + original
    expect(system).toHaveLength(3);
    expect(system[2]).toEqual({
      type: 'text',
      text: 'Tool instructions',
      cache_control: { type: 'ephemeral' },
    });
  });

  it('does not duplicate the identity block if it is already present in system[]', () => {
    const plugin = new AnthropicBillingHeaderPlugin();
    const result = plugin.transformRequest(
      makeDecision({
        requestBody: {
          system: [
            {
              type: 'text',
              text: 'You are Claude Code, Anthropic\'s official CLI for Claude.',
            },
          ],
          messages: [{ role: 'user', content: 'Hello' }],
        },
      }),
    )!;
    const body = result.requestBody as Record<string, unknown>;
    const system = body['system'] as Array<Record<string, unknown>>;

    const identityCount = system.filter(
      (s) => s.text === 'You are Claude Code, Anthropic\'s official CLI for Claude.',
    ).length;
    expect(identityCount).toBe(1);
  });

  it('injects fingerprint HTTP headers (User-Agent, anthropic-beta, x-app)', () => {
    const plugin = new AnthropicBillingHeaderPlugin();
    const result = plugin.transformRequest(makeDecision())!;

    expect(result.headers!['user-agent']).toBe('claude-cli/2.1.196 (external, cli)');
    expect(result.headers!['anthropic-beta']).toContain('claude-code-20250219');
    expect(result.headers!['anthropic-beta']).toContain('oauth-2025-04-20');
    expect(result.headers!['x-app']).toBe('cli');
    expect(result.headers!['anthropic-version']).toBe('2023-06-01');
  });
});

// =============================================================================
// S2 — Seed fallback for unknown / new Claude Code versions
// =============================================================================

describe('AnthropicBillingHeaderPlugin (S2 seed fallback)', () => {
  it('uses the current seed for an unknown MANIFEST_CC_VERSION', () => {
    setEnv({ MANIFEST_CC_VERSION: '2.1.999' });
    const plugin = new AnthropicBillingHeaderPlugin();
    const result = plugin.transformRequest(makeDecision())!;

    // cc_version matches the env value; cch is not the placeholder.
    expect(result.headers!['x-anthropic-billing-header']).toMatch(
      /^cc_version=2\.1\.999\.[0-9a-f]{3}; cc_entrypoint=cli; cch=[0-9a-f]{5};$/,
    );
  });

  it('honors MANIFEST_CCH_VALUE raw override (with cch= prefix stripped) — full no-op', () => {
    setEnv({ MANIFEST_CCH_VALUE: 'cch=abc12' });
    const plugin = new AnthropicBillingHeaderPlugin();
    const result = plugin.transformRequest(makeDecision())!;

    expect(result.headers!['x-anthropic-billing-header']).toMatch(/; cch=abc12;$/);
  });

  it('honors MANIFEST_CCH_VALUE raw override (without prefix)', () => {
    setEnv({ MANIFEST_CCH_VALUE: 'fa690' });
    const plugin = new AnthropicBillingHeaderPlugin();
    const result = plugin.transformRequest(makeDecision())!;

    expect(result.headers!['x-anthropic-billing-header']).toMatch(/; cch=fa690;$/);
  });

  it('falls back to body attestation when MANIFEST_CCH_VALUE is empty string', () => {
    setEnv({ MANIFEST_CCH_VALUE: '' });
    const plugin = new AnthropicBillingHeaderPlugin();
    const result = plugin.transformRequest(makeDecision())!;

    expect(result.headers!['x-anthropic-billing-header']).toMatch(
      /; cch=[0-9a-f]{5};$/,
    );
    expect(result.headers!['x-anthropic-billing-header']).not.toMatch(/; cch=00000;$/);
  });
});

// =============================================================================
// S5 — cch preimage semantics (v2.1.172+)
// =============================================================================

describe('AnthropicBillingHeaderPlugin (S5 cch preimage)', () => {
  it('produces the SAME cch when only `model` and `max_tokens` differ between requests', () => {
    // Anthropic's classifier computes cch over the body WITH the `model`
    // value blanked and `max_tokens` removed (per the v2.1.172+ cch
    // preimage transform). If our plugin computes cch over the raw body
    // (pre-transform), the cch will not match what Anthropic expects and
    // the request will be classified as third-party.
    const plugin = new AnthropicBillingHeaderPlugin();
    const a = plugin.transformRequest(
      makeDecision({
        requestBody: {
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          messages: [{ role: 'user', content: 'Hello world' }],
        },
      }),
    )!;
    const b = plugin.transformRequest(
      makeDecision({
        requestBody: {
          model: 'claude-opus-4-6',
          max_tokens: 4096,
          messages: [{ role: 'user', content: 'Hello world' }],
        },
      }),
    )!;
    const aCch = a.headers!['x-anthropic-billing-header']!.match(
      /cch=([0-9a-f]{5})/,
    )![1];
    const bCch = b.headers!['x-anthropic-billing-header']!.match(
      /cch=([0-9a-f]{5})/,
    )![1];
    // The first user message text is the same, so the cc_version suffix
    // and identity block are the same; the cch must also match because
    // the cch preimage strips both fields.
    expect(aCch).toBe(bCch);
  });

  it('produces DIFFERENT cch when the first user message text differs', () => {
    const plugin = new AnthropicBillingHeaderPlugin();
    const a = plugin.transformRequest(makeDecision())!;
    const b = plugin.transformRequest(
      makeDecision({
        requestBody: {
          messages: [{ role: 'user', content: 'A completely different prompt' }],
        },
      }),
    )!;
    const aCch = a.headers!['x-anthropic-billing-header']!.match(
      /cch=([0-9a-f]{5})/,
    )![1];
    const bCch = b.headers!['x-anthropic-billing-header']!.match(
      /cch=([0-9a-f]{5})/,
    )![1];
    expect(aCch).not.toBe(bCch);
  });
});

// =============================================================================
// Existing body-shape handling (regression coverage from 0.2.0)
// =============================================================================

describe('AnthropicBillingHeaderPlugin (request body content)', () => {
  it('reads first user text from array-form content with a text block', () => {
    const plugin = new AnthropicBillingHeaderPlugin();
    const result = plugin.transformRequest(
      makeDecision({
        requestBody: {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'array-form prompt' },
                { type: 'image_url', image_url: { url: 'https://example.com/x.png' } },
              ],
            },
          ],
        },
      }),
    )!;

    expect(result.headers!['x-anthropic-billing-header']).toContain(
      'cc_version=2.1.196.',
    );
    expect(result.headers!['x-anthropic-billing-header']).toMatch(
      /; cch=[0-9a-f]{5};$/,
    );
  });

  it('accepts input_text as a valid content type in array-form user messages', () => {
    const plugin = new AnthropicBillingHeaderPlugin();
    const result = plugin.transformRequest(
      makeDecision({
        requestBody: {
          messages: [
            {
              role: 'user',
              content: [{ type: 'input_text', text: 'openai-style block' }],
            },
          ],
        },
      }),
    )!;

    expect(result.headers!['x-anthropic-billing-header']).toMatch(
      /; cch=[0-9a-f]{5};$/,
    );
  });

  it('skips non-text-leading parts in array-form content and finds a later text block', () => {
    const plugin = new AnthropicBillingHeaderPlugin();
    const result = plugin.transformRequest(
      makeDecision({
        requestBody: {
          messages: [
            {
              role: 'user',
              content: [
                null,
                { type: 'image_url', image_url: { url: 'x' } },
                { type: 'text', text: 'real prompt' },
              ],
            },
          ],
        },
      }),
    )!;

    expect(result.headers!['x-anthropic-billing-header']).toMatch(
      /; cch=[0-9a-f]{5};$/,
    );
  });

  it('skips array-form content without a text block and continues to next message', () => {
    const plugin = new AnthropicBillingHeaderPlugin();
    const result = plugin.transformRequest(
      makeDecision({
        requestBody: {
          messages: [
            { role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] },
            { role: 'assistant', content: 'no' },
            { role: 'user', content: 'fallback' },
          ],
        },
      }),
    )!;

    expect(result.headers!['x-anthropic-billing-header']).toMatch(
      /; cch=[0-9a-f]{5};$/,
    );
  });

  it('skips non-object entries in the messages array', () => {
    const plugin = new AnthropicBillingHeaderPlugin();
    const result = plugin.transformRequest(
      makeDecision({
        requestBody: {
          messages: [
            null,
            'not an object',
            42,
            { role: 'user', content: 'real' },
          ] as unknown[],
        },
      }),
    )!;

    expect(result.headers!['x-anthropic-billing-header']).toMatch(
      /; cch=[0-9a-f]{5};$/,
    );
  });

  it('derives a stable suffix across requests with the same first-user-message chars', () => {
    setEnv({ MANIFEST_CC_VERSION: '2.1.196' });
    const plugin = new AnthropicBillingHeaderPlugin();
    const a = plugin.transformRequest(makeDecision())!;
    const b = plugin.transformRequest(makeDecision())!;

    expect(a.headers!['x-anthropic-billing-header']).toBe(
      b.headers!['x-anthropic-billing-header'],
    );
  });

  it('derives different suffixes for different first-user-message lengths', () => {
    setEnv({ MANIFEST_CC_VERSION: '2.1.196' });
    const plugin = new AnthropicBillingHeaderPlugin();
    const short = plugin.transformRequest(
      makeDecision({
        requestBody: { messages: [{ role: 'user', content: 'hi' }] },
      }),
    )!;
    const long = plugin.transformRequest(
      makeDecision({
        requestBody: {
          messages: [
            {
              role: 'user',
              content:
                'This message is long enough that the sampled indices ' +
                '[4], [7], and [20] are all distinct characters.',
            },
          ],
        },
      }),
    )!;

    const shortHeader = short.headers!['x-anthropic-billing-header']!;
    const longHeader = long.headers!['x-anthropic-billing-header']!;
    const shortSuffix = shortHeader.match(/\.([0-9a-f]{3});/)![1];
    const longSuffix = longHeader.match(/\.([0-9a-f]{3});/)![1];

    expect(shortSuffix).not.toBe(longSuffix);
  });

  it('matches the reference SHA-256 suffix for a known message', () => {
    const expectedSuffix = require('crypto')
      .createHash('sha256')
      .update(`59cf53e54c78oo02.1.196`)
      .digest('hex')
      .slice(0, 3);
    setEnv({ MANIFEST_CC_VERSION: '2.1.196' });
    const plugin = new AnthropicBillingHeaderPlugin();
    const result = plugin.transformRequest(
      makeDecision({
        requestBody: { messages: [{ role: 'user', content: 'hello world' }] },
      }),
    )!;
    expect(result.headers!['x-anthropic-billing-header']).toContain(
      `.${expectedSuffix};`,
    );
  });
});

// =============================================================================
// S6 — System relocation for OpenCode-fingerprinted prompts
// =============================================================================

describe('AnthropicBillingHeaderPlugin (S6 system relocation)', () => {
  beforeAll(async () => {
    await cchHasherReady;
  });

  it('relocates an OpenCode-style system prompt into the first user message (S6-relocate-1)', () => {
    const plugin = new AnthropicBillingHeaderPlugin();
    const opencodeSystem =
      'You are OpenCode, the best coding agent on the planet. Workspace root folder: /foo. is a git repo: yes. Use TodoWrite.';
    const result = plugin.transformRequest(
      makeDecision({
        requestBody: {
          system: opencodeSystem,
          messages: [{ role: 'user', content: 'Hello' }],
        },
      }),
    );

    expect(result).toBeDefined();
    const r = result!;
    const system = r.requestBody!['system'] as Array<Record<string, unknown>>;
    expect(system).toHaveLength(2);
    expect(system[0]!.text).toMatch(/^x-anthropic-billing-header:/);
    expect(system[1]!.text).toBe(CLAUDE_CODE_IDENTITY_TEXT);
    expect(typeof r.requestBody!['messages']).toBe('object');
    const messages = r.requestBody!['messages'] as Array<Record<string, unknown>>;
    expect(typeof messages[0]!['content']).toBe('string');
    const content = messages[0]!['content'] as string;
    expect(content.startsWith('[moved from system]')).toBe(true);
    expect(content).toContain(opencodeSystem);
  });

  it('keeps a clean system prompt in system[] and leaves user content unchanged (S6-relocate-2)', () => {
    const plugin = new AnthropicBillingHeaderPlugin();
    const result = plugin.transformRequest(
      makeDecision({
        requestBody: {
          system: 'Answer tersely.',
          messages: [{ role: 'user', content: 'Hi' }],
        },
      }),
    );

    expect(result).toBeDefined();
    const r = result!;
    const system = r.requestBody!['system'] as Array<Record<string, unknown>>;
    expect(system).toHaveLength(3);
    expect(system[0]!.text).toMatch(/^x-anthropic-billing-header:/);
    expect(system[1]!.text).toBe(CLAUDE_CODE_IDENTITY_TEXT);
    expect(system[2]!.text).toBe('Answer tersely.');
    const messages = r.requestBody!['messages'] as Array<Record<string, unknown>>;
    expect(messages[0]!['content']).toBe('Hi');
  });

  it('keeps clean mixed system entries and relocates only fingerprint-bearing entries (S6-relocate-3)', () => {
    const plugin = new AnthropicBillingHeaderPlugin();
    const result = plugin.transformRequest(
      makeDecision({
        requestBody: {
          system: [
            'You must be concise.',
            { type: 'text', text: 'OpenCode workspace root: /foo' },
          ],
          messages: [{ role: 'user', content: 'q' }],
        },
      }),
    );

    expect(result).toBeDefined();
    const r = result!;
    const system = r.requestBody!['system'] as Array<Record<string, unknown>>;
    expect(system).toHaveLength(3);
    expect(system[0]!.text).toMatch(/^x-anthropic-billing-header:/);
    expect(system[1]!.text).toBe(CLAUDE_CODE_IDENTITY_TEXT);
    expect(system[2]!.text).toBe('You must be concise.');
    const messages = r.requestBody!['messages'] as Array<Record<string, unknown>>;
    expect(messages[0]!['content']).toContain('OpenCode workspace root: /foo');
  });

  it('keeps oversized clean content in system[] and leaves user content unchanged (S6-relocate-4)', () => {
    const plugin = new AnthropicBillingHeaderPlugin();
    const longString = 'a'.repeat(3001);
    const result = plugin.transformRequest(
      makeDecision({
        requestBody: {
          system: longString,
          messages: [{ role: 'user', content: 'x' }],
        },
      }),
    );

    expect(result).toBeDefined();
    const r = result!;
    const system = r.requestBody!['system'] as Array<Record<string, unknown>>;
    expect(system).toHaveLength(3);
    expect(system[0]!.text).toMatch(/^x-anthropic-billing-header:/);
    expect(system[1]!.text).toBe(CLAUDE_CODE_IDENTITY_TEXT);
    expect(system[2]!.text).toBe(longString);
    const messages = r.requestBody!['messages'] as Array<Record<string, unknown>>;
    expect(messages[0]!['content']).toBe('x');
  });

  it('computes cch from the relocated body preimage (S6-relocate-5)', () => {
    const plugin = new AnthropicBillingHeaderPlugin();
    const opencodeSystem =
      'You are OpenCode, the best coding agent on the planet. Workspace root folder: /foo. is a git repo: yes. Use TodoWrite.';
    const requestBody = {
      system: opencodeSystem,
      messages: [{ role: 'user', content: 'Hello' }],
    };
    const result = plugin.transformRequest(makeDecision({ requestBody }));

    expect(result).toBeDefined();
    const r = result!;
    expect(r.headers!['x-anthropic-billing-header']).toMatch(
      /^cc_version=2\.1\.196\.[0-9a-f]{3}; cc_entrypoint=cli; cch=[0-9a-f]{5};$/,
    );
    const relocated = relocateSystemContent(requestBody['system'], {});
    const relocatedBody = prependMovedContentToFirstUserMessage(
      requestBody,
      relocated.moved,
      {},
    );
    const firstUserText = extractFirstUserText(relocatedBody);
    const suffix = computeVersionSuffix(firstUserText, '2.1.196');
    const placeholderHeader = `cc_version=2.1.196.${suffix}; cc_entrypoint=cli; cch=${CCH_PLACEHOLDER};`;
    const placeholderBillingBlock = buildBillingBlock(placeholderHeader);
    const systemArray = buildSystemArray(relocated.kept, placeholderBillingBlock);
    const placeholderBody = buildFinalBody(relocatedBody, systemArray);
    const expectedCch = computeCchForBody(serializeBody(placeholderBody), '2.1.196');
    const cch = r.headers!['x-anthropic-billing-header']!.match(/cch=([0-9a-f]{5})/)![1];
    expect(cch).toBe(expectedCch);
  });

  it('preserves v0.4.0 behavior when MANIFEST_CC_RELOCATE=false (S6-relocate-6)', () => {
    setEnv({ MANIFEST_CC_RELOCATE: 'false' });
    const plugin = new AnthropicBillingHeaderPlugin();
    const result = plugin.transformRequest(
      makeDecision({
        requestBody: {
          system:
            'You are OpenCode, the best coding agent on the planet. Workspace root folder: /foo. is a git repo: yes. Use TodoWrite.',
          messages: [{ role: 'user', content: 'Hello' }],
        },
      }),
    );

    expect(result).toBeDefined();
    const r = result!;
    const system = r.requestBody!['system'] as Array<Record<string, unknown>>;
    expect(system).toHaveLength(3);
    expect(system[0]!.text).toMatch(/^x-anthropic-billing-header:/);
    expect(system[1]!.text).toBe(CLAUDE_CODE_IDENTITY_TEXT);
    const messages = r.requestBody!['messages'] as Array<Record<string, unknown>>;
    expect(messages[0]!['content']).toBe('Hello');
  });

  it('creates a synthetic user message when moved content has no existing message target (S6-relocate-7)', () => {
    const plugin = new AnthropicBillingHeaderPlugin();
    const result = plugin.transformRequest(
      makeDecision({
        requestBody: {
          system: 'OpenCode workspace: /foo',
          messages: [],
        },
      }),
    );

    expect(result).toBeDefined();
    const r = result!;
    const messages = r.requestBody!['messages'] as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(1);
    expect(messages[0]!['role']).toBe('user');
    expect(typeof messages[0]!['content']).toBe('string');
    const content = messages[0]!['content'] as string;
    expect(content.startsWith('[moved from system]')).toBe(true);
    expect(content).toContain('OpenCode workspace: /foo');
  });

  it('does not double-prepend moved content on a second transform (S6-relocate-8)', () => {
    const plugin = new AnthropicBillingHeaderPlugin();
    const result = plugin.transformRequest(
      makeDecision({
        requestBody: {
          system: 'OpenCode workspace: /foo',
          messages: [
            {
              role: 'user',
              content: '[moved from system]\nOpenCode workspace: /foo\n\nHello',
            },
          ],
        },
      }),
    );

    expect(result).toBeDefined();
    const r = result!;
    const messages = r.requestBody!['messages'] as Array<Record<string, unknown>>;
    const content = messages[0]!['content'] as string;
    const markerCount = content.match(/\[moved from system]/g)?.length ?? 0;
    expect(markerCount).toBe(1);
    const system = r.requestBody!['system'] as Array<Record<string, unknown>>;
    expect(system).toHaveLength(2);
    const systemText = system.map((entry) => entry['text']).join('\n');
    expect(systemText).not.toContain('OpenCode workspace: /foo');
  });
});