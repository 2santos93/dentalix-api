import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import {
  PHONE_CATEGORIES,
  classifyPhone,
  phonesReport,
  readOnlyBatch,
  type PhonesReport,
} from '../prisma/scripts/phones-report';
import { REGIONAL_BOGOTA_FIXTURE } from './support/location-fixtures';

/**
 * DX-329 (spec §4.6, P2): el informe de los teléfonos guardados que no
 * encajan. Solo lee, clínica a clínica y por lotes, con el rol de la app; las
 * filas se siembran por SQL directo, que es lo que el informe lee. Nunca
 * imprime un número completo ni un nombre.
 */
const run = promisify(execFile);
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const prisma = new PrismaService(new TenantContextService());

const CLINICS = {
  ve: 'dx329-phones-ve',
  co: 'dx329-phones-co',
  none: 'dx329-phones-none',
  ar: 'dx329-phones-ar',
  multi: 'dx329-phones-multi',
  batch: 'dx329-phones-batch',
};
const SUBDOMAINS = Object.values(CLINICS);
const NAME = 'Zuleima';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  if (ids.length === 0) return;
  const where = Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`));
  await raw.$executeRaw`DELETE FROM "patient_responsible_parties" WHERE "tenantId" IN (${where})`;
  await raw.$executeRaw`DELETE FROM "patients" WHERE "tenantId" IN (${where})`;
  await raw.$executeRaw`DELETE FROM "locations" WHERE "tenantId" IN (${where})`;
  await raw.$executeRaw`DELETE FROM "tenants" WHERE "id" IN (${where})`;
}

async function tenant(subdomain: string): Promise<string> {
  const [row] = await raw.$queryRaw<{ id: string }[]>`
    INSERT INTO "tenants" ("id", "name", "subdomain", "updatedAt")
    VALUES (gen_random_uuid(), ${subdomain}, ${subdomain}, now())
    RETURNING "id"`;
  return row.id;
}

/** Una sede con su región (dato del test) y su teléfono; `minutes` ordena la principal. */
async function location(
  tenantId: string,
  region: string | null,
  phone: string | null,
  minutes: number,
  deleted = false,
): Promise<string> {
  const f = REGIONAL_BOGOTA_FIXTURE;
  const [row] = await raw.$queryRaw<{ id: string }[]>`
    INSERT INTO "locations" ("id", "tenantId", "name", "countryCode", "currency",
      "timeZone", "locale", "hourCycle", "defaultPhoneRegion", "phone",
      "createdAt", "deletedAt", "updatedAt")
    VALUES (gen_random_uuid(), ${tenantId}::uuid, ${`Sede ${minutes}`},
      ${f.country}, ${f.currency}, ${f.timeZone}, ${f.locale}, ${f.hourCycle},
      ${region}, ${phone}, now() - make_interval(mins => ${100 - minutes}::int),
      ${deleted ? new Date() : null}, now())
    RETURNING "id"`;
  return row.id;
}

interface PatientPhones {
  phone?: string | null;
  emergencyContactPhone?: string | null;
  physicianPhone?: string | null;
  contactChannel?: 'EMAIL' | 'WHATSAPP';
  whatsappOptIn?: boolean;
  deleted?: boolean;
}

async function patient(tenantId: string, p: PatientPhones): Promise<string> {
  const [row] = await raw.$queryRaw<{ id: string }[]>`
    INSERT INTO "patients" ("id", "tenantId", "firstName", "lastName", "phone",
      "emergencyContactPhone", "physicianPhone", "contactChannel",
      "whatsappOptInAt", "whatsappOptInSource", "deletedAt", "updatedAt")
    VALUES (gen_random_uuid(), ${tenantId}::uuid, ${NAME}, 'Informe',
      ${p.phone ?? null}, ${p.emergencyContactPhone ?? null},
      ${p.physicianPhone ?? null},
      ${p.contactChannel ?? 'EMAIL'}::"ContactChannel",
      ${p.whatsappOptIn ? new Date() : null},
      ${p.whatsappOptIn ? 'IN_PERSON' : null}::"WhatsappOptInSource",
      ${p.deleted ? new Date() : null},
      now())
    RETURNING "id"`;
  return row.id;
}

async function responsible(
  tenantId: string,
  patientId: string,
  phone: string,
): Promise<string> {
  const [row] = await raw.$queryRaw<{ id: string }[]>`
    INSERT INTO "patient_responsible_parties" ("id", "tenantId", "patientId",
      "fullName", "phone", "relationship", "updatedAt")
    VALUES (gen_random_uuid(), ${tenantId}::uuid, ${patientId}::uuid,
      ${`${NAME} Responsable`}, ${phone}, 'MOTHER', now())
    RETURNING "id"`;
  return row.id;
}

/** `npm run phones:report`, con o sin `--detail`. */
function runScript(...args: string[]) {
  return run(
    process.execPath,
    [
      'node_modules/.bin/ts-node',
      '--transpile-only',
      'prisma/scripts/phones-report.ts',
      ...args,
    ],
    { env: process.env, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
  );
}

/** Huella de los cinco campos de teléfono y recuentos de sus tablas. */
async function fingerprint(): Promise<unknown> {
  return raw.$queryRaw`
    SELECT
      (SELECT md5(coalesce(string_agg(concat_ws('|', "phone",
         "emergencyContactPhone", "physicianPhone"), ',' ORDER BY "id"), ''))
         FROM "patients") AS "patients",
      (SELECT count(*)::int FROM "patients") AS "patientCount",
      (SELECT md5(coalesce(string_agg(coalesce("phone", ''), ',' ORDER BY "id"), ''))
         FROM "patient_responsible_parties") AS "responsibles",
      (SELECT count(*)::int FROM "patient_responsible_parties") AS "responsibleCount",
      (SELECT md5(coalesce(string_agg(coalesce("phone", ''), ',' ORDER BY "id"), ''))
         FROM "locations") AS "locations",
      (SELECT count(*)::int FROM "locations") AS "locationCount"`;
}

describe('phones:report (int, DX-329 §4.6)', () => {
  const tenants: Record<keyof typeof CLINICS, string> = {
    ve: '',
    co: '',
    none: '',
    ar: '',
    multi: '',
    batch: '',
  };
  const ids: Record<string, string> = {};
  let report: PhonesReport;

  const clinic = (key: keyof typeof CLINICS) => {
    const found = report.clinics.find((c) => c.subdomain === CLINICS[key]);
    if (!found) throw new Error(`sin informe de ${key}`);
    return found;
  };
  const detail = (id: string, field = 'phone') =>
    report.details.find((d) => d.id === id && d.field === field);

  beforeAll(async () => {
    await cleanup();
    for (const key of Object.keys(CLINICS) as (keyof typeof CLINICS)[]) {
      tenants[key] = await tenant(CLINICS[key]);
    }

    // VE: una región.
    ids.veLocation = await location(tenants.ve, 'VE', '0212-5551234', 1);
    ids.e164Valid = await patient(tenants.ve, { phone: '+58 412 1234567' });
    ids.wrongCode = await patient(tenants.ve, { phone: '+574121234567' });
    ids.mx = await patient(tenants.ve, { phone: '+52 1 55 1234 5678' });
    ids.nationalValid = await patient(tenants.ve, {
      phone: '0412-1234567',
      deleted: true,
    });
    ids.extension = await patient(tenants.ve, {
      phone: '0212-5551234 ext 3',
    });
    ids.whatsappLandline = await patient(tenants.ve, {
      phone: '0212-5551234',
      contactChannel: 'WHATSAPP',
    });
    ids.responsible = await responsible(
      tenants.ve,
      ids.e164Valid,
      '0414-1234567',
    );

    // Sin región: la única sede con región está borrada.
    await location(tenants.none, null, null, 1);
    await location(tenants.none, 'VE', null, 2, true);
    ids.noRegion = await patient(tenants.none, { phone: '0412-1234567' });

    // CO.
    await location(tenants.co, 'CO', null, 1);
    ids.ambiguous = await patient(tenants.co, {
      emergencyContactPhone: '0058 412 1234567',
    });
    ids.nationalInvalid = await patient(tenants.co, {
      physicianPhone: '0412-1234567',
    });
    ids.optInStrayZero = await patient(tenants.co, {
      phone: '03211234567',
      whatsappOptIn: true,
    });
    ids.coMobile = await patient(tenants.co, { phone: '310 555 0101' });

    // AR.
    await location(tenants.ar, 'AR', null, 1);
    ids.arMobile = await patient(tenants.ar, { phone: '011 15-2345-6789' });

    // Dos regiones: la principal es VE.
    ids.multiVe = await location(tenants.multi, 'VE', '0412-1234567', 1);
    ids.multiCo = await location(tenants.multi, 'CO', '0212-5551234', 2);
    ids.multiCoPatient = await patient(tenants.multi, {
      phone: '310 555 0101',
    });
    ids.multiVePatient = await patient(tenants.multi, {
      phone: '0412-1234567',
    });

    // Lotes: cinco pacientes.
    await location(tenants.batch, 'VE', null, 1);
    for (let i = 0; i < 5; i += 1) {
      await patient(tenants.batch, { phone: `+58 412 123456${i}` });
    }

    report = await phonesReport(prisma, { batchSize: 2 });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
    await raw.$disconnect();
  });

  it('the report classifies every stored phone in the spec order', () => {
    expect(PHONE_CATEGORIES).toEqual([
      'E164_VALID',
      'E164_PROBABLE_WRONG_CODE',
      'E164_INVALID',
      'NATIONAL_NO_REGION',
      'NATIONAL_AMBIGUOUS',
      'NATIONAL_VALID',
      'NATIONAL_INVALID',
    ]);
    // `+57 412…` en una clínica VE: la propuesta es el mismo número con +58.
    expect(classifyPhone('+574121234567', ['VE'])).toEqual({
      category: 'E164_PROBABLE_WRONG_CODE',
      proposal: '+584121234567',
      extension: false,
    });
    expect(detail(ids.wrongCode)).toMatchObject({
      resource: 'patients',
      category: 'E164_PROBABLE_WRONG_CODE',
      phone: '***4567',
      proposal: '+58 ***4567',
    });
    // MX `+52 1 55…`: sin el 52 queda `155…`, que no es válido (m3).
    expect(classifyPhone('+52 1 55 1234 5678', ['VE'])).toEqual({
      category: 'E164_INVALID',
      proposal: null,
      extension: false,
    });
    expect(detail(ids.mx)).toMatchObject({
      category: 'E164_INVALID',
      proposal: null,
    });
    expect(detail(ids.noRegion)?.category).toBe('NATIONAL_NO_REGION');
    expect(classifyPhone('0058 412 1234567', ['CO']).category).toBe(
      'NATIONAL_AMBIGUOUS',
    );
    expect(detail(ids.ambiguous, 'emergencyContactPhone')).toMatchObject({
      category: 'NATIONAL_AMBIGUOUS',
    });
    expect(detail(ids.nationalInvalid, 'physicianPhone')).toMatchObject({
      category: 'NATIONAL_INVALID',
    });
    // Los válidos sin bandera no van al detalle; los recuentos sí los ven.
    expect(detail(ids.e164Valid)).toBeUndefined();
    expect(detail(ids.nationalValid)).toBeUndefined();
    expect(clinic('ve').counts).toEqual({
      'patients.phone': {
        E164_VALID: 1,
        E164_PROBABLE_WRONG_CODE: 1,
        E164_INVALID: 1,
        NATIONAL_VALID: 3,
      },
      'patients.emergencyContactPhone': {},
      'patients.physicianPhone': {},
      'patient_responsible_parties.phone': { NATIONAL_VALID: 1 },
      'locations.phone': { NATIONAL_VALID: 1 },
    });
    expect(clinic('none').counts['patients.phone']).toEqual({
      NATIONAL_NO_REGION: 1,
    });
    expect(clinic('co').counts).toMatchObject({
      'patients.emergencyContactPhone': { NATIONAL_AMBIGUOUS: 1 },
      'patients.physicianPhone': { NATIONAL_INVALID: 1 },
    });
    // Una extensión se cuenta aparte; la regla anterior no la leía.
    expect(detail(ids.extension)).toMatchObject({
      category: 'NATIONAL_VALID',
      flags: ['CHANGED_SINCE_DX329', 'HAS_EXTENSION'],
    });
    expect(clinic('ve').flags.HAS_EXTENSION).toBe(1);
  });

  it('the report flags WhatsApp patients whose number is valid but no longer a mobile', async () => {
    expect(detail(ids.whatsappLandline)).toMatchObject({
      category: 'NATIONAL_VALID',
      flags: expect.arrayContaining(['WHATSAPP_NOT_MOBILE']) as string[],
    });
    expect(detail(ids.optInStrayZero)).toMatchObject({
      category: 'NATIONAL_INVALID',
      flags: expect.arrayContaining([
        'WHATSAPP_NOT_MOBILE',
        'CHANGED_SINCE_DX329',
      ]) as string[],
    });
    expect(clinic('ve').flags.WHATSAPP_NOT_MOBILE).toBe(1);
    expect(clinic('co').flags.WHATSAPP_NOT_MOBILE).toBe(1);

    const { stdout } = await runScript('--detail');
    const line = (id: string) =>
      stdout.split('\n').find((l) => l.includes(id)) ?? '';
    expect(line(ids.whatsappLandline)).toMatch(
      /,NATIONAL_VALID,[^,]*WHATSAPP_NOT_MOBILE/,
    );
    expect(line(ids.optInStrayZero)).toMatch(
      /,NATIONAL_INVALID,[^,]*WHATSAPP_NOT_MOBILE/,
    );
    const json = stdout
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l) as { subdomain?: string; flags?: object })
      .find((l) => l.subdomain === CLINICS.ve);
    expect(json?.flags).toMatchObject({ WHATSAPP_NOT_MOBILE: 1 });
  }, 120_000);

  it('CHANGED_SINCE_DX329 compares the old and new mobile status and E.164', () => {
    // AR `011 15…`: móvil antes y después, pero el E.164 anterior no tenía el 9.
    expect(detail(ids.arMobile)).toMatchObject({
      category: 'NATIONAL_VALID',
      flags: ['CHANGED_SINCE_DX329'],
    });
    // Un `0` espurio: antes móvil válido, ahora no vale.
    expect(detail(ids.optInStrayZero)?.flags).toContain('CHANGED_SINCE_DX329');
    // Un fijo VE con WhatsApp: el E.164 coincide, el estado de móvil no.
    expect(detail(ids.whatsappLandline)?.flags).toContain(
      'CHANGED_SINCE_DX329',
    );
    // `310 555 0101` en CO: igual con las dos reglas.
    expect(detail(ids.coMobile)).toBeUndefined();
    expect(clinic('co').flags.CHANGED_SINCE_DX329).toBe(1);
    expect(clinic('ar').flags.CHANGED_SINCE_DX329).toBe(1);
  });

  it("a location phone is read with that location's own region", () => {
    // `0212-5551234` vale en VE, la otra sede, pero no en CO, la suya.
    expect(detail(ids.multiCo)).toMatchObject({
      resource: 'locations',
      field: 'phone',
      category: 'NATIONAL_INVALID',
    });
    expect(detail(ids.multiVe)).toBeUndefined();
    expect(clinic('multi').counts['locations.phone']).toEqual({
      NATIONAL_VALID: 1,
      NATIONAL_INVALID: 1,
    });
    expect(clinic('ve').counts['locations.phone']).toEqual({
      NATIONAL_VALID: 1,
    });
  });

  it('in a multi-region clinic a national number is valid if any live region reads it', () => {
    expect(clinic('multi').counts['patients.phone']).toEqual({
      NATIONAL_VALID: 2,
    });
    // Con la región de la principal (VE) ya no es un móvil: se marca, pero
    // la categoría sale de cualquier región viva.
    expect(detail(ids.multiCoPatient)).toMatchObject({
      category: 'NATIONAL_VALID',
      flags: ['CHANGED_SINCE_DX329'],
    });
    expect(detail(ids.multiVePatient)).toBeUndefined();
  });

  it('the report counts locations with different regions as multiRegion', () => {
    expect(clinic('multi').multiRegion).toBe(true);
    expect(clinic('ve').multiRegion).toBe(false);
    // Una sede borrada no cuenta.
    expect(clinic('none').multiRegion).toBe(false);
  });

  it('the report reads in batches', () => {
    expect(clinic('batch').counts['patients.phone']).toEqual({
      E164_VALID: 5,
    });
    // 5 pacientes de 2 en 2: tres lotes, más los de las otras tablas.
    expect(clinic('batch').batches).toBeGreaterThanOrEqual(3);
  });

  it('the report writes nothing', async () => {
    const before = await fingerprint();
    await phonesReport(prisma, { batchSize: 2 });
    await runScript();
    await runScript('--detail');
    expect(await fingerprint()).toEqual(before);

    const write = readOnlyBatch(
      prisma,
      tenants.ve,
      (tx) =>
        tx.$executeRaw`UPDATE "patients" SET "phone" = "phone" WHERE "tenantId" = ${tenants.ve}::uuid`,
    );
    await expect(write).rejects.toMatchObject({
      meta: expect.objectContaining({ code: '25006' }) as object,
    });
  }, 240_000);

  it('the report never prints a full number', async () => {
    for (const args of [[], ['--detail']]) {
      const { stdout, stderr } = await runScript(...args);
      const lines = stdout.split('\n').filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line.replace(UUID, '')).not.toMatch(/\d{6,}/);
        expect(line).not.toContain(NAME);
      }
      expect(stderr.replace(UUID, '')).not.toMatch(/\d{6,}/);
    }
  }, 240_000);
});
