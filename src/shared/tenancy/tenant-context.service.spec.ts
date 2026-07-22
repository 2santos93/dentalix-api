import { TenantContextService } from './tenant-context.service';

describe('TenantContextService', () => {
  const svc = new TenantContextService();

  it('returns undefined outside a context', () => {
    expect(svc.getTenantId()).toBeUndefined();
  });

  it('exposes the tenant id inside run()', () => {
    const seen = svc.run('tenant-123', () => svc.getTenantId());
    expect(seen).toBe('tenant-123');
  });

  it('isolates nested contexts', () => {
    const outer = svc.run('a', () => {
      const inner = svc.run('b', () => svc.getTenantId());
      return { inner, outer: svc.getTenantId() };
    });
    expect(outer).toEqual({ inner: 'b', outer: 'a' });
  });
});
