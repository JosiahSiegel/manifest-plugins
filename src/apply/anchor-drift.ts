export type AnchorMarker = {
  readonly name: string;
  readonly marker: string;
};

export type AnchorDriftReport = {
  readonly ok: boolean;
  readonly missing: readonly string[];
};

export function assertAnchors(
  content: string,
  anchors: readonly AnchorMarker[],
): AnchorDriftReport {
  const missing: string[] = [];
  for (const anchor of anchors) {
    if (!content.includes(anchor.marker)) {
      missing.push(anchor.name);
    }
  }
  return { ok: missing.length === 0, missing };
}