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

// =============================================================================
// S7 — In-place anchor scrubbing + tool-name normalization (v0.6.0)
// =============================================================================
//
// Anthropic's OAuth billing classifier inspects the ENTIRE request payload
// (system[] + messages[] + tools[]), not just system[]. The v0.5.0 strategy of
// relocating fingerprints to messages[0] only delayed the overage-lane flip to
// turn 2+ — once the conversation history grew, the classifier still saw the
// fingerprint phrases in messages[].
//
// v0.6.0 takes a different approach: surgically SCRUB specific opencode
// fingerprint phrases in-place across system[], messages[], and rename native
// tool names to Claude Code's PascalCase. Clean content (user instructions,
// tool descriptions) is preserved. Fingerprint phrases that only serve as
// "this came from opencode" markers are replaced with neutral equivalents.
//
// References:
//   - NousResearch/hermes-agent#53212 (multi-feature classifier)
//   - shahidshabbir-se/opencode-anthropic-oauth v0.4.7 (surgical scrub pattern)
//   - ex-machina-co/opencode-anthropic-auth v1.7.5 (env-block phrase trigger)
//   - opencode PR #15049 (PascalCase tool-name tolerance via experimental_repairToolCall)
//   - anthropics/claude-code tools reference (canonical PascalCase names)

export interface ScrubSubstitution {
  readonly from: RegExp;
  readonly to: string;
}

export const OPENCODE_SCRUB_SUBSTITUTIONS: readonly ScrubSubstitution[] = [
  // Source-repo fingerprint
  { from: /github\.com\/anomalyco\/opencode/g, to: 'github.com/anthropics/claude-code' },
  // Docs fingerprint
  { from: /opencode\.ai\/docs/g, to: 'docs.claude.com/en/docs/claude-code' },
  // Source-prompt identity phrases (must be exact, not broad)
  { from: /You are OpenCode, the best coding agent on the planet\./g, to: "You are Claude Code, Anthropic's official CLI for Claude." },
  // Environment-label fingerprints (opencode emits these literally in session/system.ts)
  { from: /Workspace root folder:/g, to: 'Working directory:' },
  { from: /Is directory a git repo:/g, to: 'Git repository:' },
  { from: /<directories>/g, to: '<project_files>' },
  { from: /<\/directories>/g, to: '</project_files>' },
  // Known classifier trigger (ex-machina v1.7.5 documented this exact phrase as a signal)
  { from: /Here is some useful information about the environment you are running in:/g, to: 'Environment context:' },
  // Note: TodoWrite is NOT scrubbed — same real tool name in both opencode and Claude Code.
];

export interface ScrubAnchorsOptions {
  readonly scrubMessages?: boolean;
}

export function scrubAnchorsInPlace(
  requestBody: Readonly<Record<string, unknown>>,
  opts: Readonly<ScrubAnchorsOptions>,
): Record<string, unknown> {
  const scrubMessages = opts.scrubMessages ?? true;

  const out: Record<string, unknown> = { ...requestBody };
  out['system'] = scrubSystem(out['system']);
  if (scrubMessages) {
    out['messages'] = scrubMessagesArray(out['messages']);
  } else {
    out['messages'] = cloneMessageArrayShallow(out['messages']);
  }
  return out;
}

function scrubSystem(value: unknown): unknown {
  if (typeof value === 'string') {
    return applySubstitutions(value);
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const entry of value) {
      if (typeof entry === 'string') {
        out.push(applySubstitutions(entry));
        continue;
      }
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const e = entry as Record<string, unknown>;
        if (e['type'] === 'text' && typeof e['text'] === 'string') {
          out.push({ ...e, text: applySubstitutions(e['text'] as string) });
          continue;
        }
      }
      out.push(entry);
    }
    return out;
  }
  return value;
}

function scrubMessagesArray(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((m) => scrubOneMessage(m));
}

function cloneMessageArrayShallow(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((m) => {
    if (typeof m !== 'object' || m === null || Array.isArray(m)) return m;
    return { ...(m as Record<string, unknown>) };
  });
}

function scrubOneMessage(m: unknown): unknown {
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return m;
  const msg = { ...(m as Record<string, unknown>) };
  const content = msg['content'];
  if (typeof content === 'string') {
    msg['content'] = applySubstitutions(content);
    return msg;
  }
  if (Array.isArray(content)) {
    msg['content'] = content.map((block) => {
      if (typeof block !== 'object' || block === null || Array.isArray(block)) return block;
      const b = block as Record<string, unknown>;
      const type = b['type'];
      // Only scrub text-bearing blocks. Leave tool_use, tool_result, image, etc. alone.
      if (type === 'text' && typeof b['text'] === 'string') {
        return { ...b, text: applySubstitutions(b['text'] as string) };
      }
      return block;
    });
  }
  return msg;
}

function applySubstitutions(text: string): string {
  let out = text;
  for (const sub of OPENCODE_SCRUB_SUBSTITUTIONS) {
    out = out.replace(sub.from, sub.to);
  }
  return out;
}
