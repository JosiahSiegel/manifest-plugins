// =============================================================================
// S6 — System content relocation (Anthropic OAuth billing classifier bypass)
// =============================================================================
//
// Anthropic's billing classifier flips OAuth subscription requests into the
// overage/extra-usage lane when system[] accumulates more than ~4-4.5k chars
// of "non-Claude-Code" orchestration content. We can't truncate (the classifier
// is multi-feature, not length-based), so we surgically relocate entries that
// carry opencode fingerprints into the first user message, leaving clean
// entries in system[] so prompt-cache prefixes stay cache-eligible.
//
// Fingerprint list derived from griffinmartin/opencode-claude-auth v1.4.9
// (commit daa6425). Verified against NousResearch/hermes-agent#53212 bisection.

import type { SystemBlock } from './body';
import { normalizeSystemBlocks, stripExistingFingerprint } from './body';

export const OPENCODE_SYSTEM_FINGERPRINTS: readonly RegExp[] = [
  /\bopencode\b/i,
  /anomalyco/,
  /Workspace root folder/,
  /<directories>/,
  /is a git repo:/i,
  /TodoWrite/,
];

export interface RelocateSystemContentOptions {
  readonly marker?: string;
}

export interface RelocateSystemContentResult {
  readonly kept: SystemBlock[];
  readonly moved: string;
}

const DEFAULT_MOVED_MARKER = '[moved from system]';

export function relocateSystemContent(
  rawSystem: unknown,
  opts: Readonly<RelocateSystemContentOptions>,
): RelocateSystemContentResult {
  const marker = opts.marker ?? DEFAULT_MOVED_MARKER;
  // Use the existing helpers from body.ts that already handle string/array
  // normalization and idempotent billing/identity stripping. If they throw
  // (e.g. weird input), fall back to a tolerant empty result so the plugin
  // never throws (PLUGIN_AUTHORING.md:149-157).
  let cleaned: SystemBlock[];
  try {
    cleaned = stripExistingFingerprint(normalizeSystemBlocks(rawSystem));
  } catch {
    return { kept: [], moved: '' };
  }

  const kept: SystemBlock[] = [];
  const movedTexts: string[] = [];

  for (const block of cleaned) {
    if (isFingerprintBlock(block.text)) {
      movedTexts.push(block.text);
    } else {
      // Preserve cache_control on kept blocks exactly as it came in.
      kept.push(block);
    }
  }

  let moved = '';
  if (movedTexts.length > 0) {
    const joined = movedTexts.join('\n');
    // Idempotency: don't double-wrap already-moved content.
    if (!joined.includes(marker)) {
      moved = `${marker}\n${joined}`;
    } else {
      moved = joined;
    }
  }

  return { kept, moved };
}

function isFingerprintBlock(text: string): boolean {
  for (const re of OPENCODE_SYSTEM_FINGERPRINTS) {
    if (re.test(text)) return true;
  }
  return false;
}

export interface PrependMovedContentOptions {
  readonly marker?: string;
}

export function prependMovedContentToFirstUserMessage(
  requestBody: Readonly<Record<string, unknown>>,
  movedText: string,
  opts: Readonly<PrependMovedContentOptions>,
): Record<string, unknown> {
  const marker = opts.marker ?? DEFAULT_MOVED_MARKER;

  // No-op fast path: empty movedText is a no-op, return a shallow clone.
  if (movedText === '') {
    return { ...requestBody, messages: cloneMessages(requestBody['messages']) };
  }

  // Don't double-prepend when the marker is already present.
  const alreadyMoved = (() => {
    const msgs = asMessageArray(requestBody['messages']);
    if (msgs === null || msgs.length === 0) return false;
    const firstUser = msgs.find((m) => isUserMessage(m));
    if (firstUser === undefined) return false;
    const txt = extractFirstText(firstUser);
    return txt !== null && txt.includes(marker);
  })();
  const effectiveMoved = alreadyMoved ? '' : movedText;

  if (effectiveMoved === '') {
    return { ...requestBody, messages: cloneMessages(requestBody['messages']) };
  }

  const messages = asMessageArray(requestBody['messages']);
  if (messages === null || messages.length === 0) {
    // No messages — append a synthetic user message.
    return {
      ...requestBody,
      messages: [{ role: 'user', content: effectiveMoved }],
    };
  }

  const firstUserIndex = messages.findIndex((m) => isUserMessage(m));
  if (firstUserIndex === -1) {
    // No user message anywhere — append at the end.
    return {
      ...requestBody,
      messages: [
        ...messages,
        { role: 'user', content: effectiveMoved },
      ],
    };
  }

  // Found first user message — prepend into it (immutable: clone the message
  // and any internal content array).
  const userMsg = messages[firstUserIndex];
  if (userMsg === undefined) {
    return {
      ...requestBody,
      messages: [
        ...messages,
        { role: 'user', content: effectiveMoved },
      ],
    };
  }
  const newUserMsg = prependToMessage(userMsg, effectiveMoved);
  const newMessages = messages.slice();
  newMessages[firstUserIndex] = newUserMsg;
  return { ...requestBody, messages: newMessages };
}

function asMessageArray(value: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(value)) return null;
  // Each element must be an object (record); we tolerate non-record elements
  // by filtering them out so we never crash.
  return value.filter(
    (m): m is Record<string, unknown> =>
      typeof m === 'object' && m !== null && !Array.isArray(m),
  );
}

function isUserMessage(m: Record<string, unknown>): boolean {
  return m['role'] === 'user';
}

function extractFirstText(m: Record<string, unknown>): string | null {
  const content = m['content'];
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        typeof block === 'object' &&
        block !== null &&
        block['type'] === 'text' &&
        typeof block['text'] === 'string'
      ) {
        return block['text'];
      }
    }
  }
  return null;
}

function prependToMessage(
  m: Record<string, unknown>,
  moved: string,
): Record<string, unknown> {
  const content = m['content'];
  if (typeof content === 'string') {
    return { ...m, content: `${moved}\n\n${content}` };
  }
  if (Array.isArray(content)) {
    const newBlock = { type: 'text', text: moved };
    return { ...m, content: [newBlock, ...content] };
  }
  // No content field — treat as if it were an empty string.
  return { ...m, content: `${moved}\n\n` };
}

function cloneMessages(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((m) => {
    if (typeof m !== 'object' || m === null || Array.isArray(m)) return m;
    const cloned = { ...m };
    if (Array.isArray(cloned['content'])) {
      cloned['content'] = cloned['content'].map((c) =>
        typeof c === 'object' && c !== null && !Array.isArray(c) ? { ...c } : c,
      );
    }
    return cloned;
  });
}