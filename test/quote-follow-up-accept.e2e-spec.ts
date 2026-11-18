import { INestApplication } from '@nestjs/common';
import { CatalogKind, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { EmailDispatcher } from '../src/modules/notifications/email/application/email-dispatcher.service';
import { MAILER } from '../src/modules/notifications/email/domain/ports/mailer.port';
import {
  MAIL_CONFIG,
  loadMailConfig,
} from '../src/modules/notifications/email/infrastructure/mail-config';
import { QuoteFollowUpSender } from '../src/modules/quote-follow-up/application/quote-follow-up-sender';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { CapturingMailer } from './support/capture-mailer';
import { createE2eApp } from './support/create-e2e-app';
import {
  type Clinic,
  registerClinic,
  resetDatabase,
} from './support/e2e-fixtures';
import { seedParProviderRates } from './support/par-provider-rates';
import { signaturePng } from './support/png-fixtures';

// DX-561 por HTTP: el paciente acepta el presupuesto desde el enlace del AVISO
// de seguimiento (solicitud de origen FOLLOW_UP, sin usuario): pide el código,
// lo verifica y firma. El plan queda ACCEPTED a nombre del profesional del
// presupuesto (quien lo elaboró), no de un usuario inexistente.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const EMAIL = 'lucia.mendoza@example.com';
const TOKEN_IN_TEXT = /\/firmar\/([A-Za-z0-9_-]{43})/;
const CODE_IN_TEXT = /Tu código de verificación es: (\d{6})/;
const SIGNATURE = `data:image/png;base64,${signaturePng(300, 100).toString('base64')}`;
const UA = 'Mozilla/5.0 (iPhone) e2e';
const DAY_MS = 24 * 60 * 60 * 1000;

let dropParRates: (() => Promise<void>) | undefined;

describe('Aceptar desde el aviso de seguimiento (e2e, DX-561)', () => {
  let app: INestApplication<App>;
  let dispatcher: EmailDispatcher;
  const mailer = new CapturingMailer();
  let clinic: Clinic;
  let patientId: string;
  let catalogItemId: string;
  let locationId: string;

  const server = () => request(app.getHttpServer());
  const as = (path: string, body?: object) =>
    server()
      .post(`/api/v1${path}`)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${clinic.adminToken}`)
      .send(body ?? {});
  const pub = (path: string, body: object = {}, session?: string) => {
    const req = server()
      .post(`/api/v1/public/sign/${path}`)
      .set('X-Tenant-Host', clinic.host)
      .set('User-Agent', UA);
    return (session ? req.set('X-Signature-Session', session) : req).send(body);
  };

  beforeAll(async () => {
    await resetDatabase(raw);
    dropParRates ??= await seedParProviderRates(raw);
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
    clinic = await registerClinic(app, 'dx561-acepta');
    locationId = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: clinic.tenantId },
        orderBy: { createdAt: 'asc' },
      })
    ).id;
    const patient = await as('/patients', {
      docType: 'NATIONAL_ID',
      sex: 'F',
      firstName: 'Lucía',
      lastName: 'Mendoza',
      docNumber: 'DX561-1',
      email: EMAIL,
      birthDate: '1985-02-11',
    }).expect(201);
    patientId = (patient.body as { id: string }).id;
    const catalog = await as('/catalog/items', {
      code: 'DX561-RES',
      kind: CatalogKind.PROCEDURE,
      labelEs: 'Resina compuesta',
      color: '#2A2B3C',
      defaultPrice: 1,
    }).expect(201);
    catalogItemId = (catalog.body as { id: string }).id;
    // Seguimiento activo todo el día (la franja la prueba el int).
    await server()
      .put(`/api/v1/quote-follow-up-settings/${locationId}`)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${clinic.adminToken}`)
      .send({
        enabled: true,
        offsetsDays: [3, 10, 21],
        sendFromHour: 0,
        sendUntilHour: 24,
      })
      .expect(200);
  });

  afterAll(async () => {
    await dropParRates?.();
    await app.close();
    await resetDatabase(raw);
    await raw.$disconnect();
  });

  it('aviso → código → firmar: el plan queda ACCEPTED a nombre de quien lo elaboró y el aviso cuenta como aceptado', async () => {
    const plan = await as(`/patients/${patientId}/treatment-plans`, {
      currency: 'USD',
    }).expect(201);
    const planId = (plan.body as { id: string }).id;
    await as(`/treatment-plans/${planId}/items`, {
      toothNumber: '36',
      catalogItemId,
      price: 85,
    }).expect(201);
    await as(`/treatment-plans/${planId}/present`).expect(200);
    // Presentado hace 3 días (y 5 minutos): el paso 1 vence hoy.
    await raw.treatmentPlan.update({
      where: { id: planId },
      data: { presentedAt: new Date(Date.now() - 3 * DAY_MS - 5 * 60_000) },
    });

    mailer.clear();
    const outcome = await app
      .get(TenantContextService)
      .run(clinic.tenantId, () =>
        app.get(QuoteFollowUpSender).send(clinic.tenantId, planId, 1),
      );
    expect(outcome).toBe('SENT');
    await dispatcher.whenIdle();
    const token = (await mailer.waitFor(EMAIL, TOKEN_IN_TEXT))[1];
    const request_ = await raw.signatureRequest.findFirstOrThrow({
      where: { treatmentPlanId: planId, origin: 'FOLLOW_UP' },
    });
    expect(request_).toMatchObject({ createdById: null, revokedAt: null });

    mailer.clear();
    await pub(`${token}/code`).expect(200);
    await dispatcher.whenIdle();
    const code = (await mailer.waitFor(EMAIL, CODE_IN_TEXT))[1];
    const verified = await pub(`${token}/verify`, { code }).expect(200);
    const session = (verified.body as { sessionToken: string }).sessionToken;
    await pub(
      `${token}/sign`,
      { signature: SIGNATURE, accepted: true },
      session,
    ).expect(200);

    const accepted = await raw.treatmentPlan.findUniqueOrThrow({
      where: { id: planId },
      select: {
        status: true,
        acceptedAt: true,
        acceptance: {
          select: { acceptedById: true, signatureRequestId: true },
        },
      },
    });
    expect(accepted).toMatchObject({
      status: 'ACCEPTED',
      acceptance: {
        acceptedById: clinic.adminUserId,
        signatureRequestId: request_.id,
      },
    });
    expect(request_.professionalUserId).toBe(clinic.adminUserId);

    // El informe lo cuenta: enviado, abierto y aceptado en 14 días.
    const from = new Date(Date.now() - 2 * DAY_MS).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 2 * DAY_MS).toISOString().slice(0, 10);
    const report = await server()
      .get(`/api/v1/reports/quote-follow-up?from=${from}&to=${to}`)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${clinic.adminToken}`)
      .expect(200);
    expect(report.body).toMatchObject({
      total: {
        sent: 1,
        opened: 1,
        acceptedWithin14Days: 1,
        acceptanceRate: 100,
      },
    });
  });
});
