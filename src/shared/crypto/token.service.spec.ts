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

  it('issues a refresh token that verifies back to the payload', async () => {
    const { refreshToken } = await svc.issue(payload);
    const decoded = await svc.verifyRefresh(refreshToken);
    expect(decoded.sub).toBe('u1');
    expect(decoded.tenantId).toBe('t1');
    expect(decoded.role).toBe('OWNER');
  });

  it('rejects a tampered refresh token', async () => {
    await expect(svc.verifyRefresh('not-a-token')).rejects.toBeDefined();
  });

  // The two token types are signed with DIFFERENT secrets on purpose: an
  // access token must never pass as a refresh token (or the refresh endpoint
  // would accept a stolen short-lived access token for renewal), and a
  // refresh token must never pass the access guard.
  it('does not accept an access token as a refresh token', async () => {
    const { accessToken } = await svc.issue(payload);
    await expect(svc.verifyRefresh(accessToken)).rejects.toBeDefined();
  });

  it('does not accept a refresh token as an access token', async () => {
    const { refreshToken } = await svc.issue(payload);
    await expect(svc.verifyAccess(refreshToken)).rejects.toBeDefined();
  });

  // The refresh token carries a unique `jti` claim so a later logout
  // endpoint can revoke this SPECIFIC refresh token (denylist by jti).
  it('embeds a unique jti in the refresh token, readable via verifyRefresh', async () => {
    const { refreshToken } = await svc.issue(payload);
    const decoded = await svc.verifyRefresh(refreshToken);

    expect(typeof decoded.jti).toBe('string');
    expect(decoded.jti.length).toBeGreaterThan(0);
    expect(typeof decoded.exp).toBe('number');
    expect(decoded.sub).toBe('u1');
  });

  it('mints a different jti on each issue (rotation)', async () => {
    const a = await svc.issue(payload);
    const b = await svc.issue(payload);
    const da = await svc.verifyRefresh(a.refreshToken);
    const db = await svc.verifyRefresh(b.refreshToken);
    expect(da.jti).not.toBe(db.jti);
  });
});
