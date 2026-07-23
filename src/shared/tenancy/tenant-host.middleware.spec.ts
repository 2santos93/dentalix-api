import { ConfigService } from '@nestjs/config';
import { TenantHostMiddleware } from './tenant-host.middleware';
import { TenantResolverService } from './tenant-resolver.service';
import { TenantHostRequest } from './tenant-host-request';

describe('TenantHostMiddleware', () => {
  it('resolves the host and annotates req.tenantHost with the tenant id', async () => {
    const mockResolver = {
      resolve: jest.fn().mockResolvedValue('t-1'),
    } as unknown as TenantResolverService;

    const mockConfig = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;

    const middleware = new TenantHostMiddleware(mockResolver, mockConfig);
    const req = {
      headers: { host: 'acme.localhost' },
    } as unknown as TenantHostRequest;
    const next = jest.fn();

    await middleware.use(req, undefined, next);

    expect(mockResolver.resolve).toHaveBeenCalledWith('acme.localhost');
    expect(req.tenantHost).toEqual({
      host: 'acme.localhost',
      tenantId: 't-1',
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('degrades to tenantId null on resolver rejection and still calls next', async () => {
    const mockResolver = {
      resolve: jest.fn().mockRejectedValue(new Error('db down')),
    } as unknown as TenantResolverService;

    const mockConfig = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;

    const middleware = new TenantHostMiddleware(mockResolver, mockConfig);
    const req = {
      headers: { host: 'acme.localhost' },
    } as unknown as TenantHostRequest;
    const next = jest.fn();

    await middleware.use(req, undefined, next);

    expect(mockResolver.resolve).toHaveBeenCalledWith('acme.localhost');
    expect(req.tenantHost).toEqual({
      host: 'acme.localhost',
      tenantId: null,
    });
    expect(next).toHaveBeenCalledTimes(1);
  });
});
