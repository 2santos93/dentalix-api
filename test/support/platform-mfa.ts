import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { MfaChallengeService } from '../../src/modules/auth/application/mfa-challenge.service';
import { decodeBase32, totpCode } from '../../src/shared/crypto/totp';
import { SEEDED_PASSWORD } from './e2e-fixtures';

export function totpAt(secret: string, offsetSteps = 0): string {
  const step = Math.floor(Date.now() / 30_000) + offsetSteps;
  return totpCode(decodeBase32(secret), step);
}

export interface PlatformChallenge {
  mfa: 'MFA_REQUIRED' | 'MFA_ENROLLMENT_REQUIRED';
  mfaToken: string;
  emailCodeRequired?: true;
}

/** El primer paso en el apex (DX-021-bis): contraseña → paso del segundo factor. */
export async function apexPassword(
  app: INestApplication<App>,
  email: string,
  password: string = SEEDED_PASSWORD,
): Promise<PlatformChallenge> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('X-Tenant-Host', 'localhost')
    .send({ email, password })
    .expect(201);
  return res.body as PlatformChallenge;
}

/** El código del correo: el test lo deriva, como el servidor al enviarlo. */
export function enrollmentEmailCode(
  app: INestApplication<App>,
  userId: string,
  tokenVersion: number,
): string {
  return app
    .get(MfaChallengeService, { strict: false })
    .emailCode(userId, tokenVersion);
}

export interface EnrolledPlatformAdmin {
  accessToken: string;
  refreshToken: string;
  secret: string;
  recoveryCodes: string[];
}

/** Alta completa en el login del apex; el código de la app es el de hace 30 s. */
export async function enrollPlatformAdmin(
  app: INestApplication<App>,
  user: { id: string; email: string; tokenVersion?: number },
  userAgent = 'e2e',
): Promise<EnrolledPlatformAdmin> {
  const http = () => request(app.getHttpServer());
  const { mfaToken } = await apexPassword(app, user.email);
  const emailCode = enrollmentEmailCode(app, user.id, user.tokenVersion ?? 0);
  const start = await http()
    .post('/api/v1/auth/login/mfa/enrollment')
    .set('X-Tenant-Host', 'localhost')
    .set('User-Agent', userAgent)
    .send({ mfaToken, emailCode })
    .expect(200);
  const { secret } = start.body as { secret: string };
  const confirm = await http()
    .post('/api/v1/auth/login/mfa/enrollment/confirm')
    .set('X-Tenant-Host', 'localhost')
    .set('User-Agent', userAgent)
    .send({ mfaToken, emailCode, code: totpAt(secret, -1) })
    .expect(200);
  return { ...(confirm.body as Omit<EnrolledPlatformAdmin, 'secret'>), secret };
}
