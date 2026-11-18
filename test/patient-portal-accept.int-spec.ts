import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { CatalogKind, Prisma, PrismaClient, Sex } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import { CapturingMailer } from './support/capture-mailer';
import { MAILER } from '../src/modules/notifications/email/domain/ports/mailer.port';
import {
  MAIL_CONFIG,
  loadMailConfig,
} from '../src/modules/notifications/email/infrastructure/mail-config';
import { EmailDispatcher } from '../src/modules/notifications/email/application/email-dispatcher.service';
import { SIGNATURE_LINK_INVALID_MESSAGE } from '../src/modules/signature-requests/application/use-cases/public-signature.use-cases';
import {
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import type { Clinic } from './support/e2e-fixtures';
import { seedParProviderRates } from './support/par-provider-rates';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';
import { signaturePng } from './support/png-fixtures';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import {
  PATIENT_ACCESS_REPOSITORY,
  type PatientAccessRepository,
} from '../src/modules/patient-access/domain/ports/patient-access-repository.port';
import {
  computeAcceptanceHash,
  computeQuoteHash,
  parseQuoteContent,
} from '../src/modules/treatment-plans/domain/plan-quote';

// DX-101-bis contra Postgres: el paciente acepta con su firma un presupuesto
// desde el portal. Una sola aceptación aunque lleguen dos a la vez (bloqueo
// del grupo + UNIQUE), el mismo 409 para todo lo que no se puede aceptar, el
// enlace releído en la transacción (410), la evidencia PORTAL (CHECK y FK
// compuesta), el evento con actor paciente, la RLS y la inmutabilidad.

// El límite por IP de las rutas del portal (30/min) y por sesión de aceptar
// (10/min) se prueban en rate-limit.e2e-spec.ts: aquí no estorban.
process.env.RATE_LIMIT_PATIENT_ACCESS_LIMIT = '10000';
process.env.RATE_LIMIT_PATIENT_ACCESS_ACCEPT_LIMIT = '10000';

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const appRole = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const BIRTH_DATE = '1984-06-09';
const COOKIE = 'dentalix_pa';
const PNG = signaturePng(160, 60).toString('base64');
const NOT_ACCEPTABLE = {
  code: 'PORTAL_QUOTE_NOT_ACCEPTABLE',
  message:
    'Este presupuesto ya no se puede aceptar desde aquí. Contacta con la clínica.',
};

interface PortalPlan {
  id: string;
  status: string;
  optionLabel: string | null;
  acceptable: boolean;
  contentHash: string;
  acceptedAt: string | null;
}

function asApp<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return appRole.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    return fn(tx);
  });
}

describe('aceptar el presupuesto desde el portal (DX-101-bis, int)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let catalogA: string;
  let dropParRates: (() => Promise<void>) | undefined;
  let dispatcher: EmailDispatcher;
  const mailer = new CapturingMailer();
  let seq = 0;

  const server = () => app.getHttpServer();
  const staff = (
    clinic: Clinic,
    opts: { token?: string; locationId?: string } = {},
  ) => {
    const set = (r: request.Test) => {
      const req = r
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${opts.token ?? clinic.adminToken}`);
      return opts.locationId ? req.set('X-Location-Id', opts.locationId) : req;
    };
    return {
      post: (path: string, body: object = {}) =>
        set(request(server()).post(`/api/v1${path}`)).send(body),
      get: (path: string) => set(request(server()).get(`/api/v1${path}`)),
      delete: (path: string) => set(request(server()).delete(`/api/v1${path}`)),
    };
  };

  async function patient(
    clinic: Clinic,
    email?: string,
    birthDate = BIRTH_DATE,
  ): Promise<string> {
    const res = await staff(clinic)
      .post('/patients', {
        firstName: 'María José',
        lastName: `Portal${++seq}`,
        docType: 'NATIONAL_ID',
        docNumber: `V-77${seq}`,
        sex: Sex.F,
        birthDate,
        ...(email ? { email } : {}),
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  async function catalog(clinic: Clinic): Promise<string> {
    const res = await staff(clinic)
      .post('/catalog/items', {
        code: `DX101B-${++seq}`,
        kind: CatalogKind.PROCEDURE,
        labelEs: 'Corona de zirconio',
        color: '#2A2B3C',
        defaultPrice: 1,
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  /** Plan con un ítem; presentado salvo `present: false`. */
  async function plan(
    clinic: Clinic,
    patientId: string,
    opts: {
      present?: boolean;
      price?: number;
      /** Quién lo crea (token del personal); por defecto, el dueño. */
      token?: string;
      /** Sede desde la que se presenta (X-Location-Id). */
      locationId?: string;
    } = {},
  ): Promise<string> {
    const as = staff(clinic, { token: opts.token });
    const res = await as
      .post(`/patients/${patientId}/treatment-plans`, { currency: 'USD' })
      .expect(201);
    const id = (res.body as { id: string }).id;
    await as
      .post(`/treatment-plans/${id}/items`, {
        toothNumber: '36',
        catalogItemId: catalogA,
        price: opts.price ?? 420,
      })
      .expect(201);
    if (opts.present !== false) {
      await staff(clinic, opts)
        .post(`/treatment-plans/${id}/present`)
        .expect(200);
    }
    return id;
  }

  /** Opciones A y B presentadas del mismo grupo. */
  async function optionsAB(
    clinic: Clinic,
    patientId: string,
  ): Promise<{ a: string; b: string }> {
    const optionA = await plan(clinic, patientId, { present: false });
    const alt = await staff(clinic)
      .post(`/treatment-plans/${optionA}/alternatives`, {})
      .expect(201);
    const optionB = (alt.body as { id: string }).id;
    await staff(clinic).post(`/treatment-plans/${optionA}/present`).expect(200);
    await staff(clinic).post(`/treatment-plans/${optionB}/present`).expect(200);
    return { a: optionA, b: optionB };
  }

  async function link(
    clinic: Clinic,
    patientId: string,
    scopes: string[] = ['PLANS'],
  ): Promise<{ id: string; token: string }> {
    const res = await staff(clinic)
      .post(`/patients/${patientId}/access-links`, { scopes })
      .expect(201);
    const body = res.body as { id: string; url: string };
    return { id: body.id, token: body.url.split('/mi-clinica/')[1] };
  }

  /** Verifica la fecha y devuelve la cookie de la sesión. */
  async function session(
    clinic: Clinic,
    token: string,
    birthDate = BIRTH_DATE,
  ): Promise<string> {
    const res = await request(server())
      .post(`/api/v1/public/patient-access/${token}/verify`)
      .set('X-Tenant-Host', clinic.host)
      .send({ birthDate })
      .expect(200);
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const mine = cookies.find((c) => c.startsWith(`${COOKIE}=`));
    if (!mine) throw new Error('sin cookie del portal');
    return mine.split(';')[0];
  }

  const me = (clinic: Clinic, cookie: string) =>
    request(server())
      .get('/api/v1/public/patient-access/me')
      .set('X-Tenant-Host', clinic.host)
      .set('Cookie', cookie);

  async function shown(
    clinic: Clinic,
    cookie: string,
    planId: string,
  ): Promise<PortalPlan> {
    const res = await me(clinic, cookie).expect(200);
    const found = (res.body as { plans: PortalPlan[] }).plans.find(
      (p) => p.id === planId,
    );
    if (!found) throw new Error(`plan ${planId} no está en el portal`);
    return found;
  }

  const accept = (
    clinic: Clinic,
    cookie: string,
    planId: string,
    body: Partial<Record<string, unknown>> = {},
  ) =>
    request(server())
      .post(`/api/v1/public/patient-access/me/plans/${planId}/accept`)
      .set('X-Tenant-Host', clinic.host)
      .set('Cookie', cookie)
      .set('User-Agent', 'Mozilla/5.0 (portal int)')
      .send({
        signerName: 'María José Pérez',
        signature: PNG,
        consent: true,
        ...body,
      });

  /** Un paciente con su enlace, su sesión y un plan presentado. */
  async function scene(email?: string, price?: number) {
    const patientId = await patient(a, email);
    const planId = await plan(a, patientId, { price });
    const access = await link(a, patientId);
    const cookie = await session(a, access.token);
    const { contentHash } = await shown(a, cookie, planId);
    return { patientId, planId, access, cookie, contentHash };
  }

  /**
   * DX-415: el personal envía el presupuesto a firmar y el paciente verifica
   * el código: la solicitud queda viva, con sesión, lista para firmar.
   */
  async function liveSignatureRequest(
    patientId: string,
    email: string,
    planId: string,
  ) {
    const sign = (path: string, body: object = {}, sessionToken?: string) => {
      const req = request(server())
        .post(`/api/v1/public/sign/${path}`)
        .set('X-Tenant-Host', a.host);
      return (
        sessionToken ? req.set('X-Signature-Session', sessionToken) : req
      ).send(body);
    };
    mailer.clear();
    const sent = await staff(a)
      .post(`/patients/${patientId}/signature-requests`, {
        type: 'BUDGET',
        channel: 'EMAIL',
        treatmentPlanId: planId,
      })
      .expect(201);
    await dispatcher.whenIdle();
    const token = (
      await mailer.waitFor(email, /\/firmar\/([A-Za-z0-9_-]{43})/)
    )[1];
    mailer.clear();
    await sign(`${token}/code`).expect(200);
    await dispatcher.whenIdle();
    const code = (
      await mailer.waitFor(email, /Tu código de verificación es: (\d{6})/)
    )[1];
    const verified = await sign(`${token}/verify`, { code }).expect(200);
    return {
      requestId: (sent.body as { id: string }).id,
      token,
      session: (verified.body as { sessionToken: string }).sessionToken,
      sign,
    };
  }

  beforeAll(async () => {
    app = await createE2eApp({
      override: (builder) => {
        builder.overrideProvider(MAILER).useValue(mailer);
        builder.overrideProvider(MAIL_CONFIG).useValue({
          ...loadMailConfig((key) => process.env[key]),
          quotas: {
            recipientCooldownSeconds: 0,
            recipientDaily: 1000,
            tenantDaily: 1000,
          },
        });
      },
    });
    dispatcher = app.get(EmailDispatcher);
    await resetDatabase(raw);
    // Catálogo en VES y planes en USD: la tasa de referencia (DX-204).
    dropParRates = await seedParProviderRates(raw);
    a = await registerClinic(app, 'dx101b-int-a');
    b = await registerClinic(app, 'dx101b-int-b');
    catalogA = await catalog(a);
  });

  afterAll(async () => {
    await dropParRates?.();
    await app.close();
    await resetDatabase(raw);
    await raw.$disconnect();
    await appRole.$disconnect();
  });

  it('acepta: plan ACCEPTED con la evidencia PORTAL, hora de la BD, hashes coherentes y el evento con actor paciente', async () => {
    const { patientId, planId, access, cookie, contentHash } = await scene();
    const before = await raw.$queryRaw<{ now: Date }[]>`SELECT now()`;
    const res = await accept(a, cookie, planId, { contentHash }).expect(200);
    const view = res.body as PortalPlan;
    expect(view).toMatchObject({
      id: planId,
      status: 'ACCEPTED',
      acceptable: false,
      contentHash,
    });
    expect(view.acceptedAt).not.toBeNull();

    const plan = await raw.treatmentPlan.findUniqueOrThrow({
      where: { id: planId },
      include: { items: true },
    });
    expect(plan.status).toBe('ACCEPTED');
    expect(plan.items.every((i) => i.status === 'ACCEPTED')).toBe(true);

    const row = await raw.treatmentPlanAcceptance.findFirstOrThrow({
      where: { planId },
    });
    expect(row).toMatchObject({
      patientId,
      patientAccessLinkId: access.id,
      signatureRequestId: null,
      remoteChannel: null,
      remoteDestinationMasked: null,
      signerName: 'María José Pérez',
      signature: PNG,
      contentHash,
      userAgent: 'Mozilla/5.0 (portal int)',
      // Quien compartió el portal sigue siendo miembro.
      acceptedById: a.adminUserId,
    });
    expect(row.ipAddress).not.toBeNull();
    expect(row.acceptedAt.getTime()).toBeGreaterThanOrEqual(
      before[0].now.getTime() - 1000,
    );
    expect(new Date(view.acceptedAt!).getTime()).toBe(row.acceptedAt.getTime());
    expect(computeQuoteHash(parseQuoteContent(row.content))).toBe(contentHash);
    expect(row.acceptanceHash).toBe(
      computeAcceptanceHash({
        contentHash,
        signerName: row.signerName,
        signature: row.signature,
        acceptedAt: row.acceptedAt,
      }),
    );
    // DX-379: copia del último día válido.
    expect(row.quoteValidUntil).not.toBeNull();

    const events = await raw.auditEvent.findMany({
      where: {
        resourceType: 'TREATMENT_PLAN',
        resourceId: planId,
        action: 'SIGN',
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorUserId: null,
      actorRole: null,
      patientId,
      metadata: { origin: 'PUBLIC_LINK', reason: 'PORTAL_QUOTE_ACCEPTED' },
    });
    expect(JSON.stringify(events[0].metadata)).not.toContain(access.id);

    // El personal lo ve aceptado «desde el portal», no «a distancia».
    const quote = await staff(a)
      .get(`/patients/${patientId}/treatment-plans/${planId}/quote`)
      .expect(200);
    expect(
      (quote.body as { acceptance: { portal: unknown; remote: unknown } })
        .acceptance,
    ).toMatchObject({
      portal: { patientAccessLinkId: access.id },
      remote: null,
      integrityOk: true,
    });
    const detail = await staff(a).get(`/treatment-plans/${planId}`).expect(200);
    expect(
      (detail.body as { acceptance: { portal: unknown; remote: unknown } })
        .acceptance,
    ).toMatchObject({ remote: null, portal: { ipAddress: row.ipAddress } });
  });

  it('dos aceptaciones a la vez: una sola gana (200) y la otra recibe el 409 genérico; nunca 500', async () => {
    const { planId, cookie, contentHash } = await scene();
    const results = await Promise.all([
      accept(a, cookie, planId, { contentHash }),
      accept(a, cookie, planId, { contentHash }),
      accept(a, cookie, planId, { contentHash }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409]);
    for (const r of results.filter((x) => x.status === 409)) {
      expect(r.body).toMatchObject(NOT_ACCEPTABLE);
    }
    expect(await raw.treatmentPlanAcceptance.count({ where: { planId } })).toBe(
      1,
    );
    expect(
      await raw.auditEvent.count({
        where: {
          resourceType: 'TREATMENT_PLAN',
          resourceId: planId,
          action: 'SIGN',
        },
      }),
    ).toBe(1);
  });

  it('aceptar dos veces seguidas: la segunda es el 409 genérico y no deja nada', async () => {
    const { planId, cookie, contentHash } = await scene();
    await accept(a, cookie, planId, { contentHash }).expect(200);
    const again = await accept(a, cookie, planId, { contentHash }).expect(409);
    expect(again.body).toMatchObject(NOT_ACCEPTABLE);
    expect(await raw.treatmentPlanAcceptance.count({ where: { planId } })).toBe(
      1,
    );
  });

  it('el plan de otro paciente (o de otra clínica, o inexistente): 404 «No encontramos ese presupuesto.»', async () => {
    const { cookie, contentHash } = await scene();
    const other = await patient(a);
    const otherPlan = await plan(a, other);
    const res = await accept(a, cookie, otherPlan, { contentHash }).expect(404);
    expect(res.body).toMatchObject({
      message: 'No encontramos ese presupuesto.',
    });
    await accept(a, cookie, randomUUID(), { contentHash }).expect(404);
    expect(
      await raw.treatmentPlanAcceptance.count({ where: { planId: otherPlan } }),
    ).toBe(0);
    expect(
      (await raw.treatmentPlan.findUniqueOrThrow({ where: { id: otherPlan } }))
        .status,
    ).toBe('PRESENTED');
  });

  it('rechazado, en borrador o vencido: el MISMO 409 genérico', async () => {
    const patientId = await patient(a);
    const rejected = await plan(a, patientId);
    const draft = await plan(a, patientId, { present: false });
    const expired = await plan(a, patientId);
    const access = await link(a, patientId);
    const cookie = await session(a, access.token);
    const hashes = new Map(
      (
        (await me(a, cookie).expect(200)).body as { plans: PortalPlan[] }
      ).plans.map((p) => [p.id, p.contentHash]),
    );
    await staff(a)
      .post(`/treatment-plans/${rejected}/reject`, { reason: 'PRICE' })
      .expect(200);
    // Vencido ayer (día civil de Caracas).
    await raw.$executeRaw`
      UPDATE "treatment_plans"
         SET "quoteIssuedOn" = (timezone('America/Caracas', now())::date - 31),
             "quoteValidUntil" = (timezone('America/Caracas', now())::date - 1)
       WHERE "id" = ${expired}::uuid`;
    const expiredView = await shown(a, cookie, expired);
    expect(expiredView.acceptable).toBe(false);

    for (const [planId, hash] of [
      [rejected, hashes.get(rejected) ?? 'a'.repeat(64)],
      [draft, 'a'.repeat(64)],
      [expired, expiredView.contentHash],
    ] as const) {
      const res = await accept(a, cookie, planId, { contentHash: hash });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject(NOT_ACCEPTABLE);
    }
    expect(
      await raw.treatmentPlanAcceptance.count({
        where: { planId: { in: [rejected, draft, expired] } },
      }),
    ).toBe(0);
  });

  it('el presupuesto cambió desde que se mostró: 409 PORTAL_QUOTE_CHANGED y nada se escribe', async () => {
    const { planId, cookie, contentHash } = await scene();
    const res = await accept(a, cookie, planId, {
      contentHash: 'f'.repeat(64),
    }).expect(409);
    expect(res.body).toMatchObject({
      code: 'PORTAL_QUOTE_CHANGED',
      message:
        'El presupuesto ha cambiado. Recarga la página para ver la versión actual.',
    });
    // El hash bueno sigue valiendo.
    await accept(a, cookie, planId, { contentHash }).expect(200);
  });

  it('A/B: elegir B rechaza A (otra opción aceptada); A deja de ser aceptable y aceptarla da el 409 genérico', async () => {
    const patientId = await patient(a);
    const { a: optionA, b: optionB } = await optionsAB(a, patientId);
    const access = await link(a, patientId);
    const cookie = await session(a, access.token);
    const viewA = await shown(a, cookie, optionA);
    const viewB = await shown(a, cookie, optionB);
    expect(viewA.acceptable).toBe(true);
    expect(viewB.acceptable).toBe(true);
    await accept(a, cookie, optionB, { contentHash: viewB.contentHash }).expect(
      200,
    );
    const rejectedA = await raw.treatmentPlan.findUniqueOrThrow({
      where: { id: optionA },
    });
    expect(rejectedA).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'OTHER_OPTION_ACCEPTED',
    });
    // A ya no se muestra (solo presentados y aceptados) ni se acepta.
    const plans = (
      (await me(a, cookie).expect(200)).body as {
        plans: PortalPlan[];
      }
    ).plans;
    expect(plans.find((p) => p.id === optionA)).toBeUndefined();
    expect(plans.find((p) => p.id === optionB)).toMatchObject({
      status: 'ACCEPTED',
      acceptable: false,
    });
    const res = await accept(a, cookie, optionA, {
      contentHash: viewA.contentHash,
    }).expect(409);
    expect(res.body).toMatchObject(NOT_ACCEPTABLE);
  });

  it('A/B: con otra opción ya aceptada en la clínica, la que queda presentada no es aceptable (409 genérico)', async () => {
    const patientId = await patient(a);
    const { a: optionA, b: optionB } = await optionsAB(a, patientId);
    const access = await link(a, patientId);
    const cookie = await session(a, access.token);
    const viewB = await shown(a, cookie, optionB);
    // La clínica cierra A directamente (sin rechazar B: estado inconsistente
    // a propósito, como un dato antiguo) y el portal no deja elegir B.
    await raw.$executeRaw`
      UPDATE "treatment_plans" SET "status" = 'ACCEPTED' WHERE "id" = ${optionA}::uuid`;
    expect((await shown(a, cookie, optionB)).acceptable).toBe(false);
    const res = await accept(a, cookie, optionB, {
      contentHash: viewB.contentHash,
    }).expect(409);
    expect(res.body).toMatchObject(NOT_ACCEPTABLE);
    expect(
      await raw.treatmentPlanAcceptance.count({ where: { planId: optionB } }),
    ).toBe(0);
  });

  it('DX-109: si la otra opción tiene un abono vivo, no se acepta nada (409 genérico, sin detalles)', async () => {
    const patientId = await patient(a);
    const { a: optionA, b: optionB } = await optionsAB(a, patientId);
    await staff(a)
      .post(`/treatment-plans/${optionA}/payments`, {
        amount: 50,
        currency: 'USD',
        paidAt: '2026-11-01',
        method: 'CASH',
      })
      .expect(201);
    const access = await link(a, patientId);
    const cookie = await session(a, access.token);
    const viewB = await shown(a, cookie, optionB);
    const res = await accept(a, cookie, optionB, {
      contentHash: viewB.contentHash,
    }).expect(409);
    expect(res.body).toEqual({
      statusCode: 409,
      error: 'Conflict',
      ...NOT_ACCEPTABLE,
    });
    expect(
      (await raw.treatmentPlan.findUniqueOrThrow({ where: { id: optionB } }))
        .status,
    ).toBe('PRESENTED');
    expect(
      (await raw.treatmentPlan.findUniqueOrThrow({ where: { id: optionA } }))
        .status,
    ).toBe('PRESENTED');
    expect(
      await raw.treatmentPlanAcceptance.count({ where: { planId: optionB } }),
    ).toBe(0);
  });

  it('sin el apartado de presupuestos: 403', async () => {
    const patientId = await patient(a);
    const planId = await plan(a, patientId);
    const access = await link(a, patientId, ['ACCOUNT']);
    const cookie = await session(a, access.token);
    const res = await accept(a, cookie, planId, {
      contentHash: 'a'.repeat(64),
    }).expect(403);
    expect(res.body).toMatchObject({ code: 'PATIENT_ACCESS_SCOPE_REQUIRED' });
  });

  it('revocado con la sesión abierta: 410 y se borra la cookie', async () => {
    const { patientId, planId, access, cookie, contentHash } = await scene();
    await staff(a)
      .delete(`/patients/${patientId}/access-links/${access.id}`)
      .expect(204);
    const res = await accept(a, cookie, planId, { contentHash }).expect(410);
    expect(res.body).toMatchObject({ code: 'PATIENT_ACCESS_GONE' });
    expect(await raw.treatmentPlanAcceptance.count({ where: { planId } })).toBe(
      0,
    );
  });

  it('revocado entre el guard y la aceptación: la transacción relee el enlace y no acepta (GONE)', async () => {
    const { patientId, planId, access, contentHash } = await scene();
    // El guard ya pasó: se revoca y se llama al repositorio directamente,
    // como lo haría la petición que estaba en vuelo.
    await raw.patientAccessLink.update({
      where: { id: access.id },
      data: { revokedAt: new Date(), revokedById: a.adminUserId },
    });
    const repo = app.get<PatientAccessRepository>(PATIENT_ACCESS_REPOSITORY);
    const tenantContext = app.get(TenantContextService);
    const outcome = await tenantContext.run(a.tenantId, () =>
      repo.acceptPlan({
        linkId: access.id,
        patientId,
        planId,
        signerName: 'María José Pérez',
        signature: PNG,
        meta: { requestId: null, ip: null, userAgent: null },
        decide: () => {
          throw new Error('no debería llegar a decidir');
        },
      }),
    );
    expect(outcome).toEqual({ kind: 'GONE' });
    expect(contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await raw.treatmentPlanAcceptance.count({ where: { planId } })).toBe(
      0,
    );
  });

  it('acceptedById: si quien compartió el portal ya no es miembro, el creador del plan', async () => {
    // Otro ADMIN comparte el portal y luego deja la clínica.
    const member = await seedMember(raw, a, 'ADMIN');
    const memberToken = await loginAs(app, a.host, member.email);
    const patientId = await patient(a);
    const planId = await plan(a, patientId);
    const res = await request(server())
      .post(`/api/v1/patients/${patientId}/access-links`)
      .set('X-Tenant-Host', a.host)
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ scopes: ['PLANS'] })
      .expect(201);
    const access = res.body as { id: string; url: string };
    expect(
      (
        await raw.patientAccessLink.findUniqueOrThrow({
          where: { id: access.id },
        })
      ).createdById,
    ).toBe(member.userId);
    await raw.clinicMembership.updateMany({
      where: { tenantId: a.tenantId, userId: member.userId },
      data: { deletedAt: new Date() },
    });
    const cookie = await session(a, access.url.split('/mi-clinica/')[1]);
    const { contentHash } = await shown(a, cookie, planId);
    await accept(a, cookie, planId, { contentHash }).expect(200);
    const row = await raw.treatmentPlanAcceptance.findFirstOrThrow({
      where: { planId },
    });
    expect(row.acceptedById).toBe(a.adminUserId);
  });

  it('CHECK de evidencias: en la clínica, por enlace de firma o por portal; nunca mezcladas', async () => {
    const { patientId, planId, access, cookie, contentHash } = await scene();
    await accept(a, cookie, planId, { contentHash }).expect(200);
    const row = await raw.treatmentPlanAcceptance.findFirstOrThrow({
      where: { planId },
    });
    // Una fila nueva copiando la del portal, sobre otro plan del paciente.
    const other = await plan(a, patientId);
    const base = {
      tenantId: row.tenantId,
      planId: other,
      patientId,
      locationId: row.locationId,
      signerName: row.signerName,
      signature: row.signature,
      content: row.content as Prisma.InputJsonValue,
      contentHash: row.contentHash,
      acceptanceHash: row.acceptanceHash,
      acceptedAt: row.acceptedAt,
      acceptedById: row.acceptedById,
    };
    // Portal + evidencias del enlace de firma: no.
    await expect(
      raw.treatmentPlanAcceptance.create({
        data: {
          ...base,
          patientAccessLinkId: access.id,
          remoteChannel: 'EMAIL',
          remoteDestinationMasked: 'ma***@example.com',
          remoteSentAt: new Date(),
          remoteOpenedAt: new Date(),
          remoteVerifiedAt: new Date(),
        },
      }),
    ).rejects.toThrow(/treatment_plan_acceptances_remote_check/);
    // Portal con solo parte de las del enlace: tampoco.
    await expect(
      raw.treatmentPlanAcceptance.create({
        data: {
          ...base,
          patientAccessLinkId: access.id,
          remoteDestinationMasked: 'ma***@example.com',
        },
      }),
    ).rejects.toThrow(/treatment_plan_acceptances_remote_check/);
    // En la clínica (ninguna evidencia): sí.
    await raw.treatmentPlanAcceptance.create({ data: base });
    const live = await raw.$queryRaw<{ convalidated: boolean }[]>`
      SELECT convalidated FROM pg_constraint
       WHERE conname IN ('treatment_plan_acceptances_remote_check',
                         'treatment_plan_acceptances_patient_access_link_fkey')`;
    expect(live).toHaveLength(2);
    expect(live.every((c) => c.convalidated)).toBe(true);
  });

  it('FK compuesta: el enlace tiene que ser del MISMO paciente y de la MISMA clínica', async () => {
    const { planId, cookie, contentHash } = await scene();
    await accept(a, cookie, planId, { contentHash }).expect(200);
    const row = await raw.treatmentPlanAcceptance.findFirstOrThrow({
      where: { planId },
    });
    const stranger = await patient(a);
    const strangerLink = await link(a, stranger);
    const other = await plan(a, row.patientId);
    await expect(
      raw.treatmentPlanAcceptance.create({
        data: {
          tenantId: row.tenantId,
          planId: other,
          patientId: row.patientId,
          locationId: row.locationId,
          signerName: row.signerName,
          signature: row.signature,
          content: row.content as Prisma.InputJsonValue,
          contentHash: row.contentHash,
          acceptanceHash: row.acceptanceHash,
          acceptedAt: row.acceptedAt,
          acceptedById: row.acceptedById,
          patientAccessLinkId: strangerLink.id,
        },
      }),
    ).rejects.toThrow(/treatment_plan_acceptances_patient_access_link_fkey/);
  });

  it('inmutable y bajo RLS: la app no cambia la evidencia; la clínica B no ve la aceptación', async () => {
    const { planId, cookie, contentHash } = await scene();
    await accept(a, cookie, planId, { contentHash }).expect(200);
    const row = await raw.treatmentPlanAcceptance.findFirstOrThrow({
      where: { planId },
    });
    // La app no tiene UPDATE (DX-148, append-only) y, aun con él (owner), la
    // guarda de inmutabilidad lo rechaza: la evidencia no cambia.
    await expect(
      asApp(a.tenantId, (tx) =>
        tx.treatmentPlanAcceptance.update({
          where: { id: row.id },
          data: { patientAccessLinkId: null },
        }),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      raw.treatmentPlanAcceptance.update({
        where: { id: row.id },
        data: { patientAccessLinkId: null },
      }),
    ).rejects.toThrow(/inmutable/);
    expect(
      await asApp(b.tenantId, (tx) =>
        tx.treatmentPlanAcceptance.count({ where: { id: row.id } }),
      ),
    ).toBe(0);
    expect(
      await asApp(a.tenantId, (tx) =>
        tx.treatmentPlanAcceptance.count({ where: { id: row.id } }),
      ),
    ).toBe(1);
  });

  it('CHECK de actor: el evento del portal solo pasa con su forma exacta', async () => {
    const { patientId, planId } = await scene();
    const event = (metadata: object, action = 'SIGN') =>
      raw.$executeRaw`
        INSERT INTO "audit_events" ("id", "tenantId", "action", "resourceType",
          "resourceId", "patientId", "metadata", "occurredAt")
        VALUES (${randomUUID()}::uuid, ${a.tenantId}::uuid,
          ${action}::"AuditAction", 'TREATMENT_PLAN', ${planId}::uuid,
          ${patientId}::uuid, ${JSON.stringify(metadata)}::jsonb, now())`;
    await expect(
      event({ origin: 'PUBLIC_LINK', reason: 'PORTAL_QUOTE_ACCEPTED' }),
    ).resolves.toBe(1);
    await expect(
      event(
        { origin: 'PUBLIC_LINK', reason: 'PORTAL_QUOTE_ACCEPTED' },
        'UPDATE',
      ),
    ).rejects.toThrow(/audit_events_actor_check/);
    await expect(
      event({ origin: 'LINK', reason: 'PORTAL_QUOTE_ACCEPTED' }),
    ).rejects.toThrow(/audit_events_actor_check/);
    await expect(
      event({ origin: 'PUBLIC_LINK', reason: 'OTRA_COSA' }),
    ).rejects.toThrow(/audit_events_actor_check/);
  });

  it('email de confirmación: al paciente adulto, con la variante de portal y sin importes', async () => {
    const email = `maria.portal${++seq}@example.com`;
    // Centinela largo (DX-496): un importe que no aparece por azar.
    const { planId, cookie, contentHash } = await scene(email, 987654.32);
    mailer.clear();
    await accept(a, cookie, planId, { contentHash }).expect(200);
    const mails = await raw.emailOutbox.findMany({
      where: { tenantId: a.tenantId, referenceId: planId },
    });
    expect(mails).toHaveLength(1);
    expect(mails[0].template).toBe('SIGNATURE_BUDGET_ACCEPTED');
    await dispatcher.whenIdle();
    const mail = (await mailer.waitFor(email, /registramos tu aceptación/))
      .input;
    expect(mail).toContain('Lo verás como aceptado en tu portal de paciente');
    expect(mail).toContain('Hola, María');
    for (const leak of ['987654', '987.654', 'USD', 'zirconio']) {
      expect(mail).not.toContain(leak);
    }
  });

  it('email de confirmación de un MENOR: a su responsable (como DX-415), nunca al email de la ficha del menor', async () => {
    const MINOR_BIRTH = '2015-02-11';
    const minorEmail = `sofia.ortiz${++seq}@example.com`;
    const guardianEmail = `claudia.navarro${seq}@example.com`;
    const minor = await patient(a, minorEmail, MINOR_BIRTH);
    await staff(a)
      .post(`/patients/${minor}/responsible-parties`, {
        fullName: 'Claudia Navarro',
        email: guardianEmail,
        relationship: 'MOTHER',
        isPayer: false,
        documentType: 'NATIONAL_ID',
        docNumber: `C-${seq}`,
      })
      .expect(201);
    const planId = await plan(a, minor);
    const access = await link(a, minor);
    const cookie = await session(a, access.token, MINOR_BIRTH);
    const { contentHash } = await shown(a, cookie, planId);
    mailer.clear();
    await accept(a, cookie, planId, {
      contentHash,
      signerName: 'Claudia Navarro',
    }).expect(200);
    await dispatcher.whenIdle();
    const text = (
      await mailer.waitFor(guardianEmail, /registramos tu aceptación/)
    ).input;
    expect(text).toContain('Hola, Claudia');
    expect(mailer.sent.map((m) => m.to)).toEqual([guardianEmail]);
    expect(
      await raw.emailOutbox.count({
        where: { tenantId: a.tenantId, referenceId: planId },
      }),
    ).toBe(1);
  });

  it('sin destinatario (adulto sin email): se acepta y no se encola ningún email', async () => {
    const { planId, cookie, contentHash } = await scene();
    await accept(a, cookie, planId, { contentHash }).expect(200);
    expect(
      await raw.emailOutbox.count({
        where: { tenantId: a.tenantId, referenceId: planId },
      }),
    ).toBe(0);
  });

  it('DX-415 vivo: aceptado desde el portal, firmar después la solicitud viva da «Enlace no válido» (404), sin 500 ni segunda aceptación', async () => {
    const email = `marta.rios${++seq}@example.com`;
    const patientId = await patient(a, email);
    const planId = await plan(a, patientId);
    const live = await liveSignatureRequest(patientId, email, planId);
    const requestId = live.requestId;
    const sign = live.sign;
    const token = live.token;
    const signatureSession = live.session;

    // Entretanto acepta desde el portal.
    const access = await link(a, patientId);
    const cookie = await session(a, access.token);
    const { contentHash } = await shown(a, cookie, planId);
    await accept(a, cookie, planId, { contentHash }).expect(200);

    // La solicitud viva ya no sirve: el error de DX-415 para un presupuesto
    // que ya no se puede aceptar, sin 500.
    const res = await sign(
      `${token}/sign`,
      {
        signature: `data:image/png;base64,${PNG}`,
        accepted: true,
      },
      signatureSession,
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ message: SIGNATURE_LINK_INVALID_MESSAGE });
    const rows = await raw.treatmentPlanAcceptance.findMany({
      where: { planId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      patientAccessLinkId: access.id,
      signatureRequestId: null,
    });
    expect(
      (
        await raw.signatureRequest.findUniqueOrThrow({
          where: { id: requestId },
        })
      ).signedAt,
    ).toBeNull();
  });

  it('dos sedes: presentado en la sede B (no la más antigua), la aceptación del portal queda en B (plan, aceptación, evento y foto) y el hash cuadra', async () => {
    const sedeB = await raw.location.create({
      data: locationData(REGIONAL_CARACAS_FIXTURE, {
        tenantId: a.tenantId,
        name: `Sede Las Mercedes ${++seq}`,
        address: 'Av. Principal de Las Mercedes',
      }),
      select: { id: true, name: true },
    });
    const patientId = await patient(a);
    const planId = await plan(a, patientId, { locationId: sedeB.id });
    expect(
      (await raw.treatmentPlan.findUniqueOrThrow({ where: { id: planId } }))
        .presentedLocationId,
    ).toBe(sedeB.id);
    const access = await link(a, patientId);
    const cookie = await session(a, access.token);
    const res = await me(a, cookie).expect(200);
    const shownPlan = (
      res.body as {
        plans: (PortalPlan & { quote: { location: { name: string } } })[];
      }
    ).plans.find((p) => p.id === planId)!;
    expect(shownPlan.quote.location.name).toBe(sedeB.name);
    await accept(a, cookie, planId, {
      contentHash: shownPlan.contentHash,
    }).expect(200);

    const after = await raw.treatmentPlan.findUniqueOrThrow({
      where: { id: planId },
    });
    expect(after.acceptedLocationId).toBe(sedeB.id);
    const row = await raw.treatmentPlanAcceptance.findFirstOrThrow({
      where: { planId },
    });
    expect(row.locationId).toBe(sedeB.id);
    expect(row.contentHash).toBe(shownPlan.contentHash);
    expect(
      (parseQuoteContent(row.content) as { location: { id: string } }).location
        .id,
    ).toBe(sedeB.id);
    const event = await raw.auditEvent.findFirstOrThrow({
      where: {
        resourceType: 'TREATMENT_PLAN',
        resourceId: planId,
        action: 'SIGN',
      },
    });
    expect(event.locationId).toBe(sedeB.id);
  });

  it('A y B a la vez por el portal: una sola aceptación en el grupo; la otra, el 409 genérico; nunca 500', async () => {
    const patientId = await patient(a);
    const { a: optionA, b: optionB } = await optionsAB(a, patientId);
    const access = await link(a, patientId);
    const cookie = await session(a, access.token);
    const viewA = await shown(a, cookie, optionA);
    const viewB = await shown(a, cookie, optionB);
    const results = await Promise.all([
      accept(a, cookie, optionA, { contentHash: viewA.contentHash }),
      accept(a, cookie, optionB, { contentHash: viewB.contentHash }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body).toMatchObject(
      NOT_ACCEPTABLE,
    );
    expect(
      await raw.treatmentPlanAcceptance.count({
        where: { planId: { in: [optionA, optionB] } },
      }),
    ).toBe(1);
    const statuses = (
      await raw.treatmentPlan.findMany({
        where: { id: { in: [optionA, optionB] } },
        select: { status: true },
      })
    ).map((p) => p.status);
    expect(statuses.sort()).toEqual(['ACCEPTED', 'REJECTED']);
  });

  it('portal y enlace DX-415 a la vez sobre el mismo plan: una sola aceptación, sin 500', async () => {
    const email = `ana.mora${++seq}@example.com`;
    const patientId = await patient(a, email);
    const planId = await plan(a, patientId);
    const live = await liveSignatureRequest(patientId, email, planId);
    const access = await link(a, patientId);
    const cookie = await session(a, access.token);
    const { contentHash } = await shown(a, cookie, planId);
    const [portalRes, signRes] = await Promise.all([
      accept(a, cookie, planId, { contentHash }),
      live.sign(
        `${live.token}/sign`,
        { signature: `data:image/png;base64,${PNG}`, accepted: true },
        live.session,
      ),
    ]);
    expect(portalRes.status).toBeLessThan(500);
    expect(signRes.status).toBeLessThan(500);
    // Gana exactamente uno de los dos.
    const portalWon = portalRes.status === 200;
    expect([portalRes.status, signRes.status]).toEqual(
      portalWon ? [200, 404] : [409, 200],
    );
    if (!portalWon) expect(portalRes.body).toMatchObject(NOT_ACCEPTABLE);
    const rows = await raw.treatmentPlanAcceptance.findMany({
      where: { planId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].patientAccessLinkId !== null).toBe(portalWon);
    expect(rows[0].signatureRequestId !== null).toBe(!portalWon);
  });

  it('plan presentado sin validez guardada (anterior a DX-379): verlo en el portal la fija y aceptarlo al día siguiente sella esas fechas', async () => {
    const { patientId, planId, access } = await (async () => {
      const p = await patient(a);
      const id = await plan(a, p);
      return { patientId: p, planId: id, access: await link(a, p) };
    })();
    // Un plan antiguo: presentado sin fechas guardadas.
    await raw.$executeRaw`
      UPDATE "treatment_plans" SET "quoteIssuedOn" = NULL, "quoteValidUntil" = NULL
       WHERE "id" = ${planId}::uuid`;
    const cookie = await session(a, access.token);
    await shown(a, cookie, planId);
    // Mostrarlo en el portal lo «emite» (como imprimirlo o enviarlo).
    const fixed = await raw.treatmentPlan.findUniqueOrThrow({
      where: { id: planId },
    });
    expect(fixed.quoteIssuedOn).not.toBeNull();
    expect(fixed.quoteValidUntil).not.toBeNull();
    // Como si se hubiera mostrado AYER antes de medianoche: el hash depende
    // de las fechas guardadas, no del reloj de hoy.
    await raw.$executeRaw`
      UPDATE "treatment_plans"
         SET "quoteIssuedOn" = "quoteIssuedOn" - 1,
             "quoteValidUntil" = "quoteValidUntil" - 1
       WHERE "id" = ${planId}::uuid`;
    const yesterday = await raw.treatmentPlan.findUniqueOrThrow({
      where: { id: planId },
    });
    const { contentHash } = await shown(a, cookie, planId);
    await accept(a, cookie, planId, { contentHash }).expect(200);
    const row = await raw.treatmentPlanAcceptance.findFirstOrThrow({
      where: { planId, patientId },
    });
    const content = parseQuoteContent(row.content) as {
      issuedOn: string;
      validUntil: string;
    };
    const day = (d: Date | null) => d!.toISOString().slice(0, 10);
    expect(content.issuedOn).toBe(day(yesterday.quoteIssuedOn));
    expect(content.validUntil).toBe(day(yesterday.quoteValidUntil));
    expect(day(row.quoteValidUntil)).toBe(day(yesterday.quoteValidUntil));
  });

  it('acceptedById: quien compartió el portal dado de baja (users.deletedAt) → el creador del plan; ninguno activo → quien compartió (último recurso)', async () => {
    const reception = await seedMember(raw, a, 'RECEPTION');
    const receptionToken = await loginAs(app, a.host, reception.email);
    const dentist = await seedMember(raw, a, 'DENTIST');
    const dentistToken = await loginAs(app, a.host, dentist.email);
    const patientId = await patient(a);
    const first = await plan(a, patientId, { token: dentistToken });
    const second = await plan(a, patientId, { token: dentistToken });
    const res = await staff(a, { token: receptionToken })
      .post(`/patients/${patientId}/access-links`, { scopes: ['PLANS'] })
      .expect(201);
    const access = res.body as { id: string; url: string };
    const cookie = await session(a, access.url.split('/mi-clinica/')[1]);

    // 1. Recepción dada de baja como usuario (la membresía sigue viva).
    await raw.user.update({
      where: { id: reception.userId },
      data: { deletedAt: new Date() },
    });
    const h1 = (await shown(a, cookie, first)).contentHash;
    await accept(a, cookie, first, { contentHash: h1 }).expect(200);
    expect(
      (
        await raw.treatmentPlanAcceptance.findFirstOrThrow({
          where: { planId: first },
        })
      ).acceptedById,
    ).toBe(dentist.userId);

    // 2. Y el creador del plan deja la clínica: último recurso, recepción.
    await raw.clinicMembership.updateMany({
      where: { tenantId: a.tenantId, userId: dentist.userId },
      data: { deletedAt: new Date() },
    });
    const h2 = (await shown(a, cookie, second)).contentHash;
    await accept(a, cookie, second, { contentHash: h2 }).expect(200);
    expect(
      (
        await raw.treatmentPlanAcceptance.findFirstOrThrow({
          where: { planId: second },
        })
      ).acceptedById,
    ).toBe(reception.userId);
  });

  it('fusión de pacientes (DX-266): una aceptación del portal del absorbido pasa al conservado con su enlace', async () => {
    const kept = await patient(a);
    const {
      patientId: absorbed,
      planId,
      access,
      cookie,
      contentHash,
    } = await scene();
    await accept(a, cookie, planId, { contentHash }).expect(200);
    const merged = await staff(a)
      .post('/patient-duplicates/merge', { keptId: kept, absorbedId: absorbed })
      .expect((r) => {
        if (r.status !== 201) throw new Error(JSON.stringify(r.body));
      });
    expect(merged.status).toBe(201);
    const row = await raw.treatmentPlanAcceptance.findFirstOrThrow({
      where: { planId },
    });
    expect(row).toMatchObject({
      patientId: kept,
      patientAccessLinkId: access.id,
    });
    const linkRow = await raw.patientAccessLink.findUniqueOrThrow({
      where: { id: access.id },
    });
    expect(linkRow.patientId).toBe(kept);
    expect(
      (await raw.treatmentPlan.findUniqueOrThrow({ where: { id: planId } }))
        .patientId,
    ).toBe(kept);
  });
});
