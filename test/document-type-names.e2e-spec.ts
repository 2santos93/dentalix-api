import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import {
  Clinic,
  SEEDED_PASSWORD,
  loginAs,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import {
  REGIONAL_TOKYO_FIXTURE,
  registerBody,
} from './support/location-fixtures';
import { registerVerified } from './support/register-verified';
import { hostFor } from './support/tenant-host';
import { DOCUMENT_TYPE_NAMES_FORBIDDEN_MESSAGE } from '../src/modules/patients/domain/document-type-names';

// DX-327 (R16) en HTTP real: el nombre local de cada tipo de documento lo
// leen todos los roles y solo el ADMIN lo cambia; toda clínica empieza sin
// ninguno; el PUT sustituye los cinco; la ambigüedad es 400 sin cambios;
// cada cambio real queda en la auditoría con los tipos cambiados y sin los
// valores; no afecta a otra clínica; la ruta no la tapa `:id`. Las sedes son
// REGIONAL_TOKYO_FIXTURE: el país de la sede lo obliga el enum hasta DX-312;
// no decide nada.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const NAMES = '/api/v1/patients/document-type-names';

type Names = Record<
  'NATIONAL_ID' | 'PASSPORT' | 'RESIDENCE_PERMIT' | 'TAX_ID' | 'OTHER',
  string | null
>;

const NONE: Names = {
  NATIONAL_ID: null,
  PASSPORT: null,
  RESIDENCE_PERMIT: null,
  TAX_ID: null,
  OTHER: null,
};

interface AuditItem {
  action: string;
  resourceType: string;
  resourceId: string | null;
  patient: unknown;
  actor: { role: string } | null;
  metadata: {
    reason?: string;
    changedFields?: string[];
    statusChange?: unknown;
  };
}

describe('Nombre local de cada tipo de documento (e2e, DX-327)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  const tokens = {} as Record<ClinicRole, string>;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string, host = clinic.host) =>
    req.set('X-Tenant-Host', host).set('Authorization', `Bearer ${token}`);
  const put = (body: unknown, token = tokens.ADMIN, host = clinic.host) =>
    as(api().put(NAMES), token, host).send(body as object);
  const names = async (token = tokens.ADMIN, host = clinic.host) =>
    (
      (await as(api().get(NAMES), token, host).expect(200)).body as {
        names: Names;
      }
    ).names;
  const settingsEvents = async (
    token = tokens.ADMIN,
    host = clinic.host,
  ): Promise<AuditItem[]> =>
    (
      (
        await as(
          api().get('/api/v1/audit-events?resourceType=CLINIC_SETTINGS'),
          token,
          host,
        ).expect(200)
      ).body as { items: AuditItem[] }
    ).items.filter((e) => e.metadata.reason === 'DOCUMENT_TYPE_NAMES_SETTINGS');

  async function register(subdomain: string): Promise<Clinic> {
    const email = `owner@${subdomain}.test`;
    const res = await registerVerified(
      app,
      registerBody(REGIONAL_TOKYO_FIXTURE, {
        clinicName: `Clinica ${subdomain}`,
        subdomain,
        email,
        password: SEEDED_PASSWORD,
        fullName: 'Dr. Owner',
      }),
    );
    const { tenantId, userId } = res.body as {
      tenantId: string;
      userId: string;
    };
    const host = hostFor(subdomain);
    return {
      tenantId,
      adminUserId: userId,
      subdomain,
      host,
      adminToken: await loginAs(app, host, email),
    };
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await register('dx327-names');
    other = await register('dx327-names-otra');
    tokens.ADMIN = clinic.adminToken;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
      ClinicRole.RECEPTION,
    ]) {
      const member = await seedMember(raw, clinic, role);
      tokens[role] = await loginAs(app, clinic.host, member.email);
    }
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('every clinic starts with no local names', async () => {
    // Clínicas nuevas por el alta de la API; la demo lo comprueba
    // seed-demo.int-spec (pre-flight M18).
    expect(await names()).toStrictEqual(NONE);
    expect(await names(other.adminToken, other.host)).toStrictEqual(NONE);
    const rows = await raw.tenant.findMany({
      where: { id: { in: [clinic.tenantId, other.tenantId] } },
      select: {
        docTypeNameNationalId: true,
        docTypeNamePassport: true,
        docTypeNameResidencePermit: true,
        docTypeNameTaxId: true,
        docTypeNameOther: true,
      },
    });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(Object.values(row)).toEqual([null, null, null, null, null]);
    }
  });

  it('GET /patients/document-type-names is not shadowed by GET /patients/:id', async () => {
    // Con `:id` delante, iría a la ficha de un paciente «document-type-names»:
    // 404, o una ficha y su VIEW de PATIENT. Se mira solo lo que deja ESTA
    // petición.
    const patientViews = () =>
      raw.auditEvent.count({
        where: {
          tenantId: clinic.tenantId,
          resourceType: 'PATIENT',
          action: 'VIEW',
        },
      });
    const viewsBefore = await patientViews();
    const res = await as(api().get(NAMES), tokens.RECEPTION).expect(200);
    expect(res.body).toStrictEqual({ names: NONE });
    expect(await patientViews()).toBe(viewsBefore);
  });

  it('ADMIN sets a local name per type; other roles read it and get 403 on PUT', async () => {
    const set: Names = {
      NATIONAL_ID: 'ID local',
      PASSPORT: 'Documento A',
      RESIDENCE_PERMIT: 'Documento B',
      TAX_ID: 'Documento C',
      OTHER: 'Documento D',
    };
    await put({ names: set }).expect(200).expect({ names: set });
    for (const role of [
      ClinicRole.RECEPTION,
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
    ]) {
      expect(await names(tokens[role])).toStrictEqual(set);
      const res = await put({ names: NONE }, tokens[role]).expect(403);
      expect((res.body as { message: string }).message).toBe(
        DOCUMENT_TYPE_NAMES_FORBIDDEN_MESSAGE,
      );
      expect(await names()).toStrictEqual(set);
    }
  });

  it('PUT replaces the five names; a missing key clears it', async () => {
    await put({ names: { NATIONAL_ID: '  ID   local ', TAX_ID: null } })
      .expect(200)
      .expect({ names: { ...NONE, NATIONAL_ID: 'ID local' } });
    expect(await names()).toStrictEqual({ ...NONE, NATIONAL_ID: 'ID local' });
    // Una clave desconocida la quita `whitelist`; un vacío es sin nombre.
    await put({ names: { NATIONAL_ID: 'ID local', OTHER: '   ', FOO: 'x' } })
      .expect(200)
      .expect({ names: { ...NONE, NATIONAL_ID: 'ID local' } });
    // Los 60 se cuentan tras recortar y juntar espacios: 60 caracteres con
    // relleno (más de 60 antes de recortar) se guardan.
    const sixty = 'a'.repeat(30) + ' ' + 'b'.repeat(29);
    await put({
      names: {
        NATIONAL_ID: 'ID local',
        OTHER: `   ${sixty.replace(' ', '    ')}  `,
      },
    })
      .expect(200)
      .expect({ names: { ...NONE, NATIONAL_ID: 'ID local', OTHER: sixty } });
    await put({ names: { NATIONAL_ID: 'ID local' } })
      .expect(200)
      .expect({ names: { ...NONE, NATIONAL_ID: 'ID local' } });
  });

  it('an ambiguous set is 400 with the message', async () => {
    const cases: [Partial<Names>, string][] = [
      [
        { NATIONAL_ID: 'Nombre Local', PASSPORT: 'nombre-local' },
        '“nombre-local” ya es el nombre de Documento nacional. Cada tipo necesita un nombre distinto.',
      ],
      [
        { TAX_ID: 'Documento A', OTHER: 'documento á' },
        '“documento á” ya es el nombre de Identificación fiscal. Cada tipo necesita un nombre distinto.',
      ],
      [
        { NATIONAL_ID: 'Pasaporte' },
        '“Pasaporte” es el nombre de Pasaporte. Elige otro.',
      ],
      [
        { OTHER: 'tax id' },
        '“tax id” es el nombre de Identificación fiscal. Elige otro.',
      ],
    ];
    for (const [body, message] of cases) {
      const res = await put({ names: body }).expect(400);
      expect((res.body as { message: string }).message).toBe(message);
      expect(await names()).toStrictEqual({ ...NONE, NATIONAL_ID: 'ID local' });
    }
    // El genérico del propio tipo sí vale.
    await put({ names: { NATIONAL_ID: 'ID local', PASSPORT: 'pasaporte' } })
      .expect(200)
      .expect({
        names: { ...NONE, NATIONAL_ID: 'ID local', PASSPORT: 'pasaporte' },
      });
  });

  it('a body without names is 400 and changes nothing', async () => {
    const before = await names();
    const eventsBefore = (await settingsEvents()).length;
    for (const body of [
      {},
      { names: null },
      { names: [] },
      { names: 'x' },
      { names: { NATIONAL_ID: 7 } },
      { names: { OTHER: 'a'.repeat(61) } },
      // Un sustituto suelto no es texto: 400, no un 500 de la BD.
      { names: { OTHER: 'a\ud800' } },
      { NATIONAL_ID: 'ID local' },
    ]) {
      const res = await put(body).expect(400);
      expect((res.body as { message: unknown }).message).toBeTruthy();
      expect(await names()).toStrictEqual(before);
    }
    expect((await settingsEvents()).length).toBe(eventsBefore);
  });

  it('local names in any script are saved and returned', async () => {
    const set: Names = {
      NATIONAL_ID: 'Документ А',
      PASSPORT: 'وثيقة أ',
      RESIDENCE_PERMIT: '文書A',
      TAX_ID: 'ドキュメント',
      OTHER: 'トキュメント',
    };
    await put({ names: set }).expect(200).expect({ names: set });
    expect(await names(tokens.DENTIST)).toStrictEqual(set);
    // Dos tipos con el mismo nombre en otra escritura (mayúsculas y
    // puntuación aparte) son ambiguos.
    const res = await put({
      names: { ...set, OTHER: 'документ-а' },
    }).expect(400);
    expect((res.body as { message: string }).message).toBe(
      '“документ-а” ya es el nombre de Documento nacional. Cada tipo necesita un nombre distinto.',
    );
    expect(await names()).toStrictEqual(set);
  });

  it('a name that is only punctuation is 400 with a clear message', async () => {
    const before = await names();
    for (const name of ['---', '★']) {
      const res = await put({ names: { NATIONAL_ID: name } }).expect(400);
      expect((res.body as { message: string }).message).toBe(
        'El nombre necesita al menos una letra o un número.',
      );
    }
    expect(await names()).toStrictEqual(before);
  });

  it('a letter-prefix name can be configured', async () => {
    // Es decisión de la clínica (R19): nada lo pone por defecto.
    await put({ names: { NATIONAL_ID: 'V' } })
      .expect(200)
      .expect({ names: { ...NONE, NATIONAL_ID: 'V' } });
  });

  it('a local name is audited as CLINIC_SETTINGS with DOCUMENT_TYPE_NAMES_SETTINGS and the changed types, without values', async () => {
    // Solo cuenta lo que dejan las peticiones de este test: parte de un
    // estado conocido y mira los eventos nuevos.
    await put({ names: { NATIONAL_ID: 'V' } }).expect(200);
    const before = (await settingsEvents()).length;
    // Sin cambios: 200 sin evento.
    await put({ names: { NATIONAL_ID: ' V ' } }).expect(200);
    expect((await settingsEvents()).length).toBe(before);
    await put({
      names: { NATIONAL_ID: 'V', OTHER: 'ID local', PASSPORT: 'Documento A' },
    }).expect(200);
    await put({ names: { NATIONAL_ID: 'V', OTHER: 'ID local' } }).expect(200);
    const all = await settingsEvents();
    const events = all.slice(0, all.length - before);
    // Más reciente primero; la auditoría guarda los campos ordenados.
    expect(events.map((e) => e.metadata.changedFields)).toEqual([
      ['PASSPORT'],
      ['OTHER', 'PASSPORT'],
    ]);
    for (const event of events) {
      expect(event).toMatchObject({
        action: 'UPDATE',
        resourceType: 'CLINIC_SETTINGS',
        resourceId: null,
        patient: null,
        actor: { role: 'ADMIN' },
        metadata: { reason: 'DOCUMENT_TYPE_NAMES_SETTINGS' },
      });
      expect(event.metadata.statusChange).toBeUndefined();
    }
    const stored = JSON.stringify(
      await raw.auditEvent.findMany({
        where: { tenantId: clinic.tenantId, resourceType: 'CLINIC_SETTINGS' },
      }),
    );
    for (const value of ['ID local', 'Documento A', 'Документ А', '文書A']) {
      expect(stored).not.toContain(value);
    }
  });

  it("a clinic's local names are invisible to another clinic", async () => {
    // La otra clínica pone su propio valor y cada una ve solo el suyo.
    await put(
      { names: { TAX_ID: 'Documento X' } },
      other.adminToken,
      other.host,
    ).expect(200);
    expect(await names(other.adminToken, other.host)).toStrictEqual({
      ...NONE,
      TAX_ID: 'Documento X',
    });
    expect(await names()).toStrictEqual({
      ...NONE,
      NATIONAL_ID: 'V',
      OTHER: 'ID local',
    });
    // Un token de una clínica no sirve en el host de la otra.
    await as(api().get(NAMES), tokens.ADMIN, other.host).expect((res) =>
      expect([401, 403]).toContain(res.status),
    );
    // Cada una ve solo sus eventos.
    const foreign = await settingsEvents(other.adminToken, other.host);
    expect(foreign.map((e) => e.metadata.changedFields)).toEqual([['TAX_ID']]);
  });
});
