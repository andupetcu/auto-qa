/**
 * @fileoverview Strict worker-side validation for immutable visual-capture and
 * readiness-policy snapshots passed by the Auto QA control plane.
 */
export type CaptureMode = 'off' | 'on' | 'retain-on-failure';
export type RequestResourceType = 'fetch' | 'xhr' | 'document' | 'script' | 'stylesheet' | 'image' | 'font' | 'media' | 'other';

export interface RequestRule {
  urlGlob: string;
  methods: string[];
  resourceTypes: RequestResourceType[];
}

export interface ReadinessPolicy {
  version: 1;
  enabled: boolean;
  timeoutMs: number;
  pollIntervalMs: number;
  captureIntervalMs: number;
  stabilityWindowMs: number;
  visualDiffRatio: number;
  readySelectors: string[];
  loadingSelectors: string[];
  criticalRequests: RequestRule[];
  ignoredRequests: RequestRule[];
  failOnPageError: boolean;
  failOnConsoleError: boolean;
  failOnCriticalRequest: boolean;
}

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
  readiness: ReadinessPolicy;
}

export const MANDATORY_MASK_SELECTORS = [
  "input[type='password']",
  "input[autocomplete='current-password']",
  "[data-sensitive='true']",
] as const;

export const DEFAULT_READINESS_POLICY: ReadinessPolicy = {
  version: 1,
  enabled: true,
  timeoutMs: 20_000,
  pollIntervalMs: 250,
  captureIntervalMs: 1_000,
  stabilityWindowMs: 1_000,
  visualDiffRatio: 0.005,
  readySelectors: [],
  loadingSelectors: [],
  criticalRequests: [{ urlGlob: '*', methods: [], resourceTypes: ['fetch', 'xhr'] }],
  ignoredRequests: [],
  failOnPageError: true,
  failOnConsoleError: true,
  failOnCriticalRequest: true,
};

export const DEFAULT_CAPTURE_POLICY: CapturePolicy = {
  version: 1,
  finalScreenshot: { enabled: true, fullPage: true, format: 'png' },
  loadingSequence: {
    enabled: true,
    maxFrames: 12,
    milestones: ['navigation', 'domcontentloaded', 'asserted'],
    delaysMs: [250, 750, 1500, 3000, 6000, 10_000],
  },
  contactSheet: { enabled: true, format: 'webp', quality: 80 },
  trace: 'on',
  video: 'retain-on-failure',
  har: 'reduced',
  retainIntermediateFrames: false,
  maskSelectors: [...MANDATORY_MASK_SELECTORS],
  readiness: structuredClone(DEFAULT_READINESS_POLICY),
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
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

function finiteNumber(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be a number between ${min} and ${max}`);
  }
  return value;
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
  if (values.some((item, index) => index > 0 && item <= values[index - 1])) throw new Error(`${label} must be ascending`);
  return values;
}

function selectorArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 50 || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} must be a string array with at most 50 items`);
  }
  const selectors = (value as string[]).map((selector) => selector.trim());
  if (selectors.some((selector) => selector.length === 0 || selector.length > 500)) {
    throw new Error(`${label} must contain non-empty selectors up to 500 characters`);
  }
  return uniqueValues(selectors, label);
}

function maskSelectors(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 50 || value.some((item) => typeof item !== 'string')) {
    throw new Error('maskSelectors must be a string array with at most 50 items');
  }
  const selectors = (value as string[]).map((selector) => selector.trim());
  if (selectors.some((selector) => selector.length === 0 || selector.length > 500)) {
    throw new Error('maskSelectors must contain non-empty selectors up to 500 characters');
  }
  return [...new Set([...MANDATORY_MASK_SELECTORS, ...selectors])];
}

const RESOURCE_TYPES = ['fetch', 'xhr', 'document', 'script', 'stylesheet', 'image', 'font', 'media', 'other'] as const;

function requestRules(value: unknown, label: string): RequestRule[] {
  if (!Array.isArray(value) || value.length > 50) throw new Error(`${label} must contain at most 50 rules`);
  return value.map((raw, index) => {
    const rule = object(raw, `${label}[${index}]`);
    exactKeys(rule, ['urlGlob', 'methods', 'resourceTypes'], `${label}[${index}]`);
    if (typeof rule.urlGlob !== 'string' || !rule.urlGlob.trim() || rule.urlGlob.length > 500 || /[\u0000-\u001f]/.test(rule.urlGlob)) {
      throw new Error(`${label}[${index}].urlGlob must be a non-empty safe glob up to 500 characters`);
    }
    if (!Array.isArray(rule.methods) || rule.methods.length > 20 || rule.methods.some((method) => typeof method !== 'string' || !/^[A-Z]+$/.test(method))) {
      throw new Error(`${label}[${index}].methods must contain uppercase HTTP methods`);
    }
    if (!Array.isArray(rule.resourceTypes) || rule.resourceTypes.length > RESOURCE_TYPES.length) {
      throw new Error(`${label}[${index}].resourceTypes must be an array`);
    }
    return {
      urlGlob: rule.urlGlob.trim(),
      methods: uniqueValues(rule.methods as string[], `${label}[${index}].methods`),
      resourceTypes: uniqueValues(
        rule.resourceTypes.map((item) => enumValue(item, RESOURCE_TYPES, `${label}[${index}].resourceTypes`)),
        `${label}[${index}].resourceTypes`,
      ),
    };
  });
}

function parseReadiness(raw: unknown): ReadinessPolicy {
  const value = object(raw, 'readiness');
  exactKeys(value, [
    'version', 'enabled', 'timeoutMs', 'pollIntervalMs', 'captureIntervalMs',
    'stabilityWindowMs', 'visualDiffRatio', 'readySelectors', 'loadingSelectors',
    'criticalRequests', 'ignoredRequests', 'failOnPageError', 'failOnConsoleError',
    'failOnCriticalRequest',
  ], 'readiness');
  if (value.version !== 1) throw new Error('unsupported readiness policy version');
  return {
    version: 1,
    enabled: boolean(value.enabled, 'readiness.enabled'),
    timeoutMs: finiteInteger(value.timeoutMs, 'readiness.timeoutMs', 1_000, 120_000),
    pollIntervalMs: finiteInteger(value.pollIntervalMs, 'readiness.pollIntervalMs', 50, 5_000),
    captureIntervalMs: finiteInteger(value.captureIntervalMs, 'readiness.captureIntervalMs', 100, 30_000),
    stabilityWindowMs: finiteInteger(value.stabilityWindowMs, 'readiness.stabilityWindowMs', 0, 10_000),
    visualDiffRatio: finiteNumber(value.visualDiffRatio, 'readiness.visualDiffRatio', 0, 0.2),
    readySelectors: selectorArray(value.readySelectors, 'readiness.readySelectors'),
    loadingSelectors: selectorArray(value.loadingSelectors, 'readiness.loadingSelectors'),
    criticalRequests: requestRules(value.criticalRequests, 'readiness.criticalRequests'),
    ignoredRequests: requestRules(value.ignoredRequests, 'readiness.ignoredRequests'),
    failOnPageError: boolean(value.failOnPageError, 'readiness.failOnPageError'),
    failOnConsoleError: boolean(value.failOnConsoleError, 'readiness.failOnConsoleError'),
    failOnCriticalRequest: boolean(value.failOnCriticalRequest, 'readiness.failOnCriticalRequest'),
  };
}

export function parseCapturePolicy(raw: string | undefined): CapturePolicy {
  if (!raw) return structuredClone(DEFAULT_CAPTURE_POLICY);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('QA_RUN_CAPTURE_POLICY must be valid JSON'); }

  const root = object(parsed, 'QA_RUN_CAPTURE_POLICY');
  exactKeys(root, [
    'version', 'finalScreenshot', 'loadingSequence', 'contactSheet', 'trace', 'video',
    'har', 'retainIntermediateFrames', 'maskSelectors', 'readiness',
  ], 'QA_RUN_CAPTURE_POLICY');
  if (root.version !== 1) throw new Error('unsupported capture policy version');
  const finalScreenshot = object(root.finalScreenshot, 'finalScreenshot');
  const loadingSequence = object(root.loadingSequence, 'loadingSequence');
  const contactSheet = object(root.contactSheet, 'contactSheet');
  exactKeys(finalScreenshot, ['enabled', 'fullPage', 'format'], 'finalScreenshot');
  exactKeys(loadingSequence, ['enabled', 'maxFrames', 'milestones', 'delaysMs'], 'loadingSequence');
  exactKeys(contactSheet, ['enabled', 'format', 'quality'], 'contactSheet');

  const milestones = uniqueValues((() => {
    if (!Array.isArray(loadingSequence.milestones) || loadingSequence.milestones.length > 3) {
      throw new Error('loadingSequence.milestones must contain at most 3 items');
    }
    return loadingSequence.milestones.map((value) => enumValue(value, ['navigation', 'domcontentloaded', 'asserted'] as const, 'milestone'));
  })(), 'loadingSequence.milestones');

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
    readiness: parseReadiness(root.readiness ?? DEFAULT_READINESS_POLICY),
  };
}
