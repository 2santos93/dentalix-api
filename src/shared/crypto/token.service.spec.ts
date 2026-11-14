import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { isTenantPayload, TokenService } from './token.service';
import {
  assertJwtScope,
  DEFAULT_JWT_AUDIENCE,
  DEFAULT_JWT_ISSUER,
} from './jwt-policy';

function makeService(extra: Record<string, string> = {}): TokenService {
  const config = new ConfigService({
    JWT_ACCESS_SECRET: 'a-secret',
    JWT_REFRESH_SECRET: 'r-secret',
    JWT_ACCESS_TTL: '900s',
    JWT_REFRESH_TTL: '30d',
    ...extra,
  });
  return new TokenService(new JwtService({}), config);
}

describe('TokenService', () => {
  const svc = makeService();
  const payload = {
    sub: 'u1',
    tenantId: 't1',
    role: 'ADMIN' as const,
    tv: 2,
  };

  it('issues an access token that verifies back to the payload', async () => {
    const { accessToken, refreshToken } = await svc.issue(payload);
    expect(accessToken).toBeTruthy();
    expect(refreshToken).toBeTruthy();
    const decoded = await svc.verifyAccess(accessToken);
    if (!isTenantPayload(decoded)) throw new Error('expected a tenant payload');
    expect(decoded.sub).toBe('u1');
    expect(decoded.tenantId).toBe('t1');
    expect(decoded.role).toBe('ADMIN');
  });

  it('SEC-008: issueAccessOnly firma solo un access token con su TTL y devuelve el exp', async () => {
    const before = Math.floor(Date.now() / 1000);
    const { accessToken, expiresAt } = await svc.issueAccessOnly(
      { ...payload, breakGlass: true },
      1800,
    );
    const decoded = (await svc.verifyAccess(accessToken)) as unknown as {
      breakGlass: boolean;
      exp: number;
      iat: number;
    };
    expect(decoded.breakGlass).toBe(true);
    expect(decoded.exp - decoded.iat).toBe(1800);
    expect(decoded.iat).toBeGreaterThanOrEqual(before);
    expect(expiresAt.getTime()).toBe(decoded.exp * 1000);
    // No vale como refresh (otro secreto).
    await expect(svc.verifyRefresh(accessToken)).rejects.toBeDefined();
  });

  it('rejects a tampered access token', async () => {
    await expect(svc.verifyAccess('not-a-token')).rejects.toBeDefined();
  });

  it('issues a refresh token that verifies back to the payload', async () => {
    const { refreshToken } = await svc.issue(payload);
    const decoded = await svc.verifyRefresh(refreshToken);
    if (!isTenantPayload(decoded)) throw new Error('expected a tenant payload');
    expect(decoded.sub).toBe('u1');
    expect(decoded.tenantId).toBe('t1');
    expect(decoded.role).toBe('ADMIN');
    // La versión de sesión viaja en el refresh para que /auth/refresh pueda
    // compararla con User.tokenVersion.
    expect(decoded.tv).toBe(2);
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

  it('starts a new refresh family (`sid`) on each plain issue (login)', async () => {
    const a = await svc.verifyRefresh((await svc.issue(payload)).refreshToken);
    const b = await svc.verifyRefresh((await svc.issue(payload)).refreshToken);
    expect(typeof a.sid).toBe('string');
    expect(a.sid).not.toBe(b.sid);
  });

  it('keeps the family on rotation and returns its claims', async () => {
    const { refreshToken } = await svc.issue(payload, { sid: 'fam-1' });
    const decoded = await svc.verifyRefresh(refreshToken);
    expect(decoded.sid).toBe('fam-1');
    const claims = svc.refreshClaims(refreshToken);
    expect(claims).toEqual({
      sid: 'fam-1',
      jti: decoded.jti,
      expiresAt: new Date(decoded.exp * 1000),
    });
  });

  it('re-issues the CURRENT refresh (same jti and exp) for the grace path', async () => {
    const original = await svc.verifyRefresh(
      (await svc.issue(payload, { sid: 'fam-1' })).refreshToken,
    );
    const again = await svc.issue(payload, {
      sid: 'fam-1',
      jti: original.jti,
      expiresAt: new Date(original.exp * 1000),
    });
    const decoded = await svc.verifyRefresh(again.refreshToken);
    expect(decoded.jti).toBe(original.jti);
    expect(decoded.exp).toBe(original.exp);
    expect(decoded.sid).toBe('fam-1');
    // El access token sí es nuevo (y no lleva familia).
    const access = (await svc.verifyAccess(again.accessToken)) as {
      sid?: string;
    };
    expect(access.sid).toBeUndefined();
  });
});

/**
 * DX-045 (absorbe SEC-023): algoritmo fijo HS256 e `iss`/`aud` por entorno,
 * con transición para los tokens emitidos antes (sin esos claims).
 */
describe('TokenService: política de JWT (DX-045)', () => {
  const ISS = 'https://api.dentalix.app';
  const AUD = 'https://dentalix.app';
  const svc = makeService({ JWT_ISSUER: ISS, JWT_AUDIENCE: AUD });
  const jwt = new JwtService({});
  const payload = { sub: 'u1', tenantId: 't1', role: 'ADMIN' as const, tv: 0 };
  const b64 = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = () => Math.floor(Date.now() / 1000);

  it('emite access y refresh en HS256 con el iss/aud del entorno', async () => {
    const { accessToken, refreshToken } = await svc.issue(payload);
    for (const token of [accessToken, refreshToken]) {
      const { header, payload: claims } = jwt.decode<{
        header: { alg: string };
        payload: { iss: string; aud: string };
      }>(token, { complete: true });
      expect(header.alg).toBe('HS256');
      expect(claims.iss).toBe(ISS);
      expect(claims.aud).toBe(AUD);
    }
    const { accessToken: bg } = await svc.issueAccessOnly(payload, 600);
    expect(jwt.decode<{ iss: string; aud: string }>(bg)).toMatchObject({
      iss: ISS,
      aud: AUD,
    });
  });

  it('un HS256 válido pasa (access y refresh)', async () => {
    const { accessToken, refreshToken } = await svc.issue(payload);
    await expect(svc.verifyAccess(accessToken)).resolves.toMatchObject({
      sub: 'u1',
      iss: ISS,
      aud: AUD,
    });
    await expect(svc.verifyRefresh(refreshToken)).resolves.toMatchObject({
      sub: 'u1',
    });
  });

  it('rechaza un token firmado con HS512 (aunque el secreto sea el bueno)', async () => {
    for (const [secret, verify] of [
      ['a-secret', (t: string) => svc.verifyAccess(t)],
      ['r-secret', (t: string) => svc.verifyRefresh(t)],
    ] as const) {
      const hs512 = await jwt.signAsync(payload, {
        secret,
        algorithm: 'HS512',
        issuer: ISS,
        audience: AUD,
        expiresIn: 60,
      });
      await expect(verify(hs512)).rejects.toThrow(/invalid algorithm/);
    }
  });

  it('rechaza un token con alg "none" (sin firma)', async () => {
    const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
      ...payload,
      iss: ISS,
      aud: AUD,
      iat: now(),
      exp: now() + 60,
    })}.`;
    await expect(svc.verifyAccess(unsigned)).rejects.toBeDefined();
    await expect(svc.verifyRefresh(unsigned)).rejects.toBeDefined();
    // Y con un trozo de "firma" cualquiera, tampoco.
    await expect(svc.verifyAccess(`${unsigned}x`)).rejects.toBeDefined();
  });

  it.each([
    [
      'iss de otro entorno',
      { issuer: 'https://api.staging.dentalix.app', audience: AUD },
    ],
    [
      'aud de otro entorno',
      { issuer: ISS, audience: 'https://staging.dentalix.app' },
    ],
    [
      'aud en lista sin la nuestra',
      { issuer: ISS, audience: ['otra', 'y-otra'] },
    ],
  ])('rechaza un token con %s', async (_, claims) => {
    const access = await jwt.signAsync(payload, {
      secret: 'a-secret',
      expiresIn: 60,
      ...claims,
    });
    const refresh = await jwt.signAsync(payload, {
      secret: 'r-secret',
      expiresIn: 60,
      jwtid: 'j1',
      ...claims,
    });
    await expect(svc.verifyAccess(access)).rejects.toThrow(/Token inválido/);
    await expect(svc.verifyRefresh(refresh)).rejects.toThrow(/Token inválido/);
  });

  it('un token de otro entorno no vale aunque compartiera secreto', async () => {
    const staging = makeService({
      JWT_ISSUER: 'https://api.staging.dentalix.app',
      JWT_AUDIENCE: 'https://staging.dentalix.app',
    });
    const { accessToken, refreshToken } = await staging.issue(payload);
    await expect(svc.verifyAccess(accessToken)).rejects.toBeDefined();
    await expect(svc.verifyRefresh(refreshToken)).rejects.toBeDefined();
  });

  it('acepta un aud en lista que incluye la nuestra', async () => {
    const token = await jwt.signAsync(payload, {
      secret: 'a-secret',
      expiresIn: 60,
      issuer: ISS,
      audience: ['otra', AUD],
    });
    await expect(svc.verifyAccess(token)).resolves.toMatchObject({ sub: 'u1' });
  });

  it('TRANSICIÓN: un token anterior a DX-045 (sin iss ni aud) sigue valiendo hasta que caduca', async () => {
    const legacyAccess = await jwt.signAsync(payload, {
      secret: 'a-secret',
      expiresIn: 60,
    });
    const legacyRefresh = await jwt.signAsync(
      { ...payload, sid: 'fam-1' },
      { secret: 'r-secret', expiresIn: '30d', jwtid: 'j-legacy' },
    );
    await expect(svc.verifyAccess(legacyAccess)).resolves.toMatchObject({
      sub: 'u1',
    });
    await expect(svc.verifyRefresh(legacyRefresh)).resolves.toMatchObject({
      sid: 'fam-1',
      jti: 'j-legacy',
    });
    // Caducado, ya no.
    const expired = await jwt.signAsync(
      { ...payload, exp: now() - 10 },
      { secret: 'a-secret' },
    );
    await expect(svc.verifyAccess(expired)).rejects.toThrow(/expired/);
  });

  it('TRANSICIÓN: solo se tolera la AUSENCIA; con uno presente, el otro se comprueba', async () => {
    const onlyBadIss = await jwt.signAsync(payload, {
      secret: 'a-secret',
      expiresIn: 60,
      issuer: 'otro',
    });
    const onlyBadAud = await jwt.signAsync(payload, {
      secret: 'a-secret',
      expiresIn: 60,
      audience: 'otra',
    });
    await expect(svc.verifyAccess(onlyBadIss)).rejects.toThrow(/iss/);
    await expect(svc.verifyAccess(onlyBadAud)).rejects.toThrow(/aud/);
  });

  it('sin JWT_ISSUER/JWT_AUDIENCE usa los defaults de desarrollo', async () => {
    const dev = makeService();
    const { accessToken } = await dev.issue(payload);
    expect(jwt.decode<{ iss: string; aud: string }>(accessToken)).toMatchObject(
      {
        iss: DEFAULT_JWT_ISSUER,
        aud: DEFAULT_JWT_AUDIENCE,
      },
    );
    await expect(dev.verifyAccess(accessToken)).resolves.toBeDefined();
  });
});

describe('assertJwtScope (DX-045)', () => {
  const scope = { issuer: 'i', audience: 'a' };

  it('con la transición activa, la ausencia vale y el valor distinto no', () => {
    expect(() => assertJwtScope({}, scope, true)).not.toThrow();
    expect(() =>
      assertJwtScope({ iss: 'i', aud: 'a' }, scope, true),
    ).not.toThrow();
    expect(() => assertJwtScope({ iss: 'x' }, scope, true)).toThrow(/iss/);
    expect(() => assertJwtScope({ aud: 'x' }, scope, true)).toThrow(/aud/);
    expect(() => assertJwtScope({ iss: 'i', aud: ['x'] }, scope, true)).toThrow(
      /aud/,
    );
  });

  it('sin transición (cuando se retire), la ausencia también se rechaza', () => {
    expect(() => assertJwtScope({}, scope, false)).toThrow(/iss/);
    expect(() => assertJwtScope({ iss: 'i' }, scope, false)).toThrow(/aud/);
    expect(() =>
      assertJwtScope({ iss: 'i', aud: 'a' }, scope, false),
    ).not.toThrow();
  });
});
