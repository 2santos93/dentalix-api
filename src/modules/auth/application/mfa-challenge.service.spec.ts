import { hkdfSync } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { MfaChallengeService } from './mfa-challenge.service';

/**
 * DX-045: el token del paso intermedio del login sigue la misma política que
 * las sesiones (HS256 fijo, `iss`/`aud` del entorno).
 */
describe('MfaChallengeService: política de JWT (DX-045)', () => {
  const ACCESS = 'jwt-access-secret-de-prueba-0123456789';
  const ISS = 'https://api.dentalix.app';
  const AUD = 'https://dentalix.app';
  const config = new ConfigService({
    JWT_ACCESS_SECRET: ACCESS,
    JWT_ISSUER: ISS,
    JWT_AUDIENCE: AUD,
  });
  const jwt = new JwtService({});
  const svc = new MfaChallengeService(jwt, config);
  // La misma clave derivada que el servicio, para forjar tokens de prueba.
  const derived = Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(ACCESS, 'utf8'),
      Buffer.alloc(0),
      'dentalix-login-mfa-challenge',
      32,
    ),
  ).toString('hex');
  const claims = { sub: 'u1', tenantId: 't1', tv: 0, purpose: 'MFA_VERIFY' };

  it('emite en HS256 con iss/aud y lo verifica', async () => {
    const { token } = await svc.issue({
      userId: 'u1',
      tenantId: 't1',
      tokenVersion: 0,
      purpose: 'MFA_VERIFY',
    });
    const { header, payload } = jwt.decode<{
      header: { alg: string };
      payload: { iss: string; aud: string };
    }>(token, { complete: true });
    expect(header.alg).toBe('HS256');
    expect(payload).toMatchObject({ iss: ISS, aud: AUD });
    await expect(svc.verify(token, 'MFA_VERIFY', 't1')).resolves.toMatchObject({
      sub: 'u1',
    });
  });

  it('rechaza HS512 y un iss de otro entorno con el 401 de reto caducado', async () => {
    const hs512 = await jwt.signAsync(claims, {
      secret: derived,
      algorithm: 'HS512',
      issuer: ISS,
      audience: AUD,
      expiresIn: 60,
      jwtid: 'j1',
    });
    const otherIss = await jwt.signAsync(claims, {
      secret: derived,
      issuer: 'https://api.staging.dentalix.app',
      audience: AUD,
      expiresIn: 60,
      jwtid: 'j2',
    });
    for (const token of [hs512, otherIss]) {
      await expect(svc.verify(token, 'MFA_VERIFY', 't1')).rejects.toMatchObject(
        {
          response: { code: 'MFA_CHALLENGE_EXPIRED' },
        },
      );
    }
  });
});
