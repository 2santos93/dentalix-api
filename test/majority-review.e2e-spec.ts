import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import { CapturingMailer } from './support/capture-mailer';
import { MAILER } from '../src/modules/notifications/email/domain/ports/mailer.port';
import {
  type Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationBody,
} from './support/location-fixtures';
import { addCivilDays, civilDateIn } from '../src/shared/time/civil-day';
import { safeTodayZone, sedeTodayFixture } from './support/sede-clock';
import { majorityDateOf } from '../src/modules/patients/domain/responsible-parties/majority-review';
import { PATIENT_WITHOUT_EMAIL_MESSAGE } from '../src/modules/payments/application/receipts/send-payment-receipt.use-case';
import { MAJORITY_REVIEW_FORBIDDEN_MESSAGE } from '../src/modules/patients/presentation/patient-majority-review.controller';
import {
  MAJORITY_REVIEW_MINOR_MESSAGE,
  COMING_OF_AGE_PERIOD_TOO_LONG_MESSAGE,
} from '../src/modules/patients/application/use-cases/majority-review.use-cases';

// DX-342 en HTTP real: lista «Pasan a la mayoría de edad» (rango, atrasados y
// sede de un miembro restringido), revisión GET/POST con su auditoría, 403 de
// DENTIST/ASSISTANT, 404 de otra clínica y que el recibo por email (DX-136)
// de un paciente que cumplió la mayoría de edad sin revisar y sin email da
// 422 en vez de ir al responsable. DIRECT_URL solo retrocede el alta de los
// responsables («de cuando era menor»), siembra citas atendidas y lee la
// auditoría y el outbox.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

// La sede principal, en una zona lejos de su medianoche (DX-449): «hoy» no
// cambia mientras corre la suite.
const FIXTURE = sedeTodayFixture();
const ZONE = safeTodayZone();
const CHILDHOOD = new Date('2014-06-01T15:00:00.000Z');

interface ReviewView {
  status: 'NOT_APPLICABLE' | 'PENDING' | 'REVIEWED';
  majorityDate: string | null;
  decision: 'PATIENT_SELF' | 'KEEP_RESPONSIBLE' | null;
  reviewedAt: string | null;
  reviewedByName: string | null;
  responsibles: {
    id: string;
    name: string;
    relationship: string;
    receivesNotices: boolean;
    isPayer: boolean;
  }[];
}

interface ListView {
  from: string;
  to: string;
  majorityAge: number;
  restrictedToLocations: boolean;
  items: {
    patientId: string;
    fullName: string;
    majorityDate: string;
    majorityAge: number;
    status: string;
    overdue: boolean;
    responsiblesCount: number;
    locationName: string | null;
  }[];
}

/** El día `day` menos `years` años (29/2 → 28/2 en un año no bisiesto). */
function minusYears(day: string, years: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const year = y - years;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const dd = m === 2 && d === 29 && !leap ? 28 : d;
  return `${year}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

describe('Paso a la mayoría de edad (e2e, DX-342)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  const tokens = {} as Record<ClinicRole, string>;
  let restrictedToken: string;
  let principalId: string;
  let altamiraId: string;
  let today: string;
  let from: string;
  let to: string;
  const ids = {} as Record<
    'pending' | 'overdue' | 'upcoming' | 'elder' | 'altamira',
    string
  >;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string, host = clinic.host) =>
    req.set('X-Tenant-Host', host).set('Authorization', `Bearer ${token}`);
  const review = (id: string) => `/api/v1/patients/${id}/majority-review`;
  const listPath = (f = from, t = to, extra = '') =>
    `/api/v1/patients/coming-of-age?from=${f}&to=${t}${extra}`;

  /** Nacido para cumplir 18 a `offset` días de hoy en la sede. */
  const bornFor = (offset: number) =>
    minusYears(addCivilDays(today, offset), 18);

  async function createPatient(
    firstName: string,
    birthDate: string,
    email: string | null = null,
  ): Promise<string> {
    const res = await as(api().post('/api/v1/patients'), clinic.adminToken)
      .send({
        firstName,
        lastName: 'Rondón',
        docType: 'NATIONAL_ID',
        docNumber: String(Math.floor(1e7 + Math.random() * 8.9e7)),
        sex: 'F',
        birthDate,
        ...(email ? { email } : {}),
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  async function addMother(patientId: string, createdAt: Date | null) {
    const res = await as(
      api().post(`/api/v1/patients/${patientId}/responsible-parties`),
      clinic.adminToken,
    )
      .send({
        fullName: 'Carmen Rondón',
        relationship: 'MOTHER',
        email: 'carmen.rondon@example.com',
        isPayer: true,
      })
      .expect(201);
    const id = (res.body as { id: string }).id;
    if (createdAt) {
      await raw.patientResponsibleParty.update({
        where: { id },
        data: { createdAt },
      });
    }
    return id;
  }

  let slot = 0;
  async function completedAt(patientId: string, locationId: string) {
    // Una hora distinta por cita: el mismo profesional no se solapa.
    const start = new Date(Date.UTC(2025, 5, 10, 13 + slot++));
    await raw.appointment.create({
      data: {
        tenantId: clinic.tenantId,
        locationId,
        patientId,
        providerId: clinic.adminUserId,
        start,
        end: new Date(start.getTime() + 30 * 60 * 1000),
        status: 'COMPLETED',
      },
    });
  }

  beforeAll(async () => {
    app = await createE2eApp({
      override: (builder) => {
        builder.overrideProvider(MAILER).useValue(new CapturingMailer());
      },
    });
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx342-e2e', FIXTURE);
    other = await registerClinic(app, 'dx342-e2e-otra', FIXTURE);
    tokens.ADMIN = clinic.adminToken;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
      ClinicRole.RECEPTION,
    ]) {
      const member = await seedMember(raw, clinic, role);
      tokens[role] = await loginAs(app, clinic.host, member.email);
    }
    today = civilDateIn(new Date(), ZONE);
    from = addCivilDays(today, -30);
    to = addCivilDays(today, 30);

    principalId = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: clinic.tenantId },
        select: { id: true },
      })
    ).id;
    altamiraId = (
      (
        await as(api().post('/api/v1/locations'), clinic.adminToken)
          .send(
            locationBody(REGIONAL_CARACAS_FIXTURE, { name: 'Sede Altamira' }),
          )
          .expect(201)
      ).body as { id: string }
    ).id;

    // Cumplió 18 hace 10 días, sin email: madre dada de alta de niña.
    ids.pending = await createPatient('Sofía', bornFor(-10));
    await addMother(ids.pending, CHILDHOOD);
    await completedAt(ids.pending, principalId);
    // Cumplió 18 hace 200 días y nadie lo revisó: atrasado.
    ids.overdue = await createPatient('Valentina', bornFor(-200));
    await addMother(ids.overdue, CHILDHOOD);
    await completedAt(ids.overdue, principalId);
    // Cumple 18 dentro de 10 días: aún menor.
    ids.upcoming = await createPatient('Camila', bornFor(10));
    await addMother(ids.upcoming, null);
    await completedAt(ids.upcoming, principalId);
    // Adulta mayor con responsable dado de alta ya adulta: no aplica.
    ids.elder = await createPatient('Rosa', '1950-03-03');
    await addMother(ids.elder, null);
    // Cumplió 18 hace 5 días; atendida en Altamira.
    ids.altamira = await createPatient('Daniela', bornFor(-5));
    await addMother(ids.altamira, CHILDHOOD);
    await completedAt(ids.altamira, altamiraId);

    // Recepción restringida a la sede principal (DX-525).
    const reception = await raw.user.findFirstOrThrow({
      where: { email: `reception@${clinic.subdomain}.test` },
      select: { passwordHash: true },
    });
    const restricted = await raw.user.create({
      data: {
        email: `restringida@${clinic.subdomain}.test`,
        passwordHash: reception.passwordHash,
        fullName: 'Recepción Chacao',
        emailVerifiedAt: new Date(),
      },
    });
    await raw.clinicMembership.create({
      data: {
        tenantId: clinic.tenantId,
        userId: restricted.id,
        role: ClinicRole.RECEPTION,
      },
    });
    await as(
      api().put(`/api/v1/staff/${restricted.id}/locations`),
      clinic.adminToken,
    )
      .send({ locationIds: [principalId] })
      .expect(200);
    restrictedToken = await loginAs(app, clinic.host, restricted.email);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await resetDatabase(raw);
    await raw.$disconnect();
  });

  it('lists the range plus the overdue PENDING, overdue first; the elderly patient is not there', async () => {
    const res = await as(api().get(listPath()), tokens.RECEPTION).expect(200);
    const body = res.body as ListView;
    expect(body).toMatchObject({
      from,
      to,
      majorityAge: 18,
      restrictedToLocations: false,
    });
    expect(body.items.map((i) => [i.patientId, i.status, i.overdue])).toEqual([
      [ids.overdue, 'PENDING', true],
      [ids.pending, 'PENDING', false],
      [ids.altamira, 'PENDING', false],
      [ids.upcoming, 'NOT_APPLICABLE', false],
    ]);
    expect(body.items[1]).toMatchObject({
      fullName: 'Sofía Rondón',
      majorityDate: majorityDateOf(
        new Date(`${bornFor(-10)}T00:00:00.000Z`),
        18,
      ),
      majorityAge: 18,
      responsiblesCount: 1,
      locationName: 'Sede principal',
    });
    expect(body.items[2].locationName).toBe('Sede Altamira');
  });

  it('a restricted member only sees the patients of their sedes; another sede is 403', async () => {
    const res = await as(api().get(listPath()), restrictedToken).expect(200);
    const body = res.body as ListView;
    expect(body.restrictedToLocations).toBe(true);
    expect(body.items.map((i) => i.patientId)).toEqual([
      ids.overdue,
      ids.pending,
      ids.upcoming,
    ]);
    await as(
      api().get(listPath(from, to, `&locationId=${altamiraId}`)),
      restrictedToken,
    ).expect(403);
    const altamira = await as(
      api().get(listPath(from, to, `&locationId=${altamiraId}`)),
      tokens.ADMIN,
    ).expect(200);
    expect((altamira.body as ListView).items.map((i) => i.patientId)).toEqual([
      ids.altamira,
    ]);
  });

  it('400 in Spanish for more than 366 days; 403 in Spanish for DENTIST and ASSISTANT', async () => {
    const long = await as(
      api().get(listPath('2026-01-01', '2027-01-02')),
      tokens.ADMIN,
    ).expect(400);
    expect((long.body as { message: string }).message).toBe(
      COMING_OF_AGE_PERIOD_TOO_LONG_MESSAGE,
    );
    for (const role of [ClinicRole.DENTIST, ClinicRole.ASSISTANT]) {
      const list = await as(api().get(listPath()), tokens[role]).expect(403);
      expect((list.body as { message: string }).message).toBe(
        MAJORITY_REVIEW_FORBIDDEN_MESSAGE,
      );
      const post = await as(api().post(review(ids.pending)), tokens[role])
        .send({ decision: 'PATIENT_SELF' })
        .expect(403);
      expect((post.body as { message: string }).message).toBe(
        MAJORITY_REVIEW_FORBIDDEN_MESSAGE,
      );
    }
    // El estado del aviso de la ficha lo leen los 4 roles.
    await as(api().get(review(ids.pending)), tokens.DENTIST).expect(200);
  });

  it('a came-of-age unreviewed patient without email: the receipt email is 422, never the responsible', async () => {
    const plan = await as(
      api().post(`/api/v1/patients/${ids.pending}/treatment-plans`),
      tokens.ADMIN,
    )
      .send({ currency: 'USD' })
      .expect(201);
    const payment = await as(
      api().post(
        `/api/v1/treatment-plans/${(plan.body as { id: string }).id}/payments`,
      ),
      tokens.RECEPTION,
    )
      .send({
        amount: 25,
        currency: 'USD',
        paidAt: new Date().toISOString(),
        method: 'CASH',
      })
      .expect(201);
    const paymentId = (payment.body as { id: string }).id;
    const blocked = await as(
      api().post(`/api/v1/payments/${paymentId}/receipt/email`),
      tokens.RECEPTION,
    ).expect(422);
    expect((blocked.body as { message: string }).message).toBe(
      PATIENT_WITHOUT_EMAIL_MESSAGE,
    );
    expect(
      await raw.emailOutbox.count({
        where: { tenantId: clinic.tenantId, referenceId: paymentId },
      }),
    ).toBe(0);

    // Revisado con su consentimiento: vuelve a ir a la madre.
    await as(api().post(review(ids.pending)), tokens.RECEPTION)
      .send({ decision: 'KEEP_RESPONSIBLE' })
      .expect(201);
    const sent = await as(
      api().post(`/api/v1/payments/${paymentId}/receipt/email`),
      tokens.RECEPTION,
    ).expect(202);
    expect(sent.body).toEqual({
      sentTo: 'ca***@example.com',
      sentToResponsible: true,
    });
  });

  it('GET/POST review: PENDING → REVIEWED, the latest wins, audited without the note text', async () => {
    const before = await as(
      api().get(review(ids.overdue)),
      tokens.RECEPTION,
    ).expect(200);
    expect(before.body as ReviewView).toMatchObject({
      status: 'PENDING',
      decision: null,
      responsibles: [
        {
          name: 'Carmen Rondón',
          relationship: 'MOTHER',
          receivesNotices: true,
          isPayer: true,
        },
      ],
    });
    const note = 'Habló con la paciente en recepción';
    await as(api().post(review(ids.overdue)), tokens.RECEPTION)
      .send({ decision: 'KEEP_RESPONSIBLE', note })
      .expect(201);
    const after = await as(api().post(review(ids.overdue)), tokens.ADMIN)
      .send({ decision: 'PATIENT_SELF' })
      .expect(201);
    expect(after.body as ReviewView).toMatchObject({
      status: 'REVIEWED',
      decision: 'PATIENT_SELF',
      majorityDate: (before.body as ReviewView).majorityDate,
      reviewedByName: 'Dr. Owner',
    });
    const got = await as(
      api().get(review(ids.overdue)),
      tokens.ASSISTANT,
    ).expect(200);
    expect((got.body as ReviewView).decision).toBe('PATIENT_SELF');

    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: clinic.tenantId,
        patientId: ids.overdue,
        action: 'UPDATE',
      },
      orderBy: { occurredAt: 'asc' },
      select: { resourceType: true, resourceId: true, metadata: true },
    });
    const reviews = events.filter(
      (e) => (e.metadata as { reason?: string }).reason === 'MAJORITY_REVIEWED',
    );
    expect(reviews).toHaveLength(2);
    expect(reviews[0]).toMatchObject({
      resourceType: 'PATIENT',
      resourceId: ids.overdue,
      metadata: {
        reason: 'MAJORITY_REVIEWED',
        changedFields: ['decision', 'note'],
        majorityReview: {
          decision: 'KEEP_RESPONSIBLE',
          majorityDate: (before.body as ReviewView).majorityDate,
          noteLength: note.length,
        },
      },
    });
    expect(JSON.stringify(events)).not.toContain('recepción');
    expect(reviews[1].metadata).toMatchObject({
      majorityReview: { decision: 'PATIENT_SELF', noteLength: 0 },
    });
    const rows = await raw.patientMajorityReview.findMany({
      where: { patientId: ids.overdue },
      orderBy: { reviewedAt: 'asc' },
    });
    expect(rows.map((r) => [r.decision, r.note])).toEqual([
      ['KEEP_RESPONSIBLE', note],
      ['PATIENT_SELF', null],
    ]);

    // Ya no sale como atrasado.
    const list = await as(api().get(listPath()), tokens.ADMIN).expect(200);
    expect((list.body as ListView).items.map((i) => i.patientId)).not.toContain(
      ids.overdue,
    );
  });

  it('a minor is 409 in Spanish; the elderly patient is NOT_APPLICABLE', async () => {
    const minor = await as(api().post(review(ids.upcoming)), tokens.RECEPTION)
      .send({ decision: 'PATIENT_SELF' })
      .expect(409);
    expect((minor.body as { message: string }).message).toBe(
      MAJORITY_REVIEW_MINOR_MESSAGE,
    );
    const elder = await as(
      api().get(review(ids.elder)),
      tokens.RECEPTION,
    ).expect(200);
    expect((elder.body as ReviewView).status).toBe('NOT_APPLICABLE');
    await as(api().post(review(ids.elder)), tokens.RECEPTION)
      .send({ decision: 'PATIENT_SELF' })
      .expect(422);
    await as(api().post(review(ids.altamira)), tokens.RECEPTION)
      .send({ decision: 'MAYBE' })
      .expect(400);
  });

  it('another clinic gets 404 and nothing is written', async () => {
    await as(
      api().get(review(ids.altamira)),
      other.adminToken,
      other.host,
    ).expect(404);
    await as(api().post(review(ids.altamira)), other.adminToken, other.host)
      .send({ decision: 'PATIENT_SELF' })
      .expect(404);
    const list = await as(
      api().get(listPath()),
      other.adminToken,
      other.host,
    ).expect(200);
    expect((list.body as ListView).items).toEqual([]);
    expect(
      await raw.patientMajorityReview.count({
        where: { patientId: ids.altamira },
      }),
    ).toBe(0);
  });
});
