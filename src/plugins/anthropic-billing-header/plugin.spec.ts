import { createHash } from 'crypto';
import {
  AnthropicBillingHeaderPlugin,
} from './plugin';
import type { RequestTransformDecision } from '../..';

const ENV_KEYS = ['MANIFEST_CC_VERSION', 'MANIFEST_CCH_VALUE'] as const;
type EnvKey = (typeof ENV_KEYS)[number];

const snapshot: Record<EnvKey, string | undefined> = {
  MANIFEST_CC_VERSION: undefined,
  MANIFEST_CCH_VALUE: undefined,
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

beforeEach(() => {
  for (const key of ENV_KEYS) snapshot[key] = process.env[key];
  setEnv({ MANIFEST_CC_VERSION: undefined, MANIFEST_CCH_VALUE: undefined });
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

describe('AnthropicBillingHeaderPlugin', () => {
  it('injects the billing header for subscription auth on canonical Anthropic', () => {
    // Default (env unset): cch defaults to 00000.
    const plugin = new AnthropicBillingHeaderPlugin();
    const result = plugin.transformRequest(makeDecision());

    expect(result).toBeDefined();
    expect(result!.headers!['x-anthropic-billing-header']).toMatch(
      /^cc_version=2\.1\.117\.[0-9a-f]{3}; cc_entrypoint=cli; cch=00000;$/,
    );
  });

  it('skips the billing header when authType is api_key', () => {
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

  it('honors MANIFEST_CC_VERSION env override', () => {
    setEnv({ MANIFEST_CC_VERSION: '2.1.999', MANIFEST_CCH_VALUE: '00000' });
    const plugin = new AnthropicBillingHeaderPlugin();
    const result = plugin.transformRequest(makeDecision());

    expect(result!.headers!['x-anthropic-billing-header']).toMatch(
      /^cc_version=2\.1\.999\./,
    );
    expect(result!.headers!['x-anthropic-billing-header']).toMatch(/; cch=00000;$/);
  });

  it('honors MANIFEST_CCH_VALUE raw override (with cch= prefix stripped)', () => {
    setEnv({ MANIFEST_CCH_VALUE: 'cch=abc12' });
    const plugin = new AnthropicBillingHeaderPlugin();
    const result = plugin.transformRequest(makeDecision());

    expect(result!.headers!['x-anthropic-billing-header']).toMatch(/; cch=abc12;$/);
  });

  it('honors MANIFEST_CCH_VALUE raw override (without prefix)', () => {
    setEnv({ MANIFEST_CCH_VALUE: 'fa690' });
    const plugin = new AnthropicBillingHeaderPlugin();
    const result = plugin.transformRequest(makeDecision());

    expect(result!.headers!['x-anthropic-billing-header']).toMatch(/; cch=fa690;$/);
  });

  it('defaults cch to 00000 when MANIFEST_CCH_VALUE is empty string', () => {
    setEnv({ MANIFEST_CCH_VALUE: '' });
    const plugin = new AnthropicBillingHeaderPlugin();
    const result = plugin.transformRequest(makeDecision());

    expect(result!.headers!['x-anthropic-billing-header']).toMatch(/; cch=00000;$/);
  });

  it('falls back to cch=00000 when there is no user message at all', () => {
    setEnv({ MANIFEST_CCH_VALUE: undefined });
    const plugin = new AnthropicBillingHeaderPlugin();
    const result = plugin.transformRequest(
      makeDecision({
        requestBody: { messages: [{ role: 'system', content: 'no user' }] },
      }),
    );

    expect(result!.headers!['x-anthropic-billing-header']).toMatch(/; cch=00000;$/);
  });

  it('falls back to cch=00000 when requestBody has no messages array', () => {
    setEnv({ MANIFEST_CCH_VALUE: undefined });
    const plugin = new AnthropicBillingHeaderPlugin();
    const result = plugin.transformRequest(makeDecision({ requestBody: {} }));

    expect(result!.headers!['x-anthropic-billing-header']).toMatch(/; cch=00000;$/);
  });

  it('reads first user text from array-form content with a text block', () => {
    setEnv({ MANIFEST_CCH_VALUE: 'deadb' });
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
    );

    expect(result!.headers!['x-anthropic-billing-header']).toContain('cc_version=2.1.117.');
    expect(result!.headers!['x-anthropic-billing-header']).toContain('cch=deadb');
  });

  it('accepts input_text as a valid content type in array-form user messages', () => {
    setEnv({ MANIFEST_CCH_VALUE: 'b1ade' });
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
    );

    expect(result!.headers!['x-anthropic-billing-header']).toContain('cch=b1ade');
  });

  it('skips non-text-leading parts in array-form content and finds a later text block', () => {
    setEnv({ MANIFEST_CCH_VALUE: 'feed1' });
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
    );

    expect(result!.headers!['x-anthropic-billing-header']).toContain('cch=feed1');
  });

  it('skips array-form content without a text block and continues to next message', () => {
    setEnv({ MANIFEST_CCH_VALUE: 'feed1' });
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
    );

    expect(result!.headers!['x-anthropic-billing-header']).toContain('cch=feed1');
  });

  it('skips non-object entries in the messages array', () => {
    setEnv({ MANIFEST_CCH_VALUE: 'cafe0' });
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
    );

    expect(result!.headers!['x-anthropic-billing-header']).toContain('cch=cafe0');
  });

  it('derives a stable suffix across requests with the same first-user-message chars', () => {
    setEnv({ MANIFEST_CC_VERSION: '2.1.117', MANIFEST_CCH_VALUE: undefined });
    const plugin = new AnthropicBillingHeaderPlugin();
    const a = plugin.transformRequest(makeDecision())!;
    const b = plugin.transformRequest(makeDecision())!;

    expect(a.headers!['x-anthropic-billing-header']).toBe(
      b.headers!['x-anthropic-billing-header'],
    );
  });

  it('derives different suffixes for different first-user-message lengths', () => {
    setEnv({ MANIFEST_CC_VERSION: '2.1.117', MANIFEST_CCH_VALUE: undefined });
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
    // SHA-256("59cf53e54c78" + message[4]+message[7]+message[20] + "2.1.117")[:3]
    // For message = "hello world":
    //   h(0) e(1) l(2) l(3) o(4) ' '(5) w(6) o(7) r(8) l(9) d(10)
    //   sampled = "o" + "o" + (message[20] -> '0' since string has 11 chars) = "oo0"
    const expectedSuffix = createHash('sha256')
      .update(`59cf53e54c78oo02.1.117`)
      .digest('hex')
      .slice(0, 3);
    setEnv({ MANIFEST_CC_VERSION: '2.1.117', MANIFEST_CCH_VALUE: '00000' });
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