import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { MfaChallengeService } from '../../src/modules/auth/application/mfa-challenge.service';
import { SEEDED_PASSWORD } from './e2e-fixtures';
import { previousStepCode } from './totp';

export interface PlatformChallenge {
  mfa: 'MFA_REQUIRED' | 'MFA_ENROLLMENT_REQUIRED';
  mfaToken: string;
  emailCodeRequired?: true;
  emailCodeRef?: string;
}

/**
 * El primer paso en el apex (DX-021-bis): contraseña → paso del segundo factor.
 * `ip`: solo en apps con `trustProxyHops`.
 */
export async function apexPassword(
  app: INestApplication<App>,
  email: string,
  ip?: string,
): Promise<PlatformChallenge> {
  const req = request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('X-Tenant-Host', 'localhost');
  if (ip) void req.set('X-Forwarded-For', ip);
  const res = await req.send({ email, password: SEEDED_PASSWORD }).expect(201);
  return res.body as PlatformChallenge;
}

/** El código del correo de ese token: el test lo deriva, como el servidor. */
export function enrollmentEmailCode(
  app: INestApplication<App>,
  mfaToken: string,
): string {
  const { jti } = JSON.parse(
    Buffer.from(mfaToken.split('.')[1], 'base64url').toString(),
  ) as { jti: string };
  return app.get(MfaChallengeService, { strict: false }).emailCode(jti);
}

export interface EnrolledPlatformAdmin {
  accessToken: string;
  refreshToken: string;
  secret: string;
  recoveryCodes: string[];
}

/**
 * Alta completa en el login del apex. El código de la app es el del paso
 * anterior (deja libres el actual y el siguiente al test), calculado cuando aún
 * le queda margen a la ventana (DX-552).
 */
export async function enrollPlatformAdmin(
  app: INestApplication<App>,
  user: { id: string; email: string },
  userAgent = 'e2e',
  challenge?: PlatformChallenge,
): Promise<EnrolledPlatformAdmin> {
  const http = () => request(app.getHttpServer());
  const { mfaToken } = challenge ?? (await apexPassword(app, user.email));
  const emailCode = enrollmentEmailCode(app, mfaToken);
  const start = await http()
    .post('/api/v1/auth/login/mfa/enrollment')
    .set('X-Tenant-Host', 'localhost')
    .set('User-Agent', userAgent)
    .send({ mfaToken, emailCode })
    .expect(200);
  const { secret } = start.body as { secret: string };
  const code = await previousStepCode(secret);
  const confirm = await http()
    .post('/api/v1/auth/login/mfa/enrollment/confirm')
    .set('X-Tenant-Host', 'localhost')
    .set('User-Agent', userAgent)
    .send({ mfaToken, emailCode, code })
    .expect(200);
  return { ...(confirm.body as Omit<EnrolledPlatformAdmin, 'secret'>), secret };
}
