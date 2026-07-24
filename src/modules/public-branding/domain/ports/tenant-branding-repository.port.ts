import { TenantBranding } from '../entities/tenant-branding.entity';

export const TENANT_BRANDING_REPOSITORY = Symbol('TENANT_BRANDING_REPOSITORY');

export interface TenantBrandingRepository {
  /**
   * Reads the public branding fields of a single tenant by id (non-deleted).
   * `tenants` carries no RLS policy (only per-tenant domain tables like
   * `clinic_memberships`/`patients` do), so this is a direct, explicitly
   * `tenantId`-scoped read via the app's regular Prisma connection — same as
   * `TenantResolverService` — not `runWithTenant`/RLS. Returns `null` when
   * the tenant doesn't exist or is soft-deleted.
   */
  findById(tenantId: string): Promise<TenantBranding | null>;
}
