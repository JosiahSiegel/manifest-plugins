import { assertAnchors } from './anchor-drift';

describe('assertAnchors', () => {
  it('reports ok when every anchor marker is present', () => {
    const report = assertAnchors('function applyRequestTransformPlugins(', [
      { name: 'plugin-host-helper', marker: 'function applyRequestTransformPlugins(' },
    ]);
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
  });

  it('returns the names of the missing markers', () => {
    const report = assertAnchors('// upstream restructured', [
      { name: 'helper-marker', marker: 'function applyRequestTransformPlugins(' },
      { name: 'old-text', marker: 'const CONCURRENCY_MAX = 10;' },
    ]);
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual(['helper-marker', 'old-text']);
  });

  it('treats an empty anchor list as trivially ok', () => {
    const report = assertAnchors('arbitrary content', []);
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
  });

  it('returns an empty missing array when the input is empty and no anchors are required', () => {
    const report = assertAnchors('', []);
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
  });

  it('flags every anchor as missing when content is empty and anchors are required', () => {
    const report = assertAnchors('', [
      { name: 'first', marker: 'function applyRequestTransformPlugins(' },
      { name: 'second', marker: 'function getResolvedConcurrencyMax(' },
    ]);
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual(['first', 'second']);
  });
});