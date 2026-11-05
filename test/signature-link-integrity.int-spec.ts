import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConflictException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaSignatureRequestRepository } from '../src/modules/signature-requests/infrastructure/prisma-signature-request.repository';
import {
  generateSignatureToken,
  hashSignatureToken,
} from '../src/modules/signature-requests/domain/signature-token';
import type { CreateSignatureRequestRepoInput } from '../src/modules/signature-requests/domain/ports/signature-request-repository.port';
import { resetDatabase } from './support/e2e-fixtures';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';
import {
  backendPid,
  gate,
  settle,
  waitForLockWaiters,
} from './support/postgres-concurrency';

// DX-425 (DB-061/062/065): lo que la BD impone aunque la app falle.
//   - un solo enlace vivo por documento (índice único parcial) y el 409 en
//     español al perder la carrera;
//   - los contadores de intentos y de códigos solo suben (trigger);
//   - las horas de la evidencia las pone la BD (transaction_timestamp) y la
//     firma no puede ser posterior a la caducidad (CHECK);
//   - `dentalix_app` no puede borrar solicitudes de firma (REVOKE DELETE).
const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaSignatureRequestRepository(prisma, tenantContext);

interface Seeded {
  tenantId: string;
  locationId: string;
  patientId: string;
  otherPatientId: string;
  templateId: string;
  otherTemplateId: string;
  planId: string;
  otherPlanId: string;
  userId: string;
  otherUserId: string;
}

async function seedClinic(subdomain: string): Promise<Seeded> {
  const tenant = await owner.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const location = await owner.location.create({
    data: locationData(REGIONAL_CARACAS_FIXTURE, {
      tenantId: tenant.id,
      name: `Sede ${subdomain}`,
    }),
  });
  const user = (name: string) =>
    owner.user.create({
      data: {
        email: `${name}-${subdomain}@int.test`,
        passwordHash: 'x',
        fullName: `Dra. ${name}`,
      },
    });
  const dentist = await user('uno');
  const other = await user('dos');
  for (const u of [dentist, other]) {
    await owner.clinicMembership.create({
      data: { tenantId: tenant.id, userId: u.id, role: 'DENTIST' },
    });
  }
  const patient = (firstName: string) =>
    owner.patient.create({
      data: {
        tenantId: tenant.id,
        firstName,
        lastName: 'Int',
        email: `${firstName.toLowerCase()}@${subdomain}.test`,
        docNumber: randomUUID().slice(0, 12),
      },
    });
  const p = await patient('Ana');
  const plan = (patientId: string) =>
    owner.treatmentPlan.create({
      data: { tenantId: tenant.id, patientId, currency: 'USD' },
    });
  const template = (title: string) =>
    owner.consentTemplate.create({
      data: { tenantId: tenant.id, title, body: 'Texto' },
    });
  return {
    tenantId: tenant.id,
    locationId: location.id,
    patientId: p.id,
    otherPatientId: (await patient('Otro')).id,
    templateId: (await template('Exodoncia')).id,
    otherTemplateId: (await template('Endodoncia')).id,
    planId: (await plan(p.id)).id,
    otherPlanId: (await plan(p.id)).id,
    userId: dentist.id,
    otherUserId: other.id,
  };
}

const asClinic = <T>(tenantId: string, fn: () => Promise<T>) =>
  tenantContext.run(tenantId, fn);
const asApp = <T>(
  s: Seeded,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
) => prisma.runWithTenant(s.tenantId, fn);

function consentInput(
  s: Seeded,
  extra: Partial<CreateSignatureRequestRepoInput> = {},
): CreateSignatureRequestRepoInput {
  const now = new Date();
  return {
    locationId: s.locationId,
    patientId: s.patientId,
    type: 'CONSENT',
    channel: 'EMAIL',
    templateId: s.templateId,
    templateVersion: 1,
    treatmentPlanId: null,
    title: 'Exodoncia',
    body: 'Yo, Ana Int, autorizo…',
    professionalUserId: s.userId,
    professionalName: 'Dra.',
    signerType: 'PATIENT',
    signerName: 'Ana Int',
    signerDocument: null,
    destination: 'ana@example.com',
    destinationMasked: 'an***@example.com',
    tokenHash: hashSignatureToken(generateSignatureToken()),
    expiresAt: new Date(now.getTime() + 72 * 3600_000),
    createdById: s.userId,
    createdAt: now,
    ...extra,
  };
}

function budgetInput(
  s: Seeded,
  planId: string,
): CreateSignatureRequestRepoInput {
  return {
    ...consentInput(s),
    type: 'BUDGET',
    templateId: null,
    templateVersion: null,
    treatmentPlanId: planId,
    budgetContent: { total: '120.00', currency: 'USD' },
    budgetContentHash: 'c'.repeat(64),
  } as CreateSignatureRequestRepoInput;
}

/** Inserta SIN pasar por `repo.create` (que revoca la anterior viva). */
const insertRaw = (s: Seeded, data: CreateSignatureRequestRepoInput) =>
  asApp(s, (tx) =>
    tx.signatureRequest.create({
      data: { tenantId: s.tenantId, ...data },
      select: { id: true },
    }),
  );

const liveCount = (s: Seeded, where: Prisma.SignatureRequestWhereInput = {}) =>
  owner.signatureRequest.count({
    where: {
      tenantId: s.tenantId,
      signedAt: null,
      revokedAt: null,
      ...where,
    },
  });

/** Una fila viva recién creada y dejada lista (abierta) para los UPDATE. */
async function fresh(s: Seeded): Promise<string> {
  await owner.signatureRequest.updateMany({
    where: { tenantId: s.tenantId, signedAt: null, revokedAt: null },
    data: { revokedAt: new Date(), revokedById: s.userId },
  });
  return (await insertRaw(s, consentInput(s))).id;
}

const dbNow = async (): Promise<Date> => {
  const [row] = await owner.$queryRaw<{ now: Date }[]>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS now`;
  return row.now;
};

describe('integridad del enlace de firma en la BD (DX-425)', () => {
  let a: Seeded;

  beforeAll(async () => {
    await resetDatabase(owner);
    a = await seedClinic('dx425-int-a');
  });

  afterAll(async () => {
    await resetDatabase(owner);
    await owner.$disconnect();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Cada caso parte sin enlaces vivos de la clínica (superusuario: el
    // trigger de guarda solo protege lo firmado o anulado).
    await owner.signatureRequest.updateMany({
      where: { tenantId: a.tenantId, signedAt: null, revokedAt: null },
      data: { revokedAt: new Date(), revokedById: a.userId },
    });
  });

  describe('un solo enlace vivo por documento (DB-061)', () => {
    it('la BD rechaza un segundo enlace vivo del mismo paciente y plantilla', async () => {
      await insertRaw(a, consentInput(a));
      await expect(insertRaw(a, consentInput(a))).rejects.toMatchObject({
        code: 'P2002',
      });
      expect(await liveCount(a)).toBe(1);
    });

    it('la BD rechaza un segundo enlace vivo de presupuesto del mismo plan', async () => {
      await insertRaw(a, budgetInput(a, a.planId));
      await expect(
        insertRaw(a, budgetInput(a, a.planId)),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('otro documento, otro plan u otro paciente conviven; lo anulado o firmado no cuenta', async () => {
      await insertRaw(a, consentInput(a));
      await insertRaw(a, consentInput(a, { templateId: a.otherTemplateId }));
      await insertRaw(a, consentInput(a, { patientId: a.otherPatientId }));
      await insertRaw(a, budgetInput(a, a.planId));
      await insertRaw(a, budgetInput(a, a.otherPlanId));
      // Anulada: libera el documento.
      await owner.signatureRequest.updateMany({
        where: {
          tenantId: a.tenantId,
          patientId: a.patientId,
          templateId: a.templateId,
        },
        data: { revokedAt: new Date(), revokedById: a.userId },
      });
      await insertRaw(a, consentInput(a));
      expect(await liveCount(a)).toBe(5);
    });

    it('dos envíos concurrentes: gana uno y el otro recibe 409 en español', async () => {
      // Carrera real y determinista: el envío A inserta y se queda sin
      // confirmar; el envío B (repo.create) no lo ve —READ COMMITTED—, no
      // encuentra nada que reemplazar e inserta: espera a A en el índice. Al
      // confirmar A, B pierde.
      const inserted = gate<number>();
      const commit = gate();
      const winner = settle(
        asApp(a, async (tx) => {
          await tx.signatureRequest.create({
            data: { tenantId: a.tenantId, ...consentInput(a) },
          });
          inserted.open(await backendPid(tx));
          await commit.wait;
        }),
      );
      const pid = await inserted.wait;
      const loser = settle(
        asClinic(a.tenantId, () => repo.create(consentInput(a))),
      );
      try {
        await waitForLockWaiters(owner, [pid]);
      } finally {
        commit.open();
      }
      expect((await winner).status).toBe('fulfilled');
      const outcome = await loser;
      expect(outcome.status).toBe('rejected');
      const reason = (outcome as { reason: unknown }).reason;
      expect(reason).toBeInstanceOf(ConflictException);
      expect((reason as ConflictException).getStatus()).toBe(409);
      expect((reason as ConflictException).message).toMatch(
        /ya se está enviando|ya hay un envío/i,
      );
      expect(await liveCount(a)).toBe(1);
    });

    it('envíos simultáneos sin pausa: nunca más de un enlace vivo', async () => {
      for (let round = 0; round < 5; round++) {
        const results = await Promise.all(
          [0, 1, 2].map(() =>
            settle(asClinic(a.tenantId, () => repo.create(consentInput(a)))),
          ),
        );
        for (const r of results) {
          if (r.status === 'rejected') {
            expect(r.reason).toBeInstanceOf(ConflictException);
          }
        }
        expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
        expect(await liveCount(a)).toBe(1);
      }
    });

    it('un reenvío en serie sigue funcionando: anula el anterior y deja uno vivo', async () => {
      const first = await asClinic(a.tenantId, () =>
        repo.create(consentInput(a)),
      );
      const second = await asClinic(a.tenantId, () =>
        repo.create(consentInput(a)),
      );
      expect(second.supersededIds).toEqual([first.id]);
      expect(await liveCount(a)).toBe(1);
    });
  });

  describe('los contadores solo suben (DB-062)', () => {
    it('failedAttempts no baja', async () => {
      const id = await fresh(a);
      await asApp(a, (tx) =>
        tx.signatureRequest.update({
          where: { id },
          data: { failedAttempts: 2 },
        }),
      );
      await expect(
        asApp(a, (tx) =>
          tx.signatureRequest.update({
            where: { id },
            data: { failedAttempts: 1 },
          }),
        ),
      ).rejects.toThrow(/solo suben|no puede bajar/i);
      await expect(
        owner.$executeRaw`UPDATE "signature_requests" SET "failedAttempts" = 0 WHERE "id" = ${id}::uuid`,
      ).rejects.toThrow(/solo suben|no puede bajar/i);
      await asApp(a, (tx) =>
        tx.signatureRequest.update({
          where: { id },
          data: { failedAttempts: 3 },
        }),
      );
      expect(
        (await owner.signatureRequest.findUniqueOrThrow({ where: { id } }))
          .failedAttempts,
      ).toBe(3);
    });

    it('el contador de códigos enviados no baja', async () => {
      const id = await fresh(a);
      await asApp(a, (tx) =>
        tx.signatureRequest.update({
          where: { id },
          data: { codeSendCount: 3 },
        }),
      );
      await expect(
        asApp(a, (tx) =>
          tx.signatureRequest.update({
            where: { id },
            data: { codeSendCount: 2 },
          }),
        ),
      ).rejects.toThrow(/solo suben|no puede bajar/i);
      await expect(
        asApp(a, (tx) =>
          tx.signatureRequest.update({
            where: { id },
            data: { codeSendCount: { decrement: 1 } },
          }),
        ),
      ).rejects.toThrow(/solo suben|no puede bajar/i);
    });
  });

  describe('las horas de la evidencia las pone la BD (DB-062)', () => {
    it('apertura, código, verificación, bloqueo y firma salen del reloj de la BD', async () => {
      const id = await fresh(a);
      const forged = new Date('2001-02-03T04:05:06.000Z');
      const before = await dbNow();
      await asApp(a, (tx) =>
        tx.signatureRequest.update({
          where: { id },
          data: {
            openedAt: forged,
            codeHash: 'd'.repeat(64),
            codeExpiresAt: new Date(Date.now() + 600_000),
            codeSentAt: forged,
            codeSendCount: 1,
          },
        }),
      );
      await asApp(a, (tx) =>
        tx.signatureRequest.update({
          where: { id },
          data: { verifiedAt: forged },
        }),
      );
      await asApp(a, (tx) =>
        tx.signatureRequest.update({
          where: { id },
          data: { signedAt: forged },
        }),
      );
      const after = await dbNow();
      const row = await owner.signatureRequest.findUniqueOrThrow({
        where: { id },
      });
      for (const at of [
        row.openedAt,
        row.codeSentAt,
        row.verifiedAt,
        row.signedAt,
      ]) {
        expect(at!.getTime()).toBeGreaterThanOrEqual(before.getTime());
        expect(at!.getTime()).toBeLessThanOrEqual(after.getTime());
      }
    });

    it('el bloqueo por intentos fallidos lleva la hora de la BD', async () => {
      const id = await fresh(a);
      const forged = new Date('2001-02-03T04:05:06.000Z');
      const before = await dbNow();
      await asApp(a, (tx) =>
        tx.signatureRequest.update({
          where: { id },
          data: { failedAttempts: 5, lockedAt: forged },
        }),
      );
      const after = await dbNow();
      const { lockedAt } = await owner.signatureRequest.findUniqueOrThrow({
        where: { id },
      });
      expect(lockedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(lockedAt!.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('una hora ya puesta no se reescribe al actualizar otros campos', async () => {
      const id = await fresh(a);
      await asApp(a, (tx) =>
        tx.signatureRequest.update({
          where: { id },
          data: { openedAt: new Date() },
        }),
      );
      const { openedAt } = await owner.signatureRequest.findUniqueOrThrow({
        where: { id },
      });
      await asApp(a, (tx) =>
        tx.signatureRequest.update({
          where: { id },
          data: { openedAt, failedAttempts: 1 },
        }),
      );
      expect(
        (await owner.signatureRequest.findUniqueOrThrow({ where: { id } }))
          .openedAt,
      ).toEqual(openedAt);
    });
  });

  describe('firmar después de la caducidad (DB-062)', () => {
    it('la BD rechaza la firma con el enlace caducado aunque la app lo intente', async () => {
      const hour = 3_600_000;
      const id = (
        await insertRaw(
          a,
          consentInput(a, {
            createdAt: new Date(Date.now() - 3 * hour),
            expiresAt: new Date(Date.now() - hour),
          }),
        )
      ).id;
      await asApp(a, (tx) =>
        tx.signatureRequest.update({
          where: { id },
          data: { openedAt: new Date(), verifiedAt: new Date() },
        }),
      );
      await expect(
        asApp(a, (tx) =>
          tx.signatureRequest.update({
            where: { id },
            // Aunque la app «diga» que firmó antes de caducar, la hora la
            // pone la BD.
            data: { signedAt: new Date(Date.now() - 2 * hour) },
          }),
        ),
      ).rejects.toThrow(/signature_requests_signed_before_expiry_check/);
      expect(
        (await owner.signatureRequest.findUniqueOrThrow({ where: { id } }))
          .signedAt,
      ).toBeNull();
    });

    it('con el enlace vigente sí firma', async () => {
      const id = await fresh(a);
      await asApp(a, (tx) =>
        tx.signatureRequest.update({
          where: { id },
          data: { openedAt: new Date(), verifiedAt: new Date() },
        }),
      );
      await asApp(a, (tx) =>
        tx.signatureRequest.update({
          where: { id },
          data: { signedAt: new Date() },
        }),
      );
      expect(
        (await owner.signatureRequest.findUniqueOrThrow({ where: { id } }))
          .signedAt,
      ).not.toBeNull();
    });
  });

  describe('sin borrado para la app (DB-065)', () => {
    it('dentalix_app no tiene DELETE y el intento falla por permisos', async () => {
      const id = await fresh(a);
      const [priv] = await owner.$queryRaw<{ can: boolean }[]>`
        SELECT has_table_privilege('dentalix_app', 'public.signature_requests', 'DELETE') AS can`;
      expect(priv.can).toBe(false);
      await expect(
        asApp(
          a,
          (tx) =>
            tx.$executeRaw`DELETE FROM "signature_requests" WHERE "id" = ${id}::uuid`,
        ),
      ).rejects.toThrow(/permission denied/i);
    });

    it('la purga de un superusuario sigue pudiendo borrar', async () => {
      const id = await fresh(a);
      await owner.$executeRaw`DELETE FROM "signature_requests" WHERE "id" = ${id}::uuid`;
      expect(
        await owner.signatureRequest.count({ where: { id } }),
      ).toBe(0);
    });
  });

  describe('migración sobre datos existentes con duplicados vivos', () => {
    const dedupeSql = (): string => {
      const migration = readFileSync(
        join(
          __dirname,
          '../prisma/migrations/20261121090000_dx425_signature_link_integrity/migration.sql',
        ),
        'utf8',
      );
      return migration.slice(
        migration.indexOf('-- BEGIN dedupe'),
        migration.indexOf('-- END dedupe'),
      );
    };

    it('revoca los más antiguos con el autor del más reciente y no borra nada', async () => {
      class Rollback extends Error {}
      const seen: {
        id: string;
        revokedAt: Date | null;
        revokedById: string | null;
      }[] = [];
      const ids: string[] = [];
      await owner
        .$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            'DROP INDEX "signature_requests_live_consent_key"',
          );
          await tx.$executeRawUnsafe(
            'DROP INDEX "signature_requests_live_budget_key"',
          );
          const base = Date.now() - 10 * 60_000;
          for (const [i, by] of [a.userId, a.otherUserId, a.userId].entries()) {
            const createdAt = new Date(base + i * 60_000);
            const row = await tx.signatureRequest.create({
              data: {
                tenantId: a.tenantId,
                ...consentInput(a, { createdAt, createdById: by }),
              },
              select: { id: true },
            });
            ids.push(row.id);
          }
          await tx.$executeRawUnsafe(dedupeSql());
          seen.push(
            ...(await tx.signatureRequest.findMany({
              where: { id: { in: ids } },
              select: { id: true, revokedAt: true, revokedById: true },
            })),
          );
          throw new Rollback();
        })
        .catch((e: unknown) => {
          if (!(e instanceof Rollback)) throw e;
        });
      const byId = new Map(seen.map((r) => [r.id, r]));
      expect(byId.size).toBe(3);
      // El más reciente (ids[2], de a.userId) sigue vivo; los dos anteriores
      // quedan anulados por quien envió el más reciente.
      expect(byId.get(ids[2])!.revokedAt).toBeNull();
      for (const old of [ids[0], ids[1]]) {
        expect(byId.get(old)!.revokedAt).not.toBeNull();
        expect(byId.get(old)!.revokedById).toBe(a.userId);
      }
    });
  });
});
