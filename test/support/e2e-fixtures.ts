import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { ClinicRole, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { PasswordService } from '../../src/shared/crypto/password.service';
import { PrismaExceptionFilter } from '../../src/shared/prisma/prisma-exception.filter';
import { hostFor } from './tenant-host';
import { registerVerified } from '../support/register-verified';
import {
  REGIONAL_BOGOTA_FIXTURE,
  registerBody,
  type RegionalFixture,
} from './location-fixtures';

// Fixtures compartidas por las matrices de DX-068 (role-matrix y
// tenant-isolation-matrix).

export const SEEDED_PASSWORD = 'S3cret!!';

/**
 * DX-279: cancelar una cita desde la agenda exige origen y motivo. Los specs
 * que solo necesitan una cita cancelada lo mandan con esto (se ignora en
 * cualquier otro cambio de estado).
 */
export const STAFF_CANCELLATION = {
  cancelledByKind: 'STAFF_FOR_PATIENT',
  cancelReasonCode: 'ILLNESS',
} as const;
const passwordService = new PasswordService();

/**
 * App de Nest configurada como main.ts (prefijo, pipes y filtro global).
 * `override` permite `overrideProvider(...)` antes de compilar (DX-207: la
 * matriz de aislamiento captura los emails para leer los tokens de A).
 */
export async function createE2eApp(
  override?: (builder: TestingModuleBuilder) => void,
): Promise<INestApplication<App>> {
  const builder = Test.createTestingModule({ imports: [AppModule] });
  override?.(builder);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new PrismaExceptionFilter());
  await app.init();
  // Reserve IPv4 before Supertest can bind :: and target a different listener.
  await app.listen(0, '127.0.0.1');
  return app;
}

// Tablas de referencia que siembra `prisma db seed` y no pertenecen a ninguna
// clínica: se conservan entre specs.
const KEEP_TABLES = new Set([
  '_prisma_migrations',
  'currencies',
  'countries',
  'cities',
  // DX-212: CIE-10 del capítulo oral (los diagnósticos la referencian).
  'icd10_codes',
  'exchange_rate_snapshots',
]);

/**
 * Vacía todas las tablas de datos (clínicas, usuarios y todo lo que cuelga de
 * ellas) con un TRUNCATE ... CASCADE: no depende del orden de las FKs ni de
 * qué dejó a medias otro spec. `raw` debe ser la conexión DIRECT_URL (owner).
 * Se niega a correr si la base no es de test.
 */
export async function resetDatabase(raw: PrismaClient): Promise<void> {
  const [{ db }] = await raw.$queryRaw<{ db: string }[]>`
    SELECT current_database() AS db`;
  if (!/_test(_\w+)?$/.test(db)) {
    throw new Error(`resetDatabase: "${db}" no es una base de test`);
  }
  const tables = await raw.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
  const toTruncate = tables
    .map((t) => t.tablename)
    .filter((name) => !KEEP_TABLES.has(name))
    .map((name) => `"public"."${name}"`);
  await raw.$executeRawUnsafe(`TRUNCATE ${toTruncate.join(', ')} CASCADE`);
}

export interface Clinic {
  tenantId: string;
  adminUserId: string;
  subdomain: string;
  host: string;
  adminToken: string;
}

interface Tokens {
  accessToken: string;
}

export async function registerClinic(
  app: INestApplication<App>,
  subdomain: string,
  fixture: RegionalFixture = REGIONAL_BOGOTA_FIXTURE,
): Promise<Clinic> {
  const email = `owner@${subdomain}.test`;
  const register = await registerVerified(
    app,
    registerBody(fixture, {
      clinicName: `Clinica ${subdomain}`,
      subdomain,
      email,
      password: SEEDED_PASSWORD,
      fullName: 'Dr. Owner',
    }),
  );
  const { tenantId, userId } = register.body as {
    tenantId: string;
    userId: string;
  };
  const host = hostFor(subdomain);
  const adminToken = await loginAs(app, host, email);
  return { tenantId, adminUserId: userId, subdomain, host, adminToken };
}

export async function loginAs(
  app: INestApplication<App>,
  host: string,
  email: string,
): Promise<string> {
  const login = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('X-Tenant-Host', host)
    .send({ email, password: SEEDED_PASSWORD })
    .expect(201);
  return (login.body as Tokens).accessToken;
}

/**
 * Usuario + membresía con el rol pedido, sembrados por `raw` (no hay atajo
 * por API: la invitación exige aceptar con token). Mismo hash que el
 * registro, para que el login real los acepte.
 */
export async function seedMember(
  raw: PrismaClient,
  clinic: Clinic,
  role: ClinicRole,
): Promise<{ userId: string; email: string }> {
  const email = `${role.toLowerCase()}@${clinic.subdomain}.test`;
  const user = await raw.user.create({
    data: {
      email,
      passwordHash: await passwordService.hash(SEEDED_PASSWORD),
      fullName: `Miembro ${role}`,
      emailVerifiedAt: new Date(),
    },
    select: { id: true },
  });
  await raw.clinicMembership.create({
    data: { tenantId: clinic.tenantId, userId: user.id, role },
  });
  return { userId: user.id, email };
}

/** Superadmin de plataforma y su token de PLATAFORMA (login en el apex). */
export async function platformAdminToken(
  app: INestApplication<App>,
  raw: PrismaClient,
): Promise<string> {
  const email = 'root@platform.test';
  await raw.user.create({
    data: {
      email,
      passwordHash: await passwordService.hash(SEEDED_PASSWORD),
      fullName: 'Superadmin',
      isPlatformAdmin: true,
    },
  });
  return loginAs(app, 'localhost', email);
}
