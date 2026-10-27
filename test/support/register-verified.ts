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
  let pinned = false;
  for (let i = 0; i < 200 && !pinned; i++) {
    const { count } = await prisma.pendingRegistration.updateMany({
      where: { email },
      data: { tokenHash: hashRegistrationToken(token) },
    });
    pinned = count === 1;
    if (!pinned) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!pinned) {
    throw new Error(
      `registerVerified: no apareció el registro pendiente (¿el email ya tenía cuenta?)`,
    );
  }

  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/register/verify')
    .send({ token, password: payload.password })
    .expect(201);
  return { status: res.status, body: res.body as RegisterVerifiedBody };
}
