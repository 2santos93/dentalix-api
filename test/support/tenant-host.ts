// Maps a tenant subdomain to the host used in tests. `localhost` is a configured
// base domain (.env.test TENANT_BASE_DOMAINS), so `<sub>.localhost` resolves to
// the tenant with that subdomain via TenantHostMiddleware.
export function hostFor(subdomain: string): string {
  return `${subdomain}.localhost`;
}
