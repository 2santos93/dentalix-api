import { HttpException, HttpStatus } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaEmailOutboxRepository } from '../src/modules/notifications/email/infrastructure/repositories/prisma-email-outbox.repository';
import { EmailPayloadCipher } from '../src/modules/notifications/email/infrastructure/email-payload-cipher';
import type { EmailDispatcher } from '../src/modules/notifications/email/application/email-dispatcher.service';
import { EmailOutbox } from '../src/modules/notifications/email/application/email-outbox.service';
import type { MailConfig } from '../src/modules/notifications/email/infrastructure/mail-config';
import { OutboxSignatureEmailSender } from '../src/modules/signature-requests/application/signature-email';
import { OutboxPostOpEmailSender } from '../src/modules/post-op-instructions/application/postop-email';
import { OutboxSlotOfferEmailSender } from '../src/modules/waitlist/application/slot-offer-email';
import { OutboxReceiptEmailSender } from '../src/modules/payments/infrastructure/receipts/outbox-receipt-email-sender';
import {
  OutboxSignedPdfCopyEmailSender,
  SignedPdfCopySender,
} from '../src/modules/consents/application/signed-pdf-copy.service';
import { PrismaSignatureRequestRepository } from '../src/modules/signature-requests/infrastructure/prisma-signature-request.repository';
import {
  generateSignatureToken,
  hashSignatureToken,
} from '../src/modules/signature-requests/domain/signature-token';
import { PrismaPatientConsentRepository } from '../src/modules/consents/infrastructure/repositories/prisma-patient-consent.repository';
import { PrismaSignedPdfCopyRepository } from '../src/modules/consents/infrastructure/repositories/prisma-signed-pdf-copy.repository';
import {
  buildReceiptSnapshot,
  receiptPatientView,
} from '../src/modules/payments/domain/receipt-snapshot';
import type { PaymentReceiptView } from '../src/modules/payments/domain/entities/payment-receipt.entity';
import { NO_LOCAL_NAMES } from '../src/modules/document-type-names/__fixtures__/fixed-document-type-names.reader';
import {
  type Outcome,
  pauseAfterSql,
  settle,
  sqlStop,
  waitForLockWaiters,
} from './support/postgres-concurrency';
import { purgeTenants } from './support/tenant-purge';
import { signedConsentFixtures } from './support/signed-consent-fixtures';

/**
 * DX-149-ter: las cinco rutas de email que dispara el personal (firma a
 * distancia, indicaciones postoperatorias, oferta de hueco, recibo de cobro y
 * copia del PDF firmado) encolan con `enforceQuota`: el tope del destinatario
 * se cuenta e inserta bajo el candado de la clínica y del destinatario. N
 * envíos a la vez al mismo paciente: uno sale (enfriamiento) y los demás son
 * el 429 en español de cada ruta, nunca un 500. Las tres que encolan fuera
 * de otra transacción comparten mecanismo (el adaptador de cada una sobre
 * EmailOutbox) y el caso es parametrizado. DX-149-quater (L5): la firma a
 * distancia y la copia del PDF firmado encolan DENTRO de su transacción
 * (`repo.create`, `issueLink`), así que van por ese camino real, con todos
 * sus candados en orden: paciente → documento → outbox → destinatario →
 * clínica.
 * Paralelo real: el primero se para con su fila insertada (sin confirmar) y
 * el resto TIENE que estar esperando su candado (pg_locks), sin reloj.
 */
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const N = 10;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
process.env.DATABASE_URL = withConnectionLimit(
  ORIGINAL_DATABASE_URL ?? '',
  N * 2,
);
const prisma = new PrismaService(tenantContext);

function withConnectionLimit(url: string, limit: number): string {
  const parsed = new URL(url);
  parsed.searchParams.set('connection_limit', String(limit));
  return parsed.toString();
}

const cipher = new EmailPayloadCipher(randomBytes(32));
const SUFFIX = `${process.pid}-${Date.now()}`;
const tenants: string[] = [];
const INSERT_OUTBOX = /INSERT INTO "email_outbox"/;
const noKick = { kick: () => undefined } as unknown as EmailDispatcher;

const outbox = new EmailOutbox(
  new PrismaEmailOutboxRepository(prisma),
  cipher,
  noKick,
  {
    transport: 'console',
    smtpUrl: null,
    fileDir: null,
    from: 'no-reply@dentalix.test',
    dispatchIntervalMs: 0,
    retryBaseMs: 60_000,
    leaseSeconds: 300,
    batchSize: 20,
    encryptionKey: randomBytes(32),
    ephemeralKey: false,
    production: false,
    quotas: {
      tenantDaily: 50,
      recipientDaily: 5,
      recipientCooldownSeconds: 60,
    },
    platformQuotas: { recipientDaily: 1000, recipientCooldownSeconds: 0 },
  } satisfies MailConfig,
);

const stored = buildReceiptSnapshot(
  {
    clinic: {
      name: 'Clínica Dental Altamira',
      legalName: null,
      taxId: null,
      address: null,
    },
    location: { id: randomUUID(), name: 'Sede Chacao', address: null },
    patient: {
      id: randomUUID(),
      firstName: 'María',
      lastName: 'González',
      docType: 'NATIONAL_ID',
      docTypeLabel: null,
      docNumber: 'V-12345678',
    },
    payment: {
      id: randomUUID(),
      amount: 40,
      currency: 'USD',
      method: 'CASH',
      paidAt: new Date('2026-11-05T15:00:00.000Z'),
      paidOn: '2026-11-05',
    },
    plan: null,
    planBalance: null,
    cashier: { id: randomUUID(), fullName: 'Recepción Chacao' },
  },
  NO_LOCAL_NAMES,
);
const receipt: PaymentReceiptView = {
  paymentId: randomUUID(),
  reference: 'CHA-000042',
  seriesPrefix: 'CHA',
  number: 42,
  legacy: false,
  issuedAt: new Date('2026-11-05T15:00:05.000Z'),
  voided: false,
  voidedAt: null,
  voidReason: null,
  exchangeRate: null,
  split: null,
  // Congelado al emitir: el adaptador no lee la sede.
  regional: { timeZone: 'America/Caracas', locale: 'es-VE', hourCycle: 'h12' },
  snapshot: { ...stored, patient: receiptPatientView(stored, NO_LOCAL_NAMES) },
};

const URL_BASE = 'https://altamira.dentalix.app';

/** Un envío de cada ruta, tal como lo hace su caso de uso. */
const PATHS: { name: string; send: (to: string) => Promise<unknown> }[] = [
  {
    name: 'instrucciones postoperatorias',
    send: (to) =>
      new OutboxPostOpEmailSender(outbox, tenantContext).send({
        to,
        referenceId: randomUUID(),
        vars: {
          patientFirstName: 'María',
          clinicName: 'Clínica Dental Altamira',
          locationPhone: '+58 212 555 0101',
          url: `${URL_BASE}/indicaciones/abc`,
          responsibleName: null,
        },
      }),
  },
  {
    name: 'oferta de hueco liberado',
    send: (to) =>
      new OutboxSlotOfferEmailSender(outbox, tenantContext).send({
        to,
        referenceId: randomUUID(),
        vars: {
          patientFirstName: 'María',
          clinicName: 'Clínica Dental Altamira',
          slotLabel: 'viernes 7 de noviembre, 9:00 a. m.',
          locationName: 'Sede Chacao',
          providerName: 'Dra. Carmen Rojas',
          url: `${URL_BASE}/oferta/abc`,
          expiresAtLabel: 'jueves 6 de noviembre, 8:00 p. m.',
        },
      }),
  },
  {
    name: 'recibo de cobro',
    send: (to) =>
      new OutboxReceiptEmailSender(outbox, tenantContext, prisma).send(
        to,
        receipt,
      ),
  },
];

async function newTenant(label: string): Promise<string> {
  const { id } = await raw.tenant.create({
    data: {
      name: `Clínica Dental Altamira ${label}`,
      subdomain: `dx149ter-${label}-${SUFFIX}`.slice(0, 63),
    },
  });
  tenants.push(id);
  return id;
}

async function raceBehindFirstInsert<T>(
  n: number,
  run: () => Promise<T>,
): Promise<Outcome<T>[]> {
  const stop = sqlStop(INSERT_OUTBOX);
  const restore = pauseAfterSql(prisma, [stop]);
  try {
    const all = Array.from({ length: n }, () => settle(run()));
    const holder = await stop.reached.wait;
    await waitForLockWaiters(raw, [holder], n - 1);
    stop.release.open();
    return await Promise.all(all);
  } finally {
    restore();
  }
}

/** Uno sale; los demás son el 429 en español del enfriamiento, nunca un 500. */
function expectOneSentRestAre429(outcomes: Outcome<unknown>[]): void {
  expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
  const errors = outcomes
    .filter((o) => o.status === 'rejected')
    .map((o) => (o as { reason: unknown }).reason);
  expect(errors).toHaveLength(outcomes.length - 1);
  for (const error of errors) {
    expect(error).toBeInstanceOf(HttpException);
    const http = error as HttpException;
    expect(http.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(http.getResponse()).toMatchObject({
      message: expect.stringMatching(
        /^Ya enviamos un correo a esta persona/,
      ) as string,
      retryAfterSeconds: expect.any(Number) as number,
    });
  }
}

// DX-149-quater (L5): la firma a distancia y el PDF firmado, por su
// repositorio real (`create`, `issueLink`) con los datos que piden.
const signatures = new PrismaSignatureRequestRepository(prisma, tenantContext);
const copies = new PrismaSignedPdfCopyRepository(prisma, tenantContext);
const { seedClinic, remoteSigned } = signedConsentFixtures({
  owner: raw,
  tenantContext,
  requests: signatures,
  consents: new PrismaPatientConsentRepository(prisma, tenantContext),
});
const seededUsers: string[] = [];

async function seededClinic(label: string) {
  const seeded = await seedClinic(`dx149q-${label}-${SUFFIX}`.slice(0, 63));
  tenants.push(seeded.tenantId);
  seededUsers.push(seeded.userId);
  return seeded;
}

describe('DX-149-ter · topes con candado en las rutas del personal (int)', () => {
  beforeAll(async () => {
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await purgeTenants(raw, tenants);
    await raw.user.deleteMany({ where: { id: { in: seededUsers } } });
    await raw.$disconnect();
    await prisma.$disconnect();
    process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  });

  it.each(PATHS.map((p, i) => [p.name, i] as const))(
    `%s: ${N} envíos a la vez al mismo paciente, uno sale y los demás son 429 en español`,
    async (_name, index) => {
      const tenantId = await newTenant(`ruta${index}`);
      const to = `maria.gonzalez.${index}.${SUFFIX}@correo-caracas.test`;

      const outcomes = await raceBehindFirstInsert(N, () =>
        tenantContext.run(tenantId, () => PATHS[index].send(to)),
      );

      expectOneSentRestAre429(outcomes);
      expect(
        await raw.emailOutbox.count({
          where: { tenantId, toHash: cipher.hashRecipient(to) },
        }),
      ).toBe(1);
    },
  );

  it(`solicitud de firma a distancia por repo.create: ${N} documentos a la vez al mismo paciente, uno sale, 429 en los demás y ninguna solicitud de más`, async () => {
    const s = await seededClinic('firma');
    // Un documento distinto por envío: el índice de «un enlace vivo por
    // documento» no interviene y quien los ordena es el tope del destinatario.
    const templates = [s.templateId];
    for (let i = 1; i < N; i++) {
      const { id } = await raw.consentTemplate.create({
        data: {
          tenantId: s.tenantId,
          title: `Consentimiento ${i}`,
          body: 'Texto',
        },
      });
      templates.push(id);
    }
    const to = `maria.gonzalez.firma.${SUFFIX}@correo-caracas.test`;
    const sender = new OutboxSignatureEmailSender(outbox, tenantContext);
    let next = 0;
    // Como el caso de uso: email preparado antes y encolado al final de la
    // transacción de `create` (paciente → solicitudes → outbox → candados).
    const send = async () => {
      const templateId = templates[next++];
      const id = randomUUID();
      const mail = await sender.prepareLink({
        to,
        referenceId: id,
        vars: {
          recipientFirstName: 'María',
          patientFirstName: null,
          clinicName: 'Clínica Dental Altamira',
          url: `${URL_BASE}/firmar/abc`,
          expiresAtLabel: '6 de noviembre de 2026, 5:00 p. m.',
        },
      });
      const now = new Date();
      await signatures.create(
        {
          id,
          locationId: s.locationId,
          patientId: s.patientId,
          type: 'CONSENT',
          channel: 'EMAIL',
          templateId,
          templateVersion: 1,
          treatmentPlanId: null,
          title: 'Consentimiento — Exodoncia',
          body: 'Yo, María González, autorizo la exodoncia.',
          professionalUserId: s.userId,
          professionalName: 'Dra. Carmen Rojas',
          signerType: 'PATIENT',
          signerName: 'María González',
          signerDocument: null,
          destination: to,
          destinationMasked: 'ma***@correo-caracas.test',
          tokenHash: hashSignatureToken(generateSignatureToken()),
          expiresAt: new Date(now.getTime() + 72 * 3600_000),
          createdById: s.userId,
          createdAt: now,
        },
        (tx, superseded) => mail.insert(tx, superseded),
      );
    };

    const outcomes = await raceBehindFirstInsert(N, () =>
      tenantContext.run(s.tenantId, send),
    );

    expectOneSentRestAre429(outcomes);
    expect(
      await raw.emailOutbox.count({
        where: { tenantId: s.tenantId, toHash: cipher.hashRecipient(to) },
      }),
    ).toBe(1);
    // Los 429 se deshicieron enteros: queda la solicitud del que salió.
    expect(
      await raw.signatureRequest.count({ where: { patientId: s.patientId } }),
    ).toBe(1);
  });

  it(`copia del PDF firmado por issueLink (reenvío): ${N} a la vez de dos consentimientos al mismo firmante, uno sale y un solo enlace vivo`, async () => {
    const s = await seededClinic('pdf');
    const consentIds = [await remoteSigned(s), await remoteSigned(s)];
    for (const consentId of consentIds) {
      await raw.signedConsentPdf.create({
        data: { tenantId: s.tenantId, patientId: s.patientId, consentId },
      });
    }
    const targets = await tenantContext.run(s.tenantId, () =>
      Promise.all(consentIds.map((id) => copies.loadTarget(id))),
    );
    const pdfSender = new SignedPdfCopySender(
      copies,
      new OutboxSignedPdfCopyEmailSender(outbox, tenantContext),
      { forTenant: () => Promise.resolve(URL_BASE) },
      tenantContext,
      { ttlHours: 168 },
      () => new Date(),
    );
    let next = 0;
    // Como «Reenviar copia»: enlace nuevo, revocación del anterior y email en
    // la transacción de `issueLink` (paciente → PDF → enlaces → candados).
    const send = () =>
      pdfSender.send(targets[next++ % targets.length]!, s.userId, undefined, {
        enforceQuota: true,
      });

    const outcomes = await raceBehindFirstInsert(N, () =>
      tenantContext.run(s.tenantId, send),
    );

    expectOneSentRestAre429(outcomes);
    expect(
      await raw.emailOutbox.count({
        where: {
          tenantId: s.tenantId,
          template: 'SIGNED_CONSENT_COPY',
        },
      }),
    ).toBe(1);
    expect(
      await raw.signedConsentPdfLink.count({
        where: { consentId: { in: consentIds }, revokedAt: null },
      }),
    ).toBe(1);
  });
});
