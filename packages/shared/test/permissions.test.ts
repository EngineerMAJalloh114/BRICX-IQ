import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  assertCan,
  can,
  canAssignRole,
  ForbiddenError,
} from '../src';

describe('roles and permissions', () => {
  it('gives the owner every permission', () => {
    for (const p of PERMISSIONS) expect(can('owner', p)).toBe(true);
  });

  it('only lists known permissions', () => {
    for (const role of ROLES) {
      for (const p of ROLE_PERMISSIONS[role]) expect(PERMISSIONS).toContain(p);
    }
  });

  it('keeps field roles away from money approval and admin', () => {
    expect(can('worker', 'expenses.create')).toBe(true);
    expect(can('worker', 'expenses.approve')).toBe(false);
    expect(can('site_supervisor', 'budget.edit')).toBe(false);
    expect(can('viewer', 'projects.edit')).toBe(false);
    expect(can('admin', 'org.manage')).toBe(false);
  });

  it('throws a typed error when forbidden', () => {
    expect(() => assertCan('viewer', 'expenses.create')).toThrow(ForbiddenError);
    expect(() => assertCan('finance', 'exchange_rates.manage')).not.toThrow();
  });

  it('prevents privilege escalation to or from owner', () => {
    expect(canAssignRole('owner', 'owner')).toBe(true);
    expect(canAssignRole('admin', 'owner')).toBe(false);
    expect(canAssignRole('admin', 'viewer', 'owner')).toBe(false);
    expect(canAssignRole('admin', 'finance', 'worker')).toBe(true);
    expect(canAssignRole('project_manager', 'worker')).toBe(false);
  });
});
