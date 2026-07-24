/**
 * Public white-label branding of a tenant, as consumed by the unauthenticated
 * marketing/login shell (web app's `fetchBranding`). Deliberately NOT the raw
 * Prisma `Tenant` model — only the fields that are safe to expose with no
 * auth at all. Repositories must `mapToEntity` before returning across the
 * port boundary (same convention as Patient/StaffMember).
 */
export interface TenantBranding {
  name: string;
  primaryColor: string;
  logoUrl: string | null;
}
