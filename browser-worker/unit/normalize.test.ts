import { describe, expect, test } from 'vitest';
import { normalize, signatureInput } from '../src/postprocess/normalize';

describe('normalize', () => {
  test('replaces uuids, epoch timestamps and numbers', () => {
    expect(normalize('id 6a27f8b2-9619-ed3e-5613-8cd800000000 at 1755172800123 count 42'))
      .toBe('id <uuid> at <ts> count <n>');
  });

  test('collapses whitespace and trims', () => {
    expect(normalize('  a   b\n c ')).toBe('a b c');
  });
});

describe('signatureInput', () => {
  test('builds normalized signature fields from a failure', () => {
    const sig = signatureInput({
      error: 'Timed out 5000ms waiting for locator',
      topFrame: 'src/components/X.tsx:64:18',
      route: '/campaigns/:id/edit',
      role: 'user',
    });
    expect(sig).toEqual({
      normalized_error: 'Timed out <n>ms waiting for locator',
      top_stack_frame: 'src/components/X.tsx:64:18',
      route: '/campaigns/:id/edit',
      role: 'user',
    });
  });
});
