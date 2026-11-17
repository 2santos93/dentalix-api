import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { ClinicRole, Prisma, PrismaClient, Sex } from '@prisma/client';
import {
  createE2eApp,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
  type Clinic,
} from './support/e2e-fixtures';

// DX-205: «Actualizar precios» del catálogo en bloque. La vista previa y la
// aplicación dan los mismos precios, la misma Idempotency-Key no aplica dos
// veces, los presupuestos ya creados conservan su precio, el historial guarda
// autor y fecha, solo ADMIN, y otra clínica no ve ni toca nada.

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const CATEGORY = 'Prevención';

interface PreviewLine {
  itemId: string;
  code: string;
  before: number;
  after: number;
  difference: number;
}
interface PreviewBody {
  currency: string | null;
  previewHash: string;
  lines: PreviewLine[];
  skipped: { itemId: string; code: string; reason: string }[];
  totals: { before: number; after: number; difference: number };
}
interface AppliedBody {
  batchId: string;
  replayed: boolean;
  itemCount: number;
  currency: string | null;
  totals: { before: number; after: number; difference: number };
}
interface HistoryEntry {
  previousPrice: number | null;
  newPrice: number | null;
  batchId: string | null;
  actorName: string;
  actorUserId: string;
  createdAt: string;
}

describe('DX-205 · POST /catalog/price-changes (e2e)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let dentistToken: string;
  const ids: Record<string, string> = {};

  const as = (clinic: Clinic, token = clinic.adminToken) => ({
    post: (path: string) =>
      request(app.getHttpServer())
        .post(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`),
    get: (path: string) =>
      request(app.getHttpServer())
        .get(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`),
    patch: (path: string) =>
      request(app.getHttpServer())
        .patch(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`),
  });

  const fivePercent = {
    category: CATEGORY,
    activeOnly: true,
    mode: 'PERCENT',
    value: 5,
    roundTo: 100,
  };

  async function priceOf(id: string): Promise<string | null> {
    const row = await raw.dentalCatalogItem.findUniqueOrThrow({
      where: { id },
      select: { defaultPrice: true },
    });
    return row.defaultPrice?.toFixed(2) ?? null;
  }

  async function seedItems(clinic: Clinic): Promise<void> {
    // Solo el catálogo de ESTA clínica, antes de que tenga historial.
    await raw.dentalCatalogItem.deleteMany({
      where: { tenantId: clinic.tenantId },
    });
    const rows: [string, string | null, string, boolean][] = [
      // código, precio (VES), categoría, activo
      ['PRE-01', '1840.00', CATEGORY, true],
      ['PRE-02', '2000.00', CATEGORY, true],
      ['PRE-03', null, CATEGORY, true],
      ['PRE-04', '35.00', CATEGORY, true],
      ['PRE-05', '3000.00', CATEGORY, false],
      ['CIR-01', '9000.00', 'Cirugía', true],
    ];
    for (const [code, price, category, active] of rows) {
      const created = await raw.dentalCatalogItem.create({
        data: {
          tenantId: clinic.tenantId,
          code,
          category,
          kind: 'PROCEDURE',
          labelEs: `Prestación ${code}`,
          color: '#0E7490',
          defaultPrice: price,
          active,
        },
        select: { id: true },
      });
      ids[`${clinic.subdomain}:${code}`] = created.id;
    }
  }

  const idA = (code: string) => ids[`${a.subdomain}:${code}`];
  const idB = (code: string) => ids[`${b.subdomain}:${code}`];

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'dx205-precios-a');
    b = await registerClinic(app, 'dx205-precios-b');
    const dentist = await seedMember(raw, a, ClinicRole.DENTIST);
    dentistToken = await loginAs(app, a.host, dentist.email);
    await seedItems(a);
    await seedItems(b);
  }, 120_000);

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('solo ADMIN: los demás roles reciben 403 en vista previa, aplicar e historial', async () => {
    const dentist = as(a, dentistToken);
    await dentist
      .post('/catalog/price-changes/preview')
      .send(fivePercent)
      .expect(403);
    await dentist
      .post('/catalog/price-changes/apply')
      .set('Idempotency-Key', randomUUID())
      .send({ ...fivePercent, previewHash: 'a'.repeat(64) })
      .expect(403);
    await dentist
      .get(`/catalog/items/${idA('PRE-01')}/price-history`)
      .expect(403);
  });

  it('valida los criterios con mensajes en español', async () => {
    const admin = as(a);
    const zero = await admin
      .post('/catalog/price-changes/preview')
      .send({ ...fivePercent, value: 0 })
      .expect(400);
    expect(JSON.stringify(zero.body)).toMatch(/no puede ser 0/);
    await admin
      .post('/catalog/price-changes/preview')
      .send({ ...fivePercent, roundTo: 50 })
      .expect(400);
    const minDown = await admin
      .post('/catalog/price-changes/preview')
      .send({ ...fivePercent, value: -5, minIncrement: 10 })
      .expect(400);
    expect(JSON.stringify(minDown.body)).toMatch(/solo se aplica a una subida/);
    await admin
      .post('/catalog/price-changes/preview')
      .send({ ...fivePercent, value: 2000 })
      .expect(400);
    await admin
      .post('/catalog/price-changes/preview')
      .send({ ...fivePercent, category: 'x'.repeat(500) })
      .expect(400);
  });

  it('ningún ítem cumple el filtro: vista previa vacía y nada que aplicar', async () => {
    const admin = as(a);
    const res = await admin
      .post('/catalog/price-changes/preview')
      .send({ ...fivePercent, category: 'Ortodoncia' })
      .expect(200);
    const body = res.body as PreviewBody;
    expect(body.lines).toEqual([]);
    expect(body.skipped).toEqual([]);
    const apply = await admin
      .post('/catalog/price-changes/apply')
      .set('Idempotency-Key', randomUUID())
      .send({
        ...fivePercent,
        category: 'Ortodoncia',
        previewHash: body.previewHash,
      })
      .expect(409);
    expect(apply.body).toMatchObject({ code: 'PRICE_CHANGE_NOTHING_TO_APPLY' });
  });

  it('aplicar exige la cabecera Idempotency-Key (UUID)', async () => {
    const admin = as(a);
    await admin
      .post('/catalog/price-changes/apply')
      .send({ ...fivePercent, previewHash: 'a'.repeat(64) })
      .expect(400);
    await admin
      .post('/catalog/price-changes/apply')
      .set('Idempotency-Key', 'no-es-uuid')
      .send({ ...fivePercent, previewHash: 'a'.repeat(64) })
      .expect(400);
  });

  it('una vista previa vieja no se aplica (409) y nada cambia', async () => {
    const admin = as(a);
    const preview = (
      await admin
        .post('/catalog/price-changes/preview')
        .send(fivePercent)
        .expect(200)
    ).body as PreviewBody;
    // Otra persona cambia un precio entre la vista previa y aplicar.
    await admin
      .patch(`/catalog/items/${idA('PRE-02')}`)
      .send({ defaultPrice: 2050 })
      .expect(200);
    const res = await admin
      .post('/catalog/price-changes/apply')
      .set('Idempotency-Key', randomUUID())
      .send({ ...fivePercent, previewHash: preview.previewHash })
      .expect(409);
    expect(res.body).toMatchObject({ code: 'PRICE_CHANGE_PREVIEW_STALE' });
    expect(await priceOf(idA('PRE-01'))).toBe('1840.00');
    // Se deja como estaba para el resto del spec (otra edición suelta).
    await admin
      .patch(`/catalog/items/${idA('PRE-02')}`)
      .send({ defaultPrice: 2000 })
      .expect(200);
  });

  describe('subir un 5 % «Prevención» redondeando a 100 VES', () => {
    let preview: PreviewBody;
    let applied: AppliedBody;
    let planId: string;
    let patientId: string;
    const key = randomUUID();

    beforeAll(async () => {
      const admin = as(a);
      // Un presupuesto ya creado con PRE-01 al precio de antes.
      patientId = (
        (
          await admin
            .post('/patients')
            .send({
              firstName: 'Ana',
              lastName: 'Precios',
              docType: 'NATIONAL_ID',
              docNumber: '20500001',
              sex: Sex.F,
            })
            .expect(201)
        ).body as { id: string }
      ).id;
      planId = (
        (
          await admin
            .post(`/patients/${patientId}/treatment-plans`)
            .send({ currency: 'VES' })
            .expect(201)
        ).body as { id: string }
      ).id;
      const item = await admin
        .post(`/treatment-plans/${planId}/items`)
        .send({ toothNumber: '11', catalogItemId: idA('PRE-01') })
        .expect(201);
      expect(Number((item.body as { price: number }).price)).toBe(1840);
    });

    it('la vista previa muestra antes, nuevo, diferencia, omitidos y totales', async () => {
      preview = (
        await as(a)
          .post('/catalog/price-changes/preview')
          .send(fivePercent)
          .expect(200)
      ).body as PreviewBody;
      expect(preview.currency).toBe('VES');
      expect(
        preview.lines.map((l) => [l.code, l.before, l.after, l.difference]),
      ).toEqual([
        // 1.840 × 1,05 = 1.932 → 1.900; 2.000 × 1,05 = 2.100.
        ['PRE-01', 1840, 1900, 60],
        ['PRE-02', 2000, 2100, 100],
      ]);
      expect(preview.skipped.map((s) => [s.code, s.reason])).toEqual([
        ['PRE-03', 'NO_PRICE'],
        // 35 × 1,05 = 36,75 → a 100 sería 0: una subida no baja el precio.
        ['PRE-04', 'UNCHANGED'],
      ]);
      expect(preview.totals).toEqual({
        before: 3840,
        after: 4000,
        difference: 160,
      });
      expect(preview.previewHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('/apply aplica exactamente los precios de la vista previa', async () => {
      applied = (
        await as(a)
          .post('/catalog/price-changes/apply')
          .set('Idempotency-Key', key)
          .send({ ...fivePercent, previewHash: preview.previewHash })
          .expect(200)
      ).body as AppliedBody;
      expect(applied).toMatchObject({
        replayed: false,
        itemCount: 2,
        currency: 'VES',
        totals: { before: 3840, after: 4000, difference: 160 },
      });
      for (const line of preview.lines) {
        expect(await priceOf(line.itemId)).toBe(line.after.toFixed(2));
      }
      // Lo que no entraba no cambia (inactivo, otra categoría, sin precio).
      expect(await priceOf(idA('PRE-05'))).toBe('3000.00');
      expect(await priceOf(idA('CIR-01'))).toBe('9000.00');
      expect(await priceOf(idA('PRE-03'))).toBeNull();
      expect(await priceOf(idA('PRE-04'))).toBe('35.00');
      // UN evento de auditoría del lote, sin importes.
      const events = await raw.auditEvent.findMany({
        where: {
          tenantId: a.tenantId,
          resourceType: 'DENTAL_CATALOG_ITEM',
          action: 'UPDATE',
          metadata: { path: ['reason'], equals: 'CATALOG_PRICES_BATCH' },
        },
      });
      expect(events).toHaveLength(1);
      expect(events[0].metadata).toMatchObject({
        params: { batchId: applied.batchId, itemCount: '2' },
      });
    });

    it('repetir /apply con la misma clave no aplica el lote dos veces', async () => {
      const again = (
        await as(a)
          .post('/catalog/price-changes/apply')
          .set('Idempotency-Key', key)
          .send({ ...fivePercent, previewHash: preview.previewHash })
          .expect(200)
      ).body as AppliedBody;
      expect(again).toMatchObject({ batchId: applied.batchId, replayed: true });
      expect(await priceOf(idA('PRE-01'))).toBe('1900.00');
      expect(
        await raw.catalogPriceBatch.count({ where: { tenantId: a.tenantId } }),
      ).toBe(1);
      expect(
        await raw.auditEvent.count({
          where: {
            tenantId: a.tenantId,
            metadata: { path: ['reason'], equals: 'CATALOG_PRICES_BATCH' },
          },
        }),
      ).toBe(1);
      // La misma clave con otra petición: 422.
      const reused = await as(a)
        .post('/catalog/price-changes/apply')
        .set('Idempotency-Key', key)
        .send({ ...fivePercent, value: 6, previewHash: preview.previewHash })
        .expect(422);
      expect(reused.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    });

    it('el presupuesto ya creado conserva su precio y un ítem nuevo toma el nuevo', async () => {
      const admin = as(a);
      const plan = await admin.get(`/treatment-plans/${planId}`).expect(200);
      const { items } = plan.body as { items: { price: number }[] };
      expect(items.map((i) => Number(i.price))).toEqual([1840]);
      const added = await admin
        .post(`/treatment-plans/${planId}/items`)
        .send({ toothNumber: '21', catalogItemId: idA('PRE-01') })
        .expect(201);
      expect(Number((added.body as { price: number }).price)).toBe(1900);
    });

    it('el historial del ítem muestra cada cambio con autor y fecha', async () => {
      const pre02 = (
        await as(a)
          .get(`/catalog/items/${idA('PRE-02')}/price-history`)
          .expect(200)
      ).body as HistoryEntry[];
      // Del más reciente al más antiguo: el lote y las dos ediciones sueltas.
      expect(
        pre02.map((h) => [h.previousPrice, h.newPrice, h.batchId !== null]),
      ).toEqual([
        [2000, 2100, true],
        [2050, 2000, false],
        [2000, 2050, false],
      ]);
      expect(pre02[0]).toMatchObject({
        batchId: applied.batchId,
        actorUserId: a.adminUserId,
        actorName: 'Dr. Owner',
      });
      expect(Number.isNaN(Date.parse(pre02[0].createdAt))).toBe(false);
      // Un ítem que no cambió no tiene historial.
      const pre05 = (
        await as(a)
          .get(`/catalog/items/${idA('PRE-05')}/price-history`)
          .expect(200)
      ).body as HistoryEntry[];
      expect(pre05).toEqual([]);
    });
  });

  it('aislamiento: el lote de A no toca precios de B y B no ve el historial de A', async () => {
    expect(await priceOf(idB('PRE-01'))).toBe('1840.00');
    expect(await priceOf(idB('PRE-02'))).toBe('2000.00');
    expect(
      await raw.catalogPriceHistory.count({ where: { tenantId: b.tenantId } }),
    ).toBe(0);
    await as(b)
      .get(`/catalog/items/${idA('PRE-01')}/price-history`)
      .expect(404);
    // La vista previa de B solo ve su catálogo.
    const previewB = (
      await as(b)
        .post('/catalog/price-changes/preview')
        .send(fivePercent)
        .expect(200)
    ).body as PreviewBody;
    expect(previewB.lines.map((l) => l.itemId).sort()).toEqual(
      [idB('PRE-01'), idB('PRE-02')].sort(),
    );
    // La clave de A no es la de B: aplicar con ella en B es otro lote.
    const appliedB = (
      await as(b)
        .post('/catalog/price-changes/apply')
        .set('Idempotency-Key', randomUUID())
        .send({ ...fivePercent, previewHash: previewB.previewHash })
        .expect(200)
    ).body as AppliedBody;
    expect(appliedB.replayed).toBe(false);
    // A no cambia por el lote de B.
    expect(await priceOf(idA('PRE-01'))).toBe('1900.00');
  });

  it('un ítem inexistente o de otra clínica en el historial es 404; un id que no es UUID, 400', async () => {
    await as(a).get(`/catalog/items/${randomUUID()}/price-history`).expect(404);
    await as(a).get('/catalog/items/no-uuid/price-history').expect(400);
  });
});
