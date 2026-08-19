/** @fileoverview Unit contracts for immutable project, selector, matrix, and role filtering. */
import { describe, expect, test } from 'vitest';
import {
  resolveMatrix,
  resolveRoles,
  resolveSelectors,
  roleProjectGrep,
  sessionStatePath,
} from '../tests/projectConfig';

describe('resolveSelectors', () => {
  test('falls back to probed defaults with no env', () => {
    const s = resolveSelectors({});
    expect(s.loginEmail).toBe('input[name=username]');
    expect(s.gateText).toBe('Log in to continue');
  });

  test('QA_SEL_* env overrides defaults', () => {
    const s = resolveSelectors({ QA_SEL_APP_SHELL: '#app' });
    expect(s.appShell).toBe('#app');
  });

  test('QA_RUN_SELECTORS json wins over everything', () => {
    const s = resolveSelectors({
      QA_SEL_APP_SHELL: '#app',
      QA_RUN_SELECTORS: JSON.stringify({ appShell: '#root', gateText: 'Please sign in' }),
    });
    expect(s.appShell).toBe('#root');
    expect(s.gateText).toBe('Please sign in');
    expect(s.loginEmail).toBe('input[name=username]'); // unspecified keys keep defaults
  });

  test('malformed QA_RUN_SELECTORS is ignored, not fatal', () => {
    const s = resolveSelectors({ QA_RUN_SELECTORS: '{nope' });
    expect(s.loginEmail).toBe('input[name=username]');
  });
});

describe('resolveRoles', () => {
  test('defaults come from QA_ROLES with QA_CRED_<ROLE> refs', () => {
    const roles = resolveRoles({ QA_ROLES: 'user,anon' });
    expect(roles).toEqual([
      { name: 'user', credential_ref: 'QA_CRED_USER' },
      { name: 'anon' },
    ]);
  });

  test('QA_RUN_ROLES_CONFIG json wins', () => {
    const roles = resolveRoles({
      QA_ROLES: 'user,anon',
      QA_RUN_ROLES_CONFIG: JSON.stringify([
        { name: 'admin', credential_ref: 'QA_CRED_STUDIO_ADMIN' },
        { name: 'anon' },
      ]),
    });
    expect(roles[0]).toEqual({ name: 'admin', credential_ref: 'QA_CRED_STUDIO_ADMIN' });
  });
});

describe('resolveMatrix', () => {
  test('QA_RUN_ROLE_MATRIX wins over the yaml loader', () => {
    const m = resolveMatrix(
      { QA_RUN_ROLE_MATRIX: JSON.stringify({ '/': { user: 'render' } }) },
      () => ({ '/': { user: 'redirect' } }),
    );
    expect(m['/'].user).toBe('render');
  });

  test('empty or missing env falls back to the yaml loader', () => {
    const yaml = { '/x': { anon: 'redirect' } };
    expect(resolveMatrix({}, () => yaml)).toEqual(yaml);
    expect(resolveMatrix({ QA_RUN_ROLE_MATRIX: '{}' }, () => yaml)).toEqual(yaml);
  });
});

describe('parseListEnv', () => {
  test('parses a JSON array, treats empty/missing/malformed as "no filter"', async () => {
    const { parseListEnv } = await import('../tests/projectConfig');
    expect(parseListEnv('["ALL"]')).toEqual(['ALL']);
    expect(parseListEnv('["user","anon"]')).toEqual(['user', 'anon']);
    expect(parseListEnv('[]')).toBeNull();   // empty list must NOT mean "exclude everything"
    expect(parseListEnv(undefined)).toBeNull();
    expect(parseListEnv('{nope')).toBeNull();
  });
});

describe('roleProjectGrep', () => {
  test('keeps non-matrix tests and only the applicable role matrix cases', () => {
    const user = roleProjectGrep('user');
    expect(user.test('user › smoke.spec.ts › loads dashboard')).toBe(true);
    expect(user.test('user › matrix.spec.ts › matrix / as user -> render')).toBe(true);
    expect(user.test('user › matrix.spec.ts › matrix / as anon -> redirect')).toBe(false);
  });

  test('escapes dynamic role names before building the project filter', () => {
    const role = roleProjectGrep('studio.admin');
    expect(role.test('studio.admin › matrix /x as studio.admin -> render')).toBe(true);
    expect(role.test('studio.admin › matrix /x as studioXadmin -> render')).toBe(false);
  });
});

describe('sessionStatePath', () => {
  test('namespaces storageState by project, default project', () => {
    expect(sessionStatePath({}, 'user')).toBe('.auth/default/user.json');
    expect(sessionStatePath({ QA_RUN_PROJECT: 'studio' }, 'admin'))
      .toBe('.auth/studio/admin.json');
  });
});
