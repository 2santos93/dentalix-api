import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPrescriptionRepository } from '../src/modules/prescriptions/infrastructure/repositories/prisma-prescription.repository';
import * as verification from '../src/modules/prescriptions/domain/prescription-verification';
import type { CreatePrescriptionRepoInput } from '../src/modules/prescriptions/domain/ports/prescription-repository.port';
import { computePrescriptionHash } from '../src/modules/prescriptions/domain/prescription-hash';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-467, capa DB del código de verificación de la receta. Los casos de la
// app van POR LA MISMA RUTA que ella (repositorio real, runWithTenant, rol
// dentalix_app sujeto a RLS); `raw` (DIRECT_URL, owner) solo siembra, lee lo
// que la RLS esconde y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaPrescriptionRepository(prisma, tenantContext);

const CODE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{12}$/;

interface Seeded {
  tenantId: string;
  locationId: string;
  patientId: string;
  userId: string;
}

async function seedClinic(subdomain: string): Promise<Seeded> {
  const tenant = await raw.tenant.create({
    data: { name: `Clínica ${subdomain}`, subdomain },
  });
  const location = await raw.location.create({
    data: locationData(REGIONAL_CARACAS_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede',
    }),
  });
  const patient = await raw.patient.create({
    data: { tenantId: tenant.id, firstName: 'Ana', lastName: 'Pérez' },
  });
  const user = await raw.user.create({
    data: {
      email: `dr@${subdomain}.test`,
      passwordHash: 'x',
      fullName: 'Dra. Prueba',
    },
  });
  return {
    tenantId: tenant.id,
    locationId: location.id,
    patientId: patient.id,
    userId: user.id,
  };
}

function content(s: Seeded): Omit<CreatePrescriptionRepoInput, 'contentHash'> {
  return {
    singleFormat: true,
    printQuantityInWords: false,
    locationId: s.locationId,
    patientId: s.patientId,
    professionalId: s.userId,
    issuedAt: new Date('2026-11-06T14:00:00.000Z'),
    dispensationDate: '2026-11-06',
    validUntil: '2026-12-05',
    patientName: 'Ana Pérez',
    patientDocument: null,
    patientBirthYear: null,
    patientAgeYears: null,
    patientWeightKg: null,
    clinicalRecordNumber: null,
    professionalName: 'Dra. Prueba',
    professionalLicense: 'RM-1',
    professionalSpecialty: null,
    professionalEmail: null,
    clinicName: 'Clínica',
    clinicFiscal: null,
    locationName: 'Sede',
    locationAddress: null,
    notes: null,
    allergyOverride: false,
    allergyMatches: [],
    safetyRulesVersion: '2026-10-24',
    safetyAlerts: [],
    safetyOverrideReason: null,
    items: [
      {
        position: 1,
        activeIngredient: 'Amoxicilina',
        brandName: null,
        concentration: '500 mg',
        pharmaceuticalForm: 'Cápsula',
        route: 'Oral',
        dose: '1 cápsula',
        frequency: 'Cada 8 horas',
        durationDays: 7,
        totalQuantity: 21,
        quantityUnit: 'cápsulas',
        quantityInWords: 'veintiuno',
        packages: null,
        instructions: null,
      },
    ],
  };
}

function issueIn(s: Seeded) {
  const c = content(s);
  return tenantContext.run(s.tenantId, () =>
    repo.create({
      ...c,
      contentHash: computePrescriptionHash(c),
    }),
  );
}

async function cleanup(seeds: Seeded[]): Promise<void> {
  const tenantIds = seeds.map((s) => s.tenantId);
  const where = { tenantId: { in: tenantIds } };
  // Sin `app.current_tenant` (conexión owner): los triggers dejan borrar.
  await raw.auditEvent.deleteMany({ where });
  await raw.prescription.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.user.deleteMany({
    where: { id: { in: seeds.map((s) => s.userId) } },
  });
  await raw.tenant.deleteMany({ where: { id: { in: tenantIds } } });
}

describe('prescriptions.verificationCode: RLS, unicidad, inmutabilidad y auditoría (DX-467, int)', () => {
  let a: Seeded;
  let b: Seeded;

  beforeAll(async () => {
    await prisma.onModuleInit();
    const suffix = `${process.pid}-${Date.now()}`;
    a = await seedClinic(`dx467-a-${suffix}`);
    b = await seedClinic(`dx467-b-${suffix}`);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanup([a, b]);
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  it('emitir deja un código de 12 símbolos sin ambiguos, guardado tal cual', async () => {
    const rx = await issueIn(a);
    expect(rx.verificationCode).toMatch(CODE);
    const row = await raw.prescription.findUniqueOrThrow({
      where: { id: rx.id },
    });
    expect(row.verificationCode).toBe(rx.verificationCode);
  });

  it('la clínica del host encuentra su receta por el código; otra clínica no la ve (RLS)', async () => {
    const rx = await issueIn(a);
    const inA = await tenantContext.run(a.tenantId, () =>
      repo.findByVerificationCode(rx.verificationCode),
    );
    expect(inA?.id).toBe(rx.id);
    expect(inA?.locationFormat).toEqual({
      timeZone: 'America/Caracas',
      locale: 'es-VE',
      hourCycle: 'h23',
    });
    const inB = await tenantContext.run(b.tenantId, () =>
      repo.findByVerificationCode(rx.verificationCode),
    );
    expect(inB).toBeNull();
    // Ni siquiera con un SELECT directo como la app en la clínica B.
    const rows = await prisma.runWithTenant(b.tenantId, (tx) =>
      tx.prescription.count({
        where: { verificationCode: rx.verificationCode },
      }),
    );
    expect(rows).toBe(0);
  });

  it('único por clínica: el mismo código en otra clínica sí; dos veces en la misma, no', async () => {
    const rx = await issueIn(a);
    const spy = jest
      .spyOn(verification, 'generatePrescriptionVerificationCode')
      .mockReturnValueOnce(rx.verificationCode);
    const inB = await issueIn(b);
    expect(inB.verificationCode).toBe(rx.verificationCode);

    // En la misma clínica: el repositorio reintenta con otro código.
    spy
      .mockReturnValueOnce(rx.verificationCode)
      .mockReturnValueOnce('ZZZZ2222ZZZZ');
    const retried = await issueIn(a);
    expect(retried.verificationCode).toBe('ZZZZ2222ZZZZ');
    expect(spy).toHaveBeenCalledTimes(3);

    // Y la base lo impide aunque se escriba a mano.
    const c = content(a);
    await expect(
      prisma.runWithTenant(a.tenantId, (tx) =>
        tx.prescription.create({
          data: {
            ...c,
            tenantId: a.tenantId,
            dispensationDate: new Date('2026-11-06T00:00:00.000Z'),
            validUntil: new Date('2026-12-05T00:00:00.000Z'),
            clinicFiscal: Prisma.DbNull,
            allergyMatches: [],
            safetyAlerts: [],
            contentHash: 'a'.repeat(64),
            verificationCode: rx.verificationCode,
            items: { create: c.items },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('el CHECK solo admite el alfabeto; sin código, la BD pone uno (réplica anterior)', async () => {
    const c = content(a);
    const base = {
      ...c,
      tenantId: a.tenantId,
      dispensationDate: new Date('2026-11-06T00:00:00.000Z'),
      validUntil: new Date('2026-12-05T00:00:00.000Z'),
      clinicFiscal: Prisma.DbNull,
      allergyMatches: [],
      safetyAlerts: [],
      contentHash: 'a'.repeat(64),
      items: { create: c.items },
    };
    for (const bad of ['K7M2P9QRT4X0', 'k7m2p9qrt4xw', 'K7M2P9QRT4X']) {
      await expect(
        prisma.runWithTenant(a.tenantId, (tx) =>
          tx.prescription.create({ data: { ...base, verificationCode: bad } }),
        ),
      ).rejects.toThrow(/prescriptions_verification_code_format_check/);
    }
    const legacyReplica = await prisma.runWithTenant(a.tenantId, (tx) =>
      tx.prescription.create({ data: base }),
    );
    expect(legacyReplica.verificationCode).toMatch(CODE);
  });

  it('el código es inmutable, también como owner; anular sigue funcionando y lo conserva', async () => {
    const rx = await issueIn(a);
    await expect(
      prisma.runWithTenant(a.tenantId, (tx) =>
        tx.prescription.update({
          where: { id: rx.id },
          data: { verificationCode: 'ZZZZ3333ZZZZ' },
        }),
      ),
    ).rejects.toThrow(/inmutable/);
    await expect(
      raw.prescription.update({
        where: { id: rx.id },
        data: { verificationCode: 'ZZZZ3333ZZZZ' },
      }),
    ).rejects.toThrow(/inmutable/);
    const voided = await tenantContext.run(a.tenantId, () =>
      repo.void(rx.id, {
        voidedById: a.userId,
        voidedAt: new Date(),
        reason: 'Error',
      }),
    );
    expect(voided).toMatchObject({
      kind: 'VOIDED',
      prescription: { verificationCode: rx.verificationCode },
    });
  });

  it('cada verificación deja un VIEW de PRESCRIPTION sin actor, origen PUBLIC_LINK, con su motivo y el paciente', async () => {
    const rx = await issueIn(a);
    for (const state of ['VALID', 'VOIDED', 'UNVERIFIABLE'] as const) {
      await tenantContext.run(a.tenantId, () =>
        repo.recordPublicVerification({
          prescriptionId: rx.id,
          patientId: rx.patientId,
          locationId: rx.locationId,
          state,
          meta: { requestId: 'req-dx467', ip: '203.0.113.9', userAgent: 'UA' },
        }),
      );
    }
    const events = await raw.auditEvent.findMany({
      where: { tenantId: a.tenantId, resourceId: rx.id },
      orderBy: { occurredAt: 'asc' },
    });
    expect(
      events.map((e) => ({
        action: e.action,
        resourceType: e.resourceType,
        actorUserId: e.actorUserId,
        actorRole: e.actorRole,
        patientId: e.patientId,
        locationId: e.locationId,
        ip: e.ip,
        metadata: e.metadata,
      })),
    ).toEqual(
      [
        'PRESCRIPTION_VERIFIED',
        'PRESCRIPTION_VERIFIED_VOIDED',
        'PRESCRIPTION_INTEGRITY_MISMATCH',
      ].map((reason) => ({
        action: 'VIEW',
        resourceType: 'PRESCRIPTION',
        actorUserId: null,
        actorRole: null,
        patientId: a.patientId,
        locationId: a.locationId,
        ip: '203.0.113.9',
        metadata: { origin: 'PUBLIC_LINK', reason },
      })),
    );
    // Nada clínico ni el código en el evento.
    expect(JSON.stringify(events)).not.toMatch(
      new RegExp(`Amoxicilina|${rx.verificationCode}`),
    );
  });

  it('el CHECK de auditoría no admite otra lectura anónima de una receta', async () => {
    const rx = await issueIn(a);
    await expect(
      prisma.runWithTenant(a.tenantId, (tx) =>
        tx.auditEvent.create({
          data: {
            tenantId: a.tenantId,
            action: 'VIEW',
            resourceType: 'PRESCRIPTION',
            resourceId: rx.id,
            patientId: a.patientId,
            metadata: { origin: 'PUBLIC_LINK', reason: 'OTRA_COSA' },
          },
        }),
      ),
    ).rejects.toThrow(/audit_events_actor_check/);
    await expect(
      prisma.runWithTenant(a.tenantId, (tx) =>
        tx.auditEvent.create({
          data: {
            tenantId: a.tenantId,
            action: 'VIEW',
            resourceType: 'PRESCRIPTION',
            resourceId: rx.id,
            patientId: null,
            metadata: {
              origin: 'PUBLIC_LINK',
              reason: 'PRESCRIPTION_VERIFIED',
            },
          },
        }),
      ),
    ).rejects.toThrow(/audit_events_actor_check/);
  });
});

// La migración sobre recetas ya emitidas: una BD desechable recibe todas las
// migraciones ANTERIORES a DX-467, dos clínicas con recetas (una anulada),
// y después las de DX-467.
const DX467 = '20261127090000_dx467_prescription_verification_code';
const ROOT = join(__dirname, '..');

function urlFor(db: string): string {
  const url = new URL(process.env.DIRECT_URL as string);
  url.pathname = `/${db}`;
  return url.toString();
}

function migrateDeploy(dir: string, url: string): void {
  execFileSync(
    join(ROOT, 'node_modules/.bin/prisma'),
    ['migrate', 'deploy', '--schema', join(dir, 'schema.prisma')],
    {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
      stdio: 'pipe',
    },
  );
}

const T1 = '00000000-0000-4000-8000-0000000467a1';
const T2 = '00000000-0000-4000-8000-0000000467b1';
const L1 = '00000000-0000-4000-8000-0000000467a2';
const L2 = '00000000-0000-4000-8000-0000000467b2';
const P1 = '00000000-0000-4000-8000-0000000467a3';
const P2 = '00000000-0000-4000-8000-0000000467b3';
const U1 = '00000000-0000-4000-8000-000000046701';

describe('DX-467 · migración del código de verificación sobre recetas ya emitidas (int)', () => {
  const admin = new PrismaClient<Prisma.PrismaClientOptions>({
    datasources: { db: { url: process.env.DIRECT_URL } },
  });
  let db: string;
  let dir: string;
  let target: PrismaClient;
  const before: { id: string; contentHash: string; status: string }[] = [];

  /** Receta única con valores fijos (SQL), como la emitía la app. */
  const rxSql = (
    tenant: string,
    location: string,
    patient: string,
    n: number,
  ) =>
    `WITH rx AS (
       INSERT INTO "prescriptions" ("id","tenantId","locationId","patientId","professionalId",
         "singleFormat","printQuantityInWords","issuedAt","dispensationDate","validUntil",
         "patientName","professionalName","professionalLicense","clinicName","locationName",
         "safetyRulesVersion","safetyAlerts","contentHash")
       VALUES (gen_random_uuid(),'${tenant}','${location}','${patient}','${U1}',
         true,false,now(),'2026-11-01','2026-11-30','Paciente ${n}','Dra. Prueba','RM-1',
         'Clínica','Sede','2026-10-24','[]'::jsonb,'${String(n % 10).repeat(64)}')
       RETURNING "id","tenantId")
     INSERT INTO "prescription_items" ("id","tenantId","prescriptionId","position",
       "activeIngredient","concentration","pharmaceuticalForm","route","dose","frequency",
       "durationDays","totalQuantity","quantityUnit","quantityInWords")
     SELECT gen_random_uuid(), rx."tenantId", rx."id", 1, 'Amoxicilina', '500 mg',
       'Cápsula', 'Oral', '1 cápsula', 'Cada 8 horas', 7, 21, 'cápsulas', 'veintiuno' FROM rx`;

  beforeAll(async () => {
    db = `dx467_mig_${process.pid}_${Date.now()}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${db}"`);
    dir = mkdtempSync(join(tmpdir(), 'dx467-'));
    cpSync(join(ROOT, 'prisma/schema.prisma'), join(dir, 'schema.prisma'));
    cpSync(
      join(ROOT, 'prisma/migrations/migration_lock.toml'),
      join(dir, 'migrations/migration_lock.toml'),
    );
    const copy = (name: string): void =>
      cpSync(
        join(ROOT, 'prisma/migrations', name),
        join(dir, 'migrations', name),
        { recursive: true },
      );
    const all = readdirSync(join(ROOT, 'prisma/migrations')).filter(
      (name) => !name.endsWith('.toml'),
    );
    for (const name of all.filter((n) => n < DX467)) copy(name);
    migrateDeploy(dir, urlFor(db));
    target = new PrismaClient<Prisma.PrismaClientOptions>({
      datasources: { db: { url: urlFor(db) } },
    });
    const seed = [
      `INSERT INTO "tenants" ("id","name","subdomain","updatedAt")
       VALUES ('${T1}','Clínica 1','dx467-1',now()),('${T2}','Clínica 2','dx467-2',now())`,
      `INSERT INTO "locations" ("id","tenantId","name","countryCode","updatedAt")
       VALUES ('${L1}','${T1}','Sede','VE',now()),('${L2}','${T2}','Sede','VE',now())`,
      `INSERT INTO "users" ("id","email","passwordHash","fullName","updatedAt")
       VALUES ('${U1}','dr@dx467.test','x','Dra. Prueba',now())`,
      `INSERT INTO "patients" ("id","tenantId","firstName","lastName","updatedAt")
       VALUES ('${P1}','${T1}','Paciente','Uno',now()),('${P2}','${T2}','Paciente','Dos',now())`,
    ];
    for (const sql of seed) await target.$executeRawUnsafe(sql);
    for (let n = 1; n <= 7; n += 1) {
      await target.$executeRawUnsafe(
        n % 2 ? rxSql(T1, L1, P1, n) : rxSql(T2, L2, P2, n),
      );
    }
    // Una anulada: el barrido también le pone código.
    await target.$executeRawUnsafe(
      `UPDATE "prescriptions" SET "status"='VOIDED', "voidedAt"=now(),
         "voidedById"='${U1}', "voidReason"='Error'
       WHERE "id" = (SELECT "id" FROM "prescriptions" ORDER BY "id" LIMIT 1)`,
    );
    before.push(
      ...(await target.$queryRaw<
        { id: string; contentHash: string; status: string }[]
      >`SELECT "id", "contentHash", "status"::text AS "status" FROM "prescriptions" ORDER BY "id"`),
    );
    for (const name of all.filter((n) => n >= DX467)) copy(name);
    migrateDeploy(dir, urlFor(db));
  }, 240_000);

  afterAll(async () => {
    await target?.$disconnect();
    await admin.$executeRawUnsafe(
      `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`,
    );
    rmSync(dir, { recursive: true, force: true });
    await admin.$disconnect();
  }, 60_000);

  it('toda receta anterior recibe su código (anuladas incluidas) y nada más cambia', async () => {
    const after = await target.$queryRaw<
      { id: string; contentHash: string; status: string; code: string }[]
    >`SELECT "id", "contentHash", "status"::text AS "status",
             "verificationCode" AS "code" FROM "prescriptions" ORDER BY "id"`;
    expect(after).toHaveLength(7);
    expect(after.map(({ code: _code, ...rest }) => rest)).toEqual(before);
    for (const row of after) expect(row.code).toMatch(CODE);
    expect(new Set(after.map((r) => r.code)).size).toBe(7);
    expect(after.some((r) => r.status === 'VOIDED')).toBe(true);
  });

  it('deja la columna NOT NULL, el CHECK y el índice único (tenantId, código) validados', async () => {
    const [column] = await target.$queryRaw<{ nullable: string }[]>`
      SELECT is_nullable AS "nullable" FROM information_schema.columns
       WHERE table_name = 'prescriptions' AND column_name = 'verificationCode'`;
    expect(column.nullable).toBe('NO');
    const constraints = await target.$queryRaw<
      { name: string; validated: boolean }[]
    >`SELECT conname AS "name", convalidated AS "validated" FROM pg_constraint
       WHERE conrelid IN ('prescriptions'::regclass, 'audit_events'::regclass)
         AND conname IN ('prescriptions_verification_code_format_check',
                         'prescriptions_verification_code_present_check',
                         'audit_events_actor_check')
       ORDER BY conname`;
    expect(constraints).toEqual([
      { name: 'audit_events_actor_check', validated: true },
      { name: 'prescriptions_verification_code_format_check', validated: true },
    ]);
    const [index] = await target.$queryRaw<{ def: string; valid: boolean }[]>`
      SELECT pg_get_indexdef(i.indexrelid) AS "def", i.indisvalid AS "valid"
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relname = 'prescriptions_tenant_verification_code_key'`;
    expect(index.valid).toBe(true);
    expect(index.def).toContain('UNIQUE');
    expect(index.def).toContain('("tenantId", "verificationCode")');
  });

  it('una réplica anterior que inserta sin el código recibe uno de la BD', async () => {
    await target.$executeRawUnsafe(rxSql(T1, L1, P1, 8));
    const [row] = await target.$queryRaw<{ code: string }[]>`
      SELECT "verificationCode" AS "code" FROM "prescriptions"
       WHERE "patientName" = 'Paciente 8'`;
    expect(row.code).toMatch(CODE);
  });

  it('tras el barrido, el código ya no se puede cambiar ni quitar', async () => {
    await expect(
      target.$executeRawUnsafe(
        `UPDATE "prescriptions" SET "verificationCode" = 'ZZZZ4444ZZZZ'
          WHERE "patientName" = 'Paciente 2'`,
      ),
    ).rejects.toThrow(/inmutable/);
    await expect(
      target.$executeRawUnsafe(
        `UPDATE "prescriptions" SET "verificationCode" = NULL
          WHERE "patientName" = 'Paciente 2'`,
      ),
    ).rejects.toThrow(/inmutable/);
  });

  it('el generador de la BD usa el mismo alfabeto y largo que la API', async () => {
    const codes = await target.$queryRaw<{ code: string }[]>`
      SELECT public.prescription_verification_code() AS "code"
        FROM generate_series(1, 300)`;
    const seen = new Set<string>();
    for (const { code } of codes) {
      expect(code).toMatch(CODE);
      expect(code).toHaveLength(
        verification.PRESCRIPTION_VERIFICATION_CODE_LENGTH,
      );
      for (const c of code) seen.add(c);
    }
    expect([...seen].sort().join('')).toBe(
      verification.PRESCRIPTION_VERIFICATION_ALPHABET,
    );
    expect(new Set(codes.map((c) => c.code)).size).toBe(300);
  });
});
