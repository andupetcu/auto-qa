/**
 * @fileoverview Strict worker-side validation for immutable visual-capture policy snapshots.
 */
export type CaptureMode = 'off' | 'on' | 'retain-on-failure';

export interface CapturePolicy {
  version: 1;
  finalScreenshot: { enabled: boolean; fullPage: boolean; format: 'png' | 'jpeg' };
  loadingSequence: {
    enabled: boolean;
    maxFrames: number;
    milestones: Array<'navigation' | 'domcontentloaded' | 'asserted'>;
    delaysMs: number[];
  };
  contactSheet: { enabled: boolean; format: 'webp'; quality: number };
  trace: CaptureMode;
  video: CaptureMode;
  har: 'off' | 'reduced';
  retainIntermediateFrames: boolean;
  maskSelectors: string[];
}

export const MANDATORY_MASK_SELECTORS = [
  "input[type='password']",
  "input[autocomplete='current-password']",
  "[data-sensitive='true']",
] as const;

export const DEFAULT_CAPTURE_POLICY: CapturePolicy = {
  version: 1,
  finalScreenshot: { enabled: true, fullPage: true, format: 'png' },
  loadingSequence: {
    enabled: true,
    maxFrames: 6,
    milestones: ['navigation', 'domcontentloaded', 'asserted'],
    delaysMs: [250, 750, 1500],
  },
  contactSheet: { enabled: true, format: 'webp', quality: 80 },
  trace: 'on',
  video: 'retain-on-failure',
  har: 'reduced',
  retainIntermediateFrames: false,
  maskSelectors: [...MANDATORY_MASK_SELECTORS],
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown field ${unknown[0]}`);
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function finiteInteger(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return Number(value);
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${label} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function uniqueValues<T>(values: T[], label: string): T[] {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique`);
  return values;
}

function numberArray(value: unknown, label: string, max: number): number[] {
  if (!Array.isArray(value) || value.length > max || value.some((item) => !Number.isInteger(item) || item < 0)) {
    throw new Error(`${label} must be a non-negative integer array with at most ${max} items`);
  }
  const values = uniqueValues(value as number[], label);
  if (values.some((item, index) => index > 0 && item <= values[index - 1])) {
    throw new Error(`${label} must be ascending`);
  }
  return values;
}

function maskSelectors(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 50 || value.some((item) => typeof item !== 'string')) {
    throw new Error('maskSelectors must be a string array with at most 50 items');
  }
  const custom = (value as string[]).map((selector) => selector.trim());
  if (custom.some((selector) => selector.length === 0 || selector.length > 500)) {
    throw new Error('maskSelectors must contain non-empty selectors up to 500 characters');
  }
  return [...new Set([...MANDATORY_MASK_SELECTORS, ...custom])];
}

export function parseCapturePolicy(raw: string | undefined): CapturePolicy {
  if (!raw) return structuredClone(DEFAULT_CAPTURE_POLICY);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('QA_RUN_CAPTURE_POLICY must be valid JSON');
  }

  const root = object(parsed, 'QA_RUN_CAPTURE_POLICY');
  exactKeys(root, [
    'version', 'finalScreenshot', 'loadingSequence', 'contactSheet', 'trace', 'video',
    'har', 'retainIntermediateFrames', 'maskSelectors',
  ], 'QA_RUN_CAPTURE_POLICY');
  if (root.version !== 1) throw new Error('unsupported capture policy version');
  const finalScreenshot = object(root.finalScreenshot, 'finalScreenshot');
  const loadingSequence = object(root.loadingSequence, 'loadingSequence');
  const contactSheet = object(root.contactSheet, 'contactSheet');
  exactKeys(finalScreenshot, ['enabled', 'fullPage', 'format'], 'finalScreenshot');
  exactKeys(loadingSequence, ['enabled', 'maxFrames', 'milestones', 'delaysMs'], 'loadingSequence');
  exactKeys(contactSheet, ['enabled', 'format', 'quality'], 'contactSheet');

  const milestones = uniqueValues(
    (() => {
      if (!Array.isArray(loadingSequence.milestones) || loadingSequence.milestones.length > 3) {
        throw new Error('loadingSequence.milestones must contain at most 3 items');
      }
      return loadingSequence.milestones.map((value) =>
        enumValue(value, ['navigation', 'domcontentloaded', 'asserted'] as const, 'milestone'));
    })(),
    'loadingSequence.milestones',
  );

  return {
    version: 1,
    finalScreenshot: {
      enabled: boolean(finalScreenshot.enabled, 'finalScreenshot.enabled'),
      fullPage: boolean(finalScreenshot.fullPage, 'finalScreenshot.fullPage'),
      format: enumValue(finalScreenshot.format, ['png', 'jpeg'] as const, 'finalScreenshot.format'),
    },
    loadingSequence: {
      enabled: boolean(loadingSequence.enabled, 'loadingSequence.enabled'),
      maxFrames: finiteInteger(loadingSequence.maxFrames, 'loadingSequence.maxFrames', 1, 12),
      milestones,
      delaysMs: numberArray(loadingSequence.delaysMs, 'loadingSequence.delaysMs', 6),
    },
    contactSheet: {
      enabled: boolean(contactSheet.enabled, 'contactSheet.enabled'),
      format: enumValue(contactSheet.format, ['webp'] as const, 'contactSheet.format'),
      quality: finiteInteger(contactSheet.quality, 'contactSheet.quality', 40, 95),
    },
    trace: enumValue(root.trace, ['off', 'on', 'retain-on-failure'] as const, 'trace'),
    video: enumValue(root.video, ['off', 'on', 'retain-on-failure'] as const, 'video'),
    har: enumValue(root.har, ['off', 'reduced'] as const, 'har'),
    retainIntermediateFrames: boolean(root.retainIntermediateFrames, 'retainIntermediateFrames'),
    maskSelectors: maskSelectors(root.maskSelectors),
  };
}
