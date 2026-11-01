import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../../src/shared/prisma/prisma.service';
import {
  generateRegistrationToken,
  hashRegistrationToken,
} from '../../src/modules/auth/application/registration-token';

export interface RegisterPayload {
  clinicName: string;
  subdomain: string;
  email: string;
  password: string;
  fullName: string;
  // G1: la primera sede se registra con sus cuatro valores; cada llamada
  // nombra su fixture con `registerBody(...)`. G1-B: y su reloj (opcional
  // solo en fase 1, la forma de la web de G1).
  locationCountry: string;
  locationCurrency: string;
  locationTimeZone: string;
  locationLocale: string;
  locationHourCycle?: string;
}

export interface RegisterVerifiedBody {
  tenantId: string;
  userId: string;
  subdomain: string;
}

/**
 * DX-520: tope de la espera a la fila pendiente que el alta crea en segundo
 * plano tras el 202. Antes eran 200 × 10 ms (2 s) y con la máquina cargada
 * (varios carriles de e2e a la vez) el alta tardaba más y el `beforeAll`
 * caía. El sondeo devuelve en cuanto aparece, así que el tope solo cuenta
 * cuando de verdad no llega; queda por debajo del `testTimeout` de 30 s para
 * que el fallo diga qué faltó en vez de un timeout de Jest.
 */
export const PENDING_REGISTRATION_TIMEOUT_MS = 15_000;

/**
 * Repite `probe` hasta que devuelva `true` o venza el tope: primero cada
 * 10 ms y luego más espaciado (hasta 200 ms) para no martillear la BD.
 */
export async function pollUntil(
  probe: () => Promise<boolean>,
  timeoutMs = PENDING_REGISTRATION_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let delay = 10;
  for (;;) {
    if (await probe()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 200);
  }
}

/** Espera a que el alta en segundo plano cree la fila pendiente de `email`. */
export async function waitForPendingRegistration(
  prisma: Pick<PrismaService, 'pendingRegistration'>,
  email: string,
): Promise<void> {
  const found = await pollUntil(
    async () =>
      (await prisma.pendingRegistration.count({ where: { email } })) > 0,
  );
  if (!found) {
    throw new Error(
      `no apareció el registro pendiente de ${email} en ${PENDING_REGISTRATION_TIMEOUT_MS / 1000} s`,
    );
  }
}

/**
 * Alta de clínica por el camino real de DX-029: `POST /auth/register` (202,
 * sin crear nada) y `POST /auth/register/verify` con el token del enlace.
 *
 * El token en claro solo viaja en el email; para no depender del transporte,
 * el test fija en la fila pendiente el hash de un token que él mismo genera
 * (lo mismo que haría el email, sin leerlo). El alta corre en segundo plano
 * tras el 202, así que espera a que aparezca la fila.
 */
export async function registerVerified(
  app: INestApplication<App>,
  payload: RegisterPayload,
): Promise<{ status: number; body: RegisterVerifiedBody }> {
  const prisma = app.get(PrismaService, { strict: false });
  const email = payload.email.trim().toLowerCase();
  // Un pendiente de otra corrida no debe confundirse con el de esta.
  await prisma.pendingRegistration.deleteMany({ where: { email } });

  await request(app.getHttpServer())
    .post('/api/v1/auth/register')
    // Host de la plataforma: el enlace del email solo apunta a Dentalix.
    .set('X-Tenant-Host', 'localhost')
    .send(payload)
    .expect(202);

  const token = generateRegistrationToken();
  const pinned = await pollUntil(async () => {
    const { count } = await prisma.pendingRegistration.updateMany({
      where: { email },
      data: { tokenHash: hashRegistrationToken(token) },
    });
    return count === 1;
  });
  if (!pinned) {
    throw new Error(
      `registerVerified: no apareció el registro pendiente en ${PENDING_REGISTRATION_TIMEOUT_MS / 1000} s (¿el email ya tenía cuenta?)`,
    );
  }

  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/register/verify')
    .send({ token, password: payload.password })
    .expect(201);
  return { status: res.status, body: res.body as RegisterVerifiedBody };
}
