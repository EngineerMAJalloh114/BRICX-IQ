/**
 * Roles are assigned per organisation membership. Permissions are the only
 * thing code should check; roles are just named bundles of permissions.
 */

export const PERMISSIONS = [
  'org.manage',
  'members.view',
  'members.manage',
  'projects.view',
  'projects.create',
  'projects.edit',
  'projects.delete',
  'budget.view',
  'budget.edit',
  'expenses.view',
  'expenses.create',
  'expenses.approve',
  'exchange_rates.manage',
  'field.report',
  'audit.view',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = [
  'owner',
  'admin',
  'project_manager',
  'finance',
  'site_supervisor',
  'worker',
  'viewer',
] as const;

export type Role = (typeof ROLES)[number];

const ALL: readonly Permission[] = PERMISSIONS;

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  owner: ALL,
  admin: ALL.filter((p) => p !== 'org.manage'),
  project_manager: [
    'members.view',
    'projects.view',
    'projects.create',
    'projects.edit',
    'budget.view',
    'budget.edit',
    'expenses.view',
    'expenses.create',
    'expenses.approve',
    'field.report',
  ],
  finance: [
    'members.view',
    'projects.view',
    'budget.view',
    'budget.edit',
    'expenses.view',
    'expenses.create',
    'expenses.approve',
    'exchange_rates.manage',
    'audit.view',
  ],
  site_supervisor: [
    'members.view',
    'projects.view',
    'budget.view',
    'expenses.view',
    'expenses.create',
    'field.report',
  ],
  worker: ['projects.view', 'expenses.create', 'field.report'],
  viewer: ['projects.view', 'budget.view', 'expenses.view'],
};

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function permissionsFor(role: Role): ReadonlySet<Permission> {
  return new Set(ROLE_PERMISSIONS[role]);
}

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export class ForbiddenError extends Error {
  constructor(
    readonly role: Role,
    readonly permission: Permission,
  ) {
    super(`Role "${role}" lacks permission "${permission}"`);
    this.name = 'ForbiddenError';
  }
}

export function assertCan(role: Role, permission: Permission): void {
  if (!can(role, permission)) throw new ForbiddenError(role, permission);
}

/**
 * Only an owner can grant the owner role or change an existing owner's role;
 * admins can manage every other role. Stops privilege escalation through the
 * members screen.
 */
export function canAssignRole(actor: Role, newRole: Role, currentRole?: Role): boolean {
  if (!can(actor, 'members.manage')) return false;
  if (newRole === 'owner' || currentRole === 'owner') return actor === 'owner';
  return true;
}
