/**
 * @fileoverview Adversarial parity tests for immutable worker capture-policy snapshots.
 */
import { describe, expect, test } from 'vitest';

import {
  DEFAULT_CAPTURE_POLICY,
  MANDATORY_MASK_SELECTORS,
  parseCapturePolicy,
} from '../src/visual/policy';

function raw(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...structuredClone(DEFAULT_CAPTURE_POLICY), ...overrides });
}

describe('capture policy boundary', () => {
  test('returns independent default snapshots', () => {
    const first = parseCapturePolicy(undefined);
    first.maskSelectors.push('.mutated');
    expect(parseCapturePolicy(undefined).maskSelectors).not.toContain('.mutated');
  });

  test('preserves mandatory masks while trimming and deduplicating custom selectors', () => {
    const policy = parseCapturePolicy(raw({
      maskSelectors: ['  [data-project-secret]  ', '[data-project-secret]', "input[type='password']"],
    }));
    expect(policy.maskSelectors).toEqual([...MANDATORY_MASK_SELECTORS, '[data-project-secret]']);
  });

  test.each(['', '   ', 'x'.repeat(501)])('rejects invalid selector %j', (selector) => {
    expect(() => parseCapturePolicy(raw({ maskSelectors: [selector] }))).toThrow(/maskSelectors/);
  });

  test('rejects unknown root and nested fields', () => {
    expect(() => parseCapturePolicy(raw({ surprise: true }))).toThrow(/unknown field/);
    const nested = structuredClone(DEFAULT_CAPTURE_POLICY) as typeof DEFAULT_CAPTURE_POLICY & {
      finalScreenshot: typeof DEFAULT_CAPTURE_POLICY.finalScreenshot & { surprise?: boolean };
    };
    nested.finalScreenshot.surprise = true;
    expect(() => parseCapturePolicy(JSON.stringify(nested))).toThrow(/unknown field/);
  });

  test('rejects duplicate milestones and non-ascending delays', () => {
    const duplicate = structuredClone(DEFAULT_CAPTURE_POLICY);
    duplicate.loadingSequence.milestones = ['navigation', 'navigation'];
    expect(() => parseCapturePolicy(JSON.stringify(duplicate))).toThrow(/unique/);
    const descending = structuredClone(DEFAULT_CAPTURE_POLICY);
    descending.loadingSequence.delaysMs = [750, 250];
    expect(() => parseCapturePolicy(JSON.stringify(descending))).toThrow(/ascending/);
    const duplicateDelay = structuredClone(DEFAULT_CAPTURE_POLICY);
    duplicateDelay.loadingSequence.delaysMs = [250, 250];
    expect(() => parseCapturePolicy(JSON.stringify(duplicateDelay))).toThrow(/unique/);
  });

  test.each([
    [1, true], [12, true], [0, false], [13, false],
  ])('enforces maxFrames boundary %i', (maxFrames, accepted) => {
    const policy = structuredClone(DEFAULT_CAPTURE_POLICY);
    policy.loadingSequence.maxFrames = maxFrames;
    const action = () => parseCapturePolicy(JSON.stringify(policy));
    if (accepted) expect(action).not.toThrow(); else expect(action).toThrow(/maxFrames/);
  });

  test.each([
    [40, true], [95, true], [39, false], [96, false],
  ])('enforces contact-sheet quality boundary %i', (quality, accepted) => {
    const policy = structuredClone(DEFAULT_CAPTURE_POLICY);
    policy.contactSheet.quality = quality;
    const action = () => parseCapturePolicy(JSON.stringify(policy));
    if (accepted) expect(action).not.toThrow(); else expect(action).toThrow(/quality/);
  });

  test('normalizes bounded readiness and request rules', () => {
    const policy = parseCapturePolicy(raw({
      readiness: {
        ...structuredClone(DEFAULT_CAPTURE_POLICY.readiness),
        timeoutMs: 12_000,
        readySelectors: ['main'],
        loadingSelectors: ['[aria-busy="true"]'],
        criticalRequests: [{ urlGlob: '*/api/*', methods: ['GET'], resourceTypes: ['fetch'] }],
        ignoredRequests: [{ urlGlob: '*/events', methods: [], resourceTypes: ['fetch'] }],
      },
    }));
    expect(policy.readiness.timeoutMs).toBe(12_000);
    expect(policy.readiness.criticalRequests[0]).toEqual({
      urlGlob: '*/api/*', methods: ['GET'], resourceTypes: ['fetch'],
    });
  });

  test('rejects unsafe readiness bounds, duplicate selectors, and malformed methods', () => {
    const timeout = structuredClone(DEFAULT_CAPTURE_POLICY);
    timeout.readiness.timeoutMs = 999;
    expect(() => parseCapturePolicy(JSON.stringify(timeout))).toThrow(/timeoutMs/);
    const duplicate = structuredClone(DEFAULT_CAPTURE_POLICY);
    duplicate.readiness.loadingSelectors = ['.loading', '.loading'];
    expect(() => parseCapturePolicy(JSON.stringify(duplicate))).toThrow(/unique/);
    const malformed = structuredClone(DEFAULT_CAPTURE_POLICY);
    malformed.readiness.criticalRequests = [{
      urlGlob: '*', methods: ['get'], resourceTypes: ['fetch'],
    }];
    expect(() => parseCapturePolicy(JSON.stringify(malformed))).toThrow(/uppercase/);
  });

  test('rejects malformed JSON, unsupported versions, and wrong types', () => {
    expect(() => parseCapturePolicy('{')).toThrow(/valid JSON/);
    expect(() => parseCapturePolicy(raw({ version: 2 }))).toThrow(/unsupported/);
    expect(() => parseCapturePolicy(raw({ retainIntermediateFrames: 'yes' }))).toThrow(/boolean/);
  });
});
