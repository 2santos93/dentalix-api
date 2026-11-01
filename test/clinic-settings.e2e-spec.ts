import { INestApplication } from '@nestjs/common';
import { CatalogKind, ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import {
  type Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import { CLINIC_SETTINGS_FORBIDDEN_MESSAGE } from '../src/modules/clinic-settings/presentation/clinic-settings.controller';
import { CLINIC_SETTINGS_MESSAGES } from '../src/modules/clinic-settings/domain/clinic-settings';
import { LOGO_MESSAGES } from '../src/modules/clinic-settings/domain/logo-image';
import {
  JPEG_WITH_EXIF,
  makePng,
  pngChunk,
} from '../src/modules/clinic-settings/__fixtures__/logo-fixtures';

// DX-019 en HTTP real: Ajustes › Datos de la clínica. Solo ADMIN edita; cada
// cambio queda en la auditoría con el antes y el después (sin cambio, sin
// evento); solo toca la clínica propia; la marca pública cambia al momento;
// el logo se valida por sus bytes y se re-escribe; el recibo congela los
// datos fiscales (con el nombre propio del identificador) y, sin ellos, dice
// «Datos fiscales pendientes»; presupuesto y estado de cuenta los imprimen.

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface SettingsBody {
  name: string;
  legalName: string | null;
  taxId: string | null;
  taxIdLabel: string | null;
  fiscalAddress: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  primaryColor: string;
  logoUrl: string | null;
  fiscalDataPending: boolean;
}

const HEX_COLOR: unknown = expect.stringMatching(/^#[0-9A-Fa-f]{6}$/);

const FISCAL = {
  legalName: 'Sonrisas Odontología S.A.',
  taxId: 'J-12345678-9',
  taxIdLabel: 'ID fiscal',
  fiscalAddress: 'Av. Principal 1, Torre Norte',
  contactEmail: 'hola@sonrisas.example',
  contactPhone: '+1 555 0100',
};

describe('Ajustes › Datos de la clínica (e2e, DX-019)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let receptionA: string;
  let dentistA: string;
  let assistantA: string;
  let patientA = '';
  let planA = '';

  const server = () => app.getHttpServer();
  const as = (clinic: Clinic, token = clinic.adminToken) => ({
    get: (path: string) =>
      request(server())
        .get(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) =>
      request(server())
        .post(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
    patch: (path: string, body: object) =>
      request(server())
        .patch(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
    delete: (path: string) =>
      request(server())
        .delete(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`),
    upload: (bytes: Buffer, filename: string, contentType: string) =>
      request(server())
        .post('/api/v1/clinic/settings/logo')
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`)
        .attach('file', bytes, { filename, contentType }),
  });
  const branding = (clinic: Clinic) =>
    request(server())
      .get('/api/v1/public/tenant/branding')
      .set('X-Tenant-Host', clinic.host);
  const auditOf = (reason: string) =>
    raw.auditEvent.findMany({
      where: {
        tenantId: a.tenantId,
        metadata: { path: ['reason'], equals: reason },
      },
      orderBy: { occurredAt: 'asc' },
    });
  /** El path servible del logo (lo que va después de FILES_PUBLIC_BASE_URL). */
  const logoPath = (url: string) =>
    `/api/v1/files/logos/${url.split('/files/logos/')[1]}`;

  async function pay(amount: number): Promise<string> {
    const res = await as(a, receptionA)
      .post(`/treatment-plans/${planA}/payments`, {
        amount,
        currency: 'COP',
        paidAt: new Date().toISOString(),
        method: 'CASH',
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }
  const snapshotOf = async (paymentId: string) =>
    (
      await raw.paymentReceipt.findUniqueOrThrow({
        where: { paymentId },
        select: { snapshot: true },
      })
    ).snapshot as {
      clinic: Record<string, unknown>;
      fiscalDataPending: boolean;
    };

  beforeAll(async () => {
    await resetDatabase(raw);
    app = await createE2eApp();
    a = await registerClinic(app, 'dx019-clinica-a');
    b = await registerClinic(app, 'dx019-clinica-b');
    receptionA = await loginAs(
      app,
      a.host,
      (await seedMember(raw, a, ClinicRole.RECEPTION)).email,
    );
    dentistA = await loginAs(
      app,
      a.host,
      (await seedMember(raw, a, ClinicRole.DENTIST)).email,
    );
    assistantA = await loginAs(
      app,
      a.host,
      (await seedMember(raw, a, ClinicRole.ASSISTANT)).email,
    );
    patientA = (
      (
        await as(a)
          .post('/patients', {
            firstName: 'Ana',
            lastName: 'Fiscal',
            docType: 'NATIONAL_ID',
            docNumber: 'DX019-A',
            sex: 'F',
          })
          .expect(201)
      ).body as { id: string }
    ).id;
    const item = (
      await as(a)
        .post('/catalog/items', {
          code: 'DX019-A',
          kind: CatalogKind.PROCEDURE,
          labelEs: 'Corona',
          color: '#2A2B3C',
          defaultPrice: 100_000,
        })
        .expect(201)
    ).body as { id: string };
    planA = (
      (
        await as(a)
          .post(`/patients/${patientA}/treatment-plans`, { currency: 'COP' })
          .expect(201)
      ).body as { id: string }
    ).id;
    const planItem = (
      await as(a)
        .post(`/treatment-plans/${planA}/items`, {
          toothNumber: '11',
          catalogItemId: item.id,
        })
        .expect(201)
    ).body as { id: string };
    await as(a)
      .patch(`/treatment-plans/${planA}/items/${planItem.id}`, {
        status: 'DONE',
      })
      .expect(200);
  });

  afterAll(async () => {
    await app.close();
    await resetDatabase(raw);
    await raw.$disconnect();
  });

  it('una clínica nueva: su nombre, sin datos fiscales (pendientes) y sin logo', async () => {
    const res = await as(a).get('/clinic/settings').expect(200);
    expect(res.body).toEqual({
      name: 'Clinica dx019-clinica-a',
      legalName: null,
      taxId: null,
      taxIdLabel: null,
      fiscalAddress: null,
      contactEmail: null,
      contactPhone: null,
      primaryColor: HEX_COLOR,
      logoUrl: null,
      fiscalDataPending: true,
    });
  });

  it('solo ADMIN: recepción, odontología y asistencia reciben 403 en español, sin cambiar nada', async () => {
    for (const token of [receptionA, dentistA, assistantA]) {
      for (const res of [
        await as(a, token).get('/clinic/settings'),
        await as(a, token).patch('/clinic/settings', { taxId: 'X' }),
        await as(a, token).upload(makePng(), 'logo.png', 'image/png'),
        await as(a, token).delete('/clinic/settings/logo'),
      ]) {
        expect(res.status).toBe(403);
        expect((res.body as { message: string }).message).toBe(
          CLINIC_SETTINGS_FORBIDDEN_MESSAGE,
        );
      }
    }
    const tenant = await raw.tenant.findUniqueOrThrow({
      where: { id: a.tenantId },
    });
    expect(tenant.taxId).toBeNull();
    expect(tenant.logoKey).toBeNull();
  });

  it('recibo emitido SIN datos fiscales: «pendientes» y la foto de siempre (sin nombre del identificador)', async () => {
    const paymentId = await pay(10_000);
    const snapshot = await snapshotOf(paymentId);
    expect(snapshot.fiscalDataPending).toBe(true);
    expect(snapshot.clinic).toEqual({
      name: 'Clinica dx019-clinica-a',
      legalName: null,
      taxId: null,
      address: null,
    });
    const receipt = await as(a, receptionA)
      .get(`/payments/${paymentId}/receipt`)
      .expect(200);
    expect(
      (receipt.body as { snapshot: { fiscalDataPending: boolean } }).snapshot
        .fiscalDataPending,
    ).toBe(true);
  });

  it('el ADMIN guarda nombre, datos fiscales libres (sin formato de país), contacto y color: auditado con antes y después', async () => {
    const res = await as(a)
      .patch('/clinic/settings', {
        name: '  Clínica Sonrisas  ',
        ...FISCAL,
        primaryColor: '#c2410c',
      })
      .expect(200);
    expect(res.body).toEqual({
      name: 'Clínica Sonrisas',
      ...FISCAL,
      primaryColor: '#C2410C',
      logoUrl: null,
      fiscalDataPending: false,
    });
    const events = await auditOf('CLINIC_PROFILE');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'UPDATE',
      resourceType: 'CLINIC_SETTINGS',
      resourceId: a.tenantId,
    });
    const metadata = events[0].metadata as {
      changedFields: string[];
      configChange: {
        before: Record<string, unknown>;
        after: Record<string, unknown>;
      };
    };
    expect(metadata.changedFields).toEqual([
      'contactEmail',
      'contactPhone',
      'fiscalAddress',
      'legalName',
      'name',
      'primaryColor',
      'taxId',
      'taxIdLabel',
    ]);
    expect(metadata.configChange.before).toMatchObject({
      name: 'Clinica dx019-clinica-a',
      taxId: null,
    });
    expect(metadata.configChange.after).toMatchObject({
      name: 'Clínica Sonrisas',
      taxId: 'J-12345678-9',
      taxIdLabel: 'ID fiscal',
      primaryColor: '#C2410C',
    });

    // Sin cambio, sin evento.
    await as(a)
      .patch('/clinic/settings', { taxId: 'J-12345678-9' })
      .expect(200);
    expect(await auditOf('CLINIC_PROFILE')).toHaveLength(1);
  });

  it('valida con mensajes en español y no guarda nada', async () => {
    const cases: [object, string][] = [
      [{ name: '' }, CLINIC_SETTINGS_MESSAGES.name],
      [{ taxId: 'x'.repeat(65) }, CLINIC_SETTINGS_MESSAGES.taxId],
      [{ taxIdLabel: 'x'.repeat(41) }, CLINIC_SETTINGS_MESSAGES.taxIdLabel],
      [{ legalName: 'a\nb' }, CLINIC_SETTINGS_MESSAGES.legalName],
      [{ contactEmail: 'sin arroba' }, CLINIC_SETTINGS_MESSAGES.contactEmail],
      [
        { primaryColor: 'red;}body{display:none' },
        CLINIC_SETTINGS_MESSAGES.primaryColor,
      ],
    ];
    for (const [body, message] of cases) {
      const res = await as(a).patch('/clinic/settings', body).expect(400);
      expect((res.body as { message: string }).message).toBe(message);
    }
    const res = await as(a).get('/clinic/settings').expect(200);
    expect((res.body as SettingsBody).name).toBe('Clínica Sonrisas');
    expect((res.body as SettingsBody).taxId).toBe('J-12345678-9');
  });

  it('solo toca la clínica propia: la otra clínica sigue igual y un token ajeno no entra', async () => {
    const other = await as(b).get('/clinic/settings').expect(200);
    expect(other.body).toMatchObject({
      name: 'Clinica dx019-clinica-b',
      taxId: null,
      legalName: null,
    });
    // El token de A contra el host de B no vale (la clínica sale del host y del token).
    const cross = await request(server())
      .patch('/api/v1/clinic/settings')
      .set('X-Tenant-Host', b.host)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ taxId: 'INTRUSO' });
    expect([401, 403]).toContain(cross.status);
    const tenantB = await raw.tenant.findUniqueOrThrow({
      where: { id: b.tenantId },
    });
    expect(tenantB.taxId).toBeNull();
    expect(
      await raw.auditEvent.count({
        where: {
          tenantId: b.tenantId,
          metadata: { path: ['reason'], equals: 'CLINIC_PROFILE' },
        },
      }),
    ).toBe(0);
  });

  it('la marca pública (login y app) cambia al momento: nombre y color', async () => {
    const res = await branding(a).expect(200);
    expect(res.body).toMatchObject({
      name: 'Clínica Sonrisas',
      primaryColor: '#C2410C',
      logoUrl: null,
    });
    const resB = await branding(b).expect(200);
    expect((resB.body as { name: string }).name).toBe(
      'Clinica dx019-clinica-b',
    );
  });

  it('logo PNG: se valida por los bytes, se re-escribe sin metadatos ni cola, se sirve público y se audita', async () => {
    const dirty = makePng(8, 8, {
      before: [
        pngChunk('tEXt', Buffer.from('Comment\0<script>alert(1)</script>')),
      ],
      after: Buffer.from('<html><script>alert(1)</script></html>'),
    });
    const res = await as(a).upload(dirty, 'logo.png', 'image/png').expect(200);
    const body = res.body as SettingsBody;
    expect(body.logoUrl).toMatch(
      new RegExp(`/files/logos/${a.tenantId}-[0-9a-f]{16}\\.png$`),
    );
    const tenant = await raw.tenant.findUniqueOrThrow({
      where: { id: a.tenantId },
    });
    expect(tenant.logoKey).toBe(
      `logos/${body.logoUrl!.split('/files/logos/')[1]}`,
    );

    const file = await request(server())
      .get(logoPath(body.logoUrl!))
      .buffer(true)
      .expect(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(file.headers['cache-control']).toContain('immutable');
    expect(Buffer.from(file.body as Buffer).equals(makePng(8, 8))).toBe(true);

    expect((await branding(a).expect(200)).body).toMatchObject({
      logoUrl: body.logoUrl,
    });
    const events = await auditOf('CLINIC_LOGO');
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({
      configChange: { before: { logo: null }, after: { logo: tenant.logoKey } },
    });
  });

  it('logo JPEG (sin EXIF) y SVG saneado, servido con una CSP que no ejecuta nada', async () => {
    const jpg = (
      await as(a).upload(JPEG_WITH_EXIF, 'logo.jpg', 'image/jpeg').expect(200)
    ).body as SettingsBody;
    const jpgFile = await request(server())
      .get(logoPath(jpg.logoUrl!))
      .buffer(true)
      .expect(200);
    expect(jpgFile.headers['content-type']).toBe('image/jpeg');
    expect(
      Buffer.from(jpgFile.body as Buffer).includes(Buffer.from('Exif')),
    ).toBe(false);

    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)"><script>alert(1)</script>' +
        '<rect width="10" height="10" fill="#0E7490"/></svg>',
    );
    // La etiqueta del navegador no manda: se manda como PNG y es un SVG.
    const saved = (await as(a).upload(svg, 'logo.png', 'image/png').expect(200))
      .body as SettingsBody;
    expect(saved.logoUrl).toMatch(/\.svg$/);
    const svgFile = await request(server())
      .get(logoPath(saved.logoUrl!))
      .buffer(true)
      .expect(200);
    expect(svgFile.headers['content-type']).toContain('image/svg+xml');
    expect(svgFile.headers['content-security-policy']).toContain('sandbox');
    const text = Buffer.from(svgFile.body as Buffer).toString('utf8');
    expect(text).not.toMatch(/script|onload|alert/);
    expect(text).toContain('<rect width="10" height="10" fill="#0E7490"/>');
  });

  it('un logo inválido (tipo, contenido o tamaño) se rechaza con un mensaje claro y no cambia el que había', async () => {
    const before = (await as(a).get('/clinic/settings').expect(200))
      .body as SettingsBody;
    const gif = await as(a)
      .upload(Buffer.from('GIF89a\x01\x00\x01\x00'), 'logo.gif', 'image/gif')
      .expect(400);
    expect((gif.body as { message: string }).message).toBe(LOGO_MESSAGES.type);
    const html = await as(a)
      .upload(
        Buffer.from('<html><body>hola</body></html>'),
        'logo.png',
        'image/png',
      )
      .expect(400);
    expect((html.body as { message: string }).message).toBe(LOGO_MESSAGES.type);
    const broken = makePng();
    broken[30] ^= 0xff;
    const damaged = await as(a)
      .upload(broken, 'logo.png', 'image/png')
      .expect(400);
    expect((damaged.body as { message: string }).message).toBe(
      LOGO_MESSAGES.damaged,
    );
    const big = await as(a).upload(
      Buffer.concat([makePng(), Buffer.alloc(1024 * 1024)]),
      'logo.png',
      'image/png',
    );
    expect([400, 413]).toContain(big.status);
    expect((big.body as { message: string }).message).toBe(
      LOGO_MESSAGES.tooLarge,
    );
    const missing = await as(a).post('/clinic/settings/logo').expect(400);
    expect((missing.body as { message: string }).message).toBe(
      'Falta el archivo del logo.',
    );
    const after = (await as(a).get('/clinic/settings').expect(200))
      .body as SettingsBody;
    expect(after.logoUrl).toBe(before.logoUrl);
  });

  it('nombres de logo que no arma la API: 400, y uno que no existe, 404', async () => {
    await request(server())
      .get('/api/v1/files/logos/..%2F..%2Fetc%2Fpasswd')
      .expect(400);
    await request(server()).get('/api/v1/files/logos/hola.html').expect(400);
    await request(server())
      .get(`/api/v1/files/logos/${a.tenantId}-0000000000000000.png`)
      .expect(404);
  });

  it('recibo emitido CON datos fiscales: los congela con el nombre propio del identificador; el anterior no cambia', async () => {
    const before = await raw.paymentReceipt.findFirstOrThrow({
      where: { tenantId: a.tenantId },
      orderBy: { number: 'asc' },
      select: { snapshot: true },
    });
    const paymentId = await pay(20_000);
    const snapshot = await snapshotOf(paymentId);
    expect(snapshot.fiscalDataPending).toBe(false);
    expect(snapshot.clinic).toEqual({
      name: 'Clínica Sonrisas',
      legalName: FISCAL.legalName,
      taxId: FISCAL.taxId,
      taxIdLabel: FISCAL.taxIdLabel,
      address: FISCAL.fiscalAddress,
    });
    const after = await raw.paymentReceipt.findFirstOrThrow({
      where: { tenantId: a.tenantId },
      orderBy: { number: 'asc' },
      select: { snapshot: true },
    });
    expect(after.snapshot).toEqual(before.snapshot);

    // Cambiar después los datos no reescribe el recibo emitido.
    await as(a)
      .patch('/clinic/settings', { taxIdLabel: null, taxId: 'NUEVO-1' })
      .expect(200);
    expect((await snapshotOf(paymentId)).clinic).toMatchObject({
      taxId: FISCAL.taxId,
      taxIdLabel: 'ID fiscal',
    });
    // Sin nombre propio, el identificador va sin `taxIdLabel` (la web pone el genérico).
    const generic = await snapshotOf(await pay(5_000));
    expect(generic.clinic).toEqual({
      name: 'Clínica Sonrisas',
      legalName: FISCAL.legalName,
      taxId: 'NUEVO-1',
      address: FISCAL.fiscalAddress,
    });
    await as(a)
      .patch('/clinic/settings', {
        taxIdLabel: FISCAL.taxIdLabel,
        taxId: FISCAL.taxId,
      })
      .expect(200);
  });

  it('presupuesto y estado de cuenta imprimen los datos fiscales de hoy', async () => {
    const quote = await as(a)
      .get(`/patients/${patientA}/treatment-plans/${planA}/quote`)
      .expect(200);
    expect((quote.body as { clinicFiscal: unknown }).clinicFiscal).toEqual({
      legalName: FISCAL.legalName,
      taxIdLabel: FISCAL.taxIdLabel,
      taxId: FISCAL.taxId,
      address: FISCAL.fiscalAddress,
      email: FISCAL.contactEmail,
      phone: FISCAL.contactPhone,
    });
    const statement = await as(a)
      .get(`/patients/${patientA}/account-statement`)
      .expect(200);
    expect(
      (statement.body as { clinic: { fiscal: unknown } }).clinic.fiscal,
    ).toMatchObject({
      legalName: FISCAL.legalName,
      taxId: FISCAL.taxId,
    });
  });

  it('quitar el logo: la marca vuelve sin logo y queda auditado', async () => {
    const res = await as(a).delete('/clinic/settings/logo').expect(200);
    expect((res.body as SettingsBody).logoUrl).toBeNull();
    expect((await branding(a).expect(200)).body).toMatchObject({
      logoUrl: null,
    });
    const tenant = await raw.tenant.findUniqueOrThrow({
      where: { id: a.tenantId },
    });
    expect(tenant.logoKey).toBeNull();
    const events = await auditOf('CLINIC_LOGO');
    expect(events.at(-1)!.metadata).toMatchObject({
      configChange: { after: { logo: null } },
    });
    // Quitarlo otra vez no cambia nada: sin evento.
    await as(a).delete('/clinic/settings/logo').expect(200);
    expect(await auditOf('CLINIC_LOGO')).toHaveLength(events.length);
  });
});
