import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { TokenService } from './token.service';

function makeService(): TokenService {
  const config = new ConfigService({
    JWT_ACCESS_SECRET: 'a-secret',
    JWT_REFRESH_SECRET: 'r-secret',
    JWT_ACCESS_TTL: '900s',
    JWT_REFRESH_TTL: '30d',
  });
  return new TokenService(new JwtService({}), config);
}

describe('TokenService', () => {
  const svc = makeService();
  const payload = { sub: 'u1', tenantId: 't1', role: 'OWNER' as const };

  it('issues an access token that verifies back to the payload', async () => {
    const { accessToken, refreshToken } = await svc.issue(payload);
    expect(accessToken).toBeTruthy();
    expect(refreshToken).toBeTruthy();
    const decoded = await svc.verifyAccess(accessToken);
    expect(decoded.sub).toBe('u1');
    expect(decoded.tenantId).toBe('t1');
    expect(decoded.role).toBe('OWNER');
  });

  it('rejects a tampered access token', async () => {
    await expect(svc.verifyAccess('not-a-token')).rejects.toBeDefined();
  });
});
