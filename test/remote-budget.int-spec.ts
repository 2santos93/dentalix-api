import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaSignatureRequestRepository } from '../src/modules/signature-requests/infrastructure/prisma-signature-request.repository';
import {
  RemoteBudgetChangedError,
  SIGNATURE_BUDGET_VALIDITY_CHANGED_MESSAGE,
  budgetNotPresentedMessage,
  type CreateSignatureRequestOptions,
  type RemoteBudgetAcceptanceInsert,
} from '../src/modules/signature-requests/domain/ports/signature-request-repository.port';
import { budgetStillMatches } from '../src/modules/signature-requests/application/remote-budget';
import {
  generateSignatureToken,
  hashSignatureToken,
} from '../src/modules/signature-requests/domain/signature-token';
import {
  composeQuoteContent,
  quoteValidityOf,
} from '../src/modules/treatment-plans/application/use-cases/plan-quote.use-cases';
import { computeQuoteHash } from '../src/modules/treatment-plans/domain/plan-quote';
import {
  acceptPlanInTx,
  lockPlanGroup,
} from '../src/modules/treatment-plans/infrastructure/repositories/plan-option-group';
import { resetDatabase } from './support/e2e-fixtures';
import {
  backendPid,
  gate,
  holdLock,
  settle,
  waitForLockWaiters,
  waitingQueries,
} from './support/postgres-concurrency';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-415 contra Postgres: la solicitud BUDGET guarda la foto del presupuesto
// y su hash (CHECK), que nunca cambian (guard); la aceptación a distancia se
// escribe en la MISMA transacción que la firma, con el grupo del plan
// bloqueado, con todas sus evidencias (CHECK) y es inmutable; si el plan ya
// no es la foto, no se escribe nada. RLS: la clínica B no ve nada de A.
const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaSignatureRequestRepository(prisma, tenantContext);

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const HASH = 'c'.repeat(64);
const NAMES = {};

interface Seeded {
  tenantId: string;
  locationId: string;
  patientId: string;
  userId: string;
  catalogItemId: string;
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
  const user = await owner.user.create({
    data: {
      email: `${subdomain}@int.test`,
      passwordHash: 'x',
      fullName: `Dra. ${subdomain}`,
    },
  });
  await owner.clinicMembership.create({
    data: { tenantId: tenant.id, userId: user.id, role: 'DENTIST' },
  });
  const patient = await owner.patient.create({
    data: {
      tenantId: tenant.id,
      firstName: 'Ana',
      lastName: subdomain,
      email: `ana@${subdomain}.test`,
    },
  });
  const catalog = await owner.dentalCatalogItem.create({
    data: {
      tenantId: tenant.id,
      code: `c-${subdomain}`,
      kind: 'PROCEDURE',
      labelEs: 'Corona',
      color: '#123456',
    },
  });
  return {
    tenantId: tenant.id,
    locationId: location.id,
    patientId: patient.id,
    userId: user.id,
    catalogItemId: catalog.id,
  };
}

/** Plan PRESENTED con un ítem; con `groupId`, opción de ese grupo. */
async function presentedPlan(s: Seeded, groupId?: string): Promise<string> {
  const plan = await owner.treatmentPlan.create({
    data: {
      tenantId: s.tenantId,
      patientId: s.patientId,
      currency: 'USD',
      status: 'PRESENTED',
      presentedAt: new Date(),
      presentedLocationId: s.locationId,
      optionGroupId: groupId ?? null,
    },
  });
  await owner.treatmentPlanItem.create({
    data: {
      tenantId: s.tenantId,
      planId: plan.id,
      toothNumber: '36',
      catalogItemId: s.catalogItemId,
      price: 300000,
      discount: 30000,
    },
  });
  return plan.id;
}

// DX-379: instante fijo de los casos que comparan fechas (9 nov 2026, 11:00
// en Caracas).
const NOW = new Date('2026-11-09T15:00:00.000Z');

async function storedValidity(planId: string) {
  const plan = await owner.treatmentPlan.findUniqueOrThrow({
    where: { id: planId },
    select: { quoteIssuedOn: true, quoteValidUntil: true },
  });
  return {
    issuedOn: plan.quoteIssuedOn?.toISOString().slice(0, 10) ?? null,
    validUntil: plan.quoteValidUntil?.toISOString().slice(0, 10) ?? null,
  };
}

const asClinic = <T>(tenantId: string, fn: () => Promise<T>) =>
  tenantContext.run(tenantId, fn);

/**
 * Envía el presupuesto del plan como lo hace la app (foto + hash), con UN
 * instante para la foto y la solicitud. `now` fijo en los casos que comparan
 * fechas (DX-379); los que firman usan el de ahora, porque el enlace tiene
 * que estar vivo frente al reloj de la BD. `fixValidity`: como el caso de uso
 * con un plan sin fechas, guarda en el plan la validez de la foto.
 */
async function sendBudget(
  s: Seeded,
  planId: string,
  opts: {
    now?: Date;
    fixValidity?: boolean;
    options?: CreateSignatureRequestOptions;
  } = {},
) {
  const now = opts.now ?? new Date();
  const budget = await asClinic(s.tenantId, () =>
    repo.loadBudget(s.patientId, planId, s.locationId),
  );
  if (!budget) throw new Error('sin presupuesto');
  const validity = quoteValidityOf(budget.quote, now);
  const content = composeQuoteContent(budget.quote, validity, NAMES);
  const options: CreateSignatureRequestOptions =
    opts.options ?? (opts.fixValidity ? { planQuoteValidity: validity } : {});
  const request = {
    locationId: s.locationId,
    patientId: s.patientId,
    type: 'BUDGET' as const,
    channel: 'EMAIL' as const,
    templateId: null,
    templateVersion: null,
    treatmentPlanId: planId,
    title: 'Presupuesto de tratamiento',
    body: 'Condiciones',
    budgetContent: content,
    budgetContentHash: computeQuoteHash(content),
    professionalUserId: s.userId,
    professionalName: 'Dra.',
    signerType: 'PATIENT' as const,
    signerName: 'Ana Int',
    signerDocument: null,
    destination: 'ana@example.com',
    destinationMasked: 'an***@example.com',
    tokenHash: hashSignatureToken(generateSignatureToken()),
    expiresAt: new Date(now.getTime() + 72 * 3600_000),
    createdById: s.userId,
    createdAt: now,
  };
  const { id } = await asClinic(s.tenantId, () =>
    repo.create(request, undefined, options),
  );
  return { id, request };
}

/** Firma la solicitud con la aceptación del plan (como SignPublicSignature). */
function signBudget(
  s: Seeded,
  id: string,
  planId: string,
  extra: Partial<RemoteBudgetAcceptanceInsert> = {},
  /** DX-379 (C): el instante con que se mira si el presupuesto venció. */
  checkedAt?: Date,
) {
  const at = new Date();
  return asClinic(s.tenantId, () =>
    repo.withLockedRequest(
      id,
      { ipAddress: '203.0.113.7', userAgent: 'int', requestId: null },
      (r) => ({
        write: {
          patch: { openedAt: at, verifiedAt: at, signedAt: at },
          audit: [{ action: 'SIGN', reason: 'SIGNATURE_PATIENT_SIGNED' }],
          budget: {
            planId,
            locationId: r.locationId,
            stillMatches: (quote) =>
              budgetStillMatches(r, quote, NAMES, checkedAt ?? at),
            signerName: r.signerName,
            signature: PNG,
            content: r.budgetContent as object,
            contentHash: r.budgetContentHash!,
            acceptanceHash: HASH,
            acceptedAt: at,
            acceptedById: r.createdById,
            ipAddress: '203.0.113.7',
            userAgent: 'int',
            remoteChannel: 'EMAIL',
            remoteDestinationMasked: r.destinationMasked,
            remoteSentAt: r.createdAt,
            remoteOpenedAt: at,
            remoteVerifiedAt: at,
            ...extra,
          },
        },
        result: 'SIGNED' as const,
      }),
    ),
  );
}

describe('presupuesto a distancia en Postgres (DX-415)', () => {
  let a: Seeded;
  let b: Seeded;

  beforeAll(async () => {
    await resetDatabase(owner);
    a = await seedClinic('dx415-int-a');
    b = await seedClinic('dx415-int-b');
  });

  // M-7: un caso que cambia el ajuste de días no lo deja cambiado aunque falle.
  afterEach(async () => {
    await owner.tenant.updateMany({
      where: { id: { in: [a.tenantId, b.tenantId] } },
      data: { quoteValidityDays: 30 },
    });
  });

  afterAll(async () => {
    await resetDatabase(owner);
    await owner.$disconnect();
    await prisma.$disconnect();
  });

  it('firmar acepta el plan en la misma transacción: aceptación con evidencias, plan ACCEPTED y la otra opción REJECTED', async () => {
    // El plan que abre el grupo apunta a sí mismo (DX-040).
    const planId = await presentedPlan(a);
    await owner.treatmentPlan.update({
      where: { id: planId },
      data: { optionGroupId: planId },
    });
    const sibling = await presentedPlan(a, planId);
    const { id } = await sendBudget(a, planId);
    await expect(signBudget(a, id, planId)).resolves.toBe('SIGNED');

    const acceptance = await owner.treatmentPlanAcceptance.findFirstOrThrow({
      where: { planId },
    });
    expect(acceptance).toMatchObject({
      signatureRequestId: id,
      remoteChannel: 'EMAIL',
      remoteDestinationMasked: 'an***@example.com',
      ipAddress: '203.0.113.7',
    });
    const plans = await owner.treatmentPlan.findMany({
      where: { id: { in: [planId, sibling] } },
      select: { id: true, status: true, rejectionReason: true },
    });
    expect(plans.find((p) => p.id === planId)?.status).toBe('ACCEPTED');
    expect(plans.find((p) => p.id === sibling)).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'OTHER_OPTION_ACCEPTED',
    });
    // La ficha la ve con la aceptación.
    const row = await asClinic(a.tenantId, () => repo.findById(id));
    expect(row?.budgetAcceptance?.id).toBe(acceptance.id);
  });

  it('DX-379 (G.5): un enlace enviado sin validez guardada sigue valiendo y se firma aunque después se guarden fechas y cambie el ajuste', async () => {
    // Plan presentado antes de DX-379: sin fechas. Se envía con hoy + 30.
    const planId = await presentedPlan(a);
    const { id, request } = await sendBudget(a, planId);
    const sent = request.budgetContent;
    expect(sent.validityDays).toBe(30);
    // Tras el despliegue: la clínica cambia el ajuste y el plan guarda otra
    // validez (p. ej. una impresión). El enlace pendiente se recompone con
    // las fechas de SU foto, así que sigue valiendo.
    await owner.tenant.update({
      where: { id: a.tenantId },
      data: { quoteValidityDays: 7 },
    });
    await owner.treatmentPlan.update({
      where: { id: planId },
      data: {
        quoteIssuedOn: new Date('2026-01-05T00:00:00.000Z'),
        quoteValidUntil: new Date('2026-01-12T00:00:00.000Z'),
      },
    });
    const budget = await asClinic(a.tenantId, () =>
      repo.loadBudget(a.patientId, planId, a.locationId),
    );
    expect(budget?.quote.plan.quoteValidUntil).toBe('2026-01-12');
    expect(budget?.quote.clinic.quoteValidityDays).toBe(7);
    expect(budgetStillMatches(request, budget!.quote, NAMES, new Date())).toBe(
      true,
    );
    await expect(signBudget(a, id, planId)).resolves.toBe('SIGNED');
  });

  it('DX-379 (M-3): enviar un plan sin validez la guarda en el plan en la misma transacción, con las fechas de la foto', async () => {
    const planId = await presentedPlan(a);
    // 9 nov 2026, 11:00 en Caracas: la foto dice 9/11 → 9/12 (30 días).
    const { request } = await sendBudget(a, planId, {
      now: NOW,
      fixValidity: true,
    });
    expect(request.budgetContent).toMatchObject({
      issuedOn: '2026-11-09',
      validUntil: '2026-12-09',
    });
    expect(await storedValidity(planId)).toEqual({
      issuedOn: '2026-11-09',
      validUntil: '2026-12-09',
    });
  });

  it.each(['REJECTED', 'ACCEPTED', 'CANCELLED'] as const)(
    'DX-379 (N-1): si el plan pasó a %s antes de enviar, 409 «no presentado», sin fechas ni solicitud',
    async (status) => {
      const planId = await presentedPlan(a);
      // Leído «Presentado» por el caso de uso; cerrado antes de la
      // transacción que crea la solicitud.
      await owner.treatmentPlan.update({
        where: { id: planId },
        data:
          status === 'REJECTED'
            ? { status, rejectedAt: NOW, rejectionReason: 'PRICE' }
            : { status },
      });
      await expect(
        sendBudget(a, planId, { now: NOW, fixValidity: true }),
      ).rejects.toThrow(budgetNotPresentedMessage(status));
      expect(await storedValidity(planId)).toEqual({
        issuedOn: null,
        validUntil: null,
      });
      expect(
        await owner.signatureRequest.count({
          where: { treatmentPlanId: planId },
        }),
      ).toBe(0);
    },
  );

  it('DX-379 (M-3): si entre medias el plan recibió otra validez, 409 y no se crea la solicitud', async () => {
    const planId = await presentedPlan(a);
    await owner.treatmentPlan.update({
      where: { id: planId },
      data: {
        quoteIssuedOn: new Date('2026-03-01T00:00:00.000Z'),
        quoteValidUntil: new Date('2026-03-31T00:00:00.000Z'),
      },
    });
    await expect(
      sendBudget(a, planId, {
        options: {
          planQuoteValidity: {
            issuedOn: '2026-03-02',
            validUntil: '2026-04-01',
          },
        },
      }),
    ).rejects.toThrow(SIGNATURE_BUDGET_VALIDITY_CHANGED_MESSAGE);
    expect(
      await owner.signatureRequest.count({
        where: { treatmentPlanId: planId },
      }),
    ).toBe(0);
  });

  it('DX-379: con validez guardada, la foto enviada lleva esas fechas', async () => {
    const planId = await presentedPlan(a);
    await owner.treatmentPlan.update({
      where: { id: planId },
      data: {
        quoteIssuedOn: new Date('2026-02-01T00:00:00.000Z'),
        quoteValidUntil: new Date('2026-02-16T00:00:00.000Z'),
      },
    });
    const { request } = await sendBudget(a, planId);
    expect(request.budgetContent).toMatchObject({
      issuedOn: '2026-02-01',
      validUntil: '2026-02-16',
      validityDays: 15,
    });
  });

  it('si el plan cambió, no se escribe nada (ni la firma ni la aceptación)', async () => {
    const planId = await presentedPlan(a);
    const { id } = await sendBudget(a, planId);
    await owner.treatmentPlanItem.updateMany({
      where: { planId },
      data: { price: 310000 },
    });
    await expect(signBudget(a, id, planId)).rejects.toBeInstanceOf(
      RemoteBudgetChangedError,
    );
    const request = await owner.signatureRequest.findUniqueOrThrow({
      where: { id },
    });
    expect(request.signedAt).toBeNull();
    expect(
      await owner.treatmentPlanAcceptance.count({ where: { planId } }),
    ).toBe(0);
    expect(
      (await owner.treatmentPlan.findUniqueOrThrow({ where: { id: planId } }))
        .status,
    ).toBe('PRESENTED');
  });

  it('DX-379 (C): si el presupuesto venció entre el envío y la firma, no se escribe nada', async () => {
    const planId = await presentedPlan(a);
    const { id, request } = await sendBudget(a, planId, { fixValidity: true });
    const sent = request.budgetContent as { validUntil: string };
    // El día siguiente al último válido, a mediodía en Caracas.
    const after = new Date(`${sent.validUntil}T12:00:00-04:00`);
    after.setUTCDate(after.getUTCDate() + 1);
    await expect(signBudget(a, id, planId, {}, after)).rejects.toBeInstanceOf(
      RemoteBudgetChangedError,
    );
    expect(
      (await owner.signatureRequest.findUniqueOrThrow({ where: { id } }))
        .signedAt,
    ).toBeNull();
    expect(
      await owner.treatmentPlanAcceptance.count({ where: { planId } }),
    ).toBe(0);
    // El último día todavía vale (a las 23:00 en Caracas).
    const lastDay = new Date(`${sent.validUntil}T23:00:00-04:00`);
    await expect(signBudget(a, id, planId, {}, lastDay)).resolves.toBe(
      'SIGNED',
    );
    // La aceptación a distancia guarda la copia de la validez.
    const accepted = await owner.treatmentPlanAcceptance.findFirstOrThrow({
      where: { planId },
    });
    expect(accepted.quoteValidUntil?.toISOString().slice(0, 10)).toBe(
      sent.validUntil,
    );
  });

  it('carrera: la clínica acepta con firma mientras el paciente firma a distancia; queda UNA aceptación, la de la clínica, y el enlace no se usa', async () => {
    const planId = await presentedPlan(a);
    const { id, request } = await sendBudget(a, planId);
    const clinicHolds = gate();
    const lockedByClinic = gate<number>();
    // La aceptación en la clínica (DX-012): bloquea el grupo, escribe su
    // aceptación y acepta el plan; espera con el bloqueo puesto.
    const clinic = asClinic(a.tenantId, () =>
      prisma.runWithTenant(async (tx) => {
        const locked = await lockPlanGroup(tx, planId);
        if (!locked) throw new Error('sin plan');
        lockedByClinic.open(await backendPid(tx));
        await clinicHolds.wait;
        const at = new Date();
        await tx.treatmentPlanAcceptance.create({
          data: {
            tenantId: a.tenantId,
            planId,
            patientId: a.patientId,
            locationId: a.locationId,
            signerName: 'Ana Clínica',
            signature: PNG,
            content: request.budgetContent as unknown as Prisma.InputJsonObject,
            contentHash: request.budgetContentHash,
            acceptanceHash: HASH,
            acceptedAt: at,
            acceptedById: a.userId,
          },
        });
        await acceptPlanInTx(tx, locked, at, a.userId, a.locationId);
      }),
    );
    const clinicDone = settle(clinic);
    const clinicPid = await Promise.race([
      lockedByClinic.wait,
      clinicDone.then((o) => {
        throw new Error(
          `la clínica terminó sin bloquear: ${JSON.stringify(o)}`,
        );
      }),
    ]);
    let remote: ReturnType<typeof settle<unknown>> | undefined;
    try {
      // El paciente firma: bloquea su enlace y espera al grupo del plan. Se
      // suelta a la clínica SOLO cuando pg_locks muestra esa espera (DX-450).
      remote = settle(signBudget(a, id, planId));
      await waitForLockWaiters(owner, [clinicPid], 1);
      // Y lo que espera es el bloqueo del GRUPO del plan (no otra sentencia).
      const waiting = await waitingQueries(owner, [clinicPid]);
      expect(waiting).toHaveLength(1);
      expect(waiting[0]).toMatch(/FROM "treatment_plans"[\s\S]*FOR UPDATE/);
    } finally {
      clinicHolds.open();
    }
    expect(await clinicDone).toEqual({ status: 'fulfilled', value: undefined });
    const remoteOutcome = await remote;
    expect(remoteOutcome?.status).toBe('rejected');
    expect(
      remoteOutcome?.status === 'rejected' && remoteOutcome.reason,
    ).toBeInstanceOf(RemoteBudgetChangedError);

    const acceptances = await owner.treatmentPlanAcceptance.findMany({
      where: { planId },
      select: { signatureRequestId: true, signerName: true },
    });
    expect(acceptances).toEqual([
      { signatureRequestId: null, signerName: 'Ana Clínica' },
    ]);
    const after = await owner.signatureRequest.findUniqueOrThrow({
      where: { id },
      select: { signedAt: true },
    });
    expect(after.signedAt).toBeNull();
  });

  it('DX-450: la firma espera al enlace bloqueado y decide con lo que dejó quien lo tenía (candado del enlace)', async () => {
    const planId = await presentedPlan(a);
    const { id } = await sendBudget(a, planId);
    const marked = new Date('2026-11-04T15:00:00.000Z');
    // Otro paso sobre el mismo enlace (un código a la vez, doble firma): lo
    // bloquea y deja su marca antes de confirmar.
    const lock = await holdLock(
      owner,
      (tx) =>
        tx.$queryRaw`SELECT "id" FROM "signature_requests" WHERE "id" = ${id}::uuid FOR UPDATE`,
      async (tx) => {
        await tx.signatureRequest.update({
          where: { id },
          data: { openedAt: marked },
        });
      },
    );
    let seen: Date | null | undefined;
    let attempt: ReturnType<typeof settle<unknown>> | undefined;
    try {
      attempt = settle(
        asClinic(a.tenantId, () =>
          repo.withLockedRequest(
            id,
            { ipAddress: '203.0.113.7', userAgent: 'int', requestId: null },
            (r) => {
              seen = r.openedAt;
              return { write: null, result: 'SEEN' as const };
            },
          ),
        ),
      );
      await waitForLockWaiters(owner, [lock.pid], 1);
      expect(seen).toBeUndefined();
    } finally {
      lock.release();
      await lock.done;
    }
    expect(await attempt).toEqual({ status: 'fulfilled', value: 'SEEN' });
    expect(seen).toEqual(marked);
  });

  it('CHECK: un BUDGET lleva plan, foto y hash; un CONSENT no lleva foto', async () => {
    const planId = await presentedPlan(a);
    const { request } = await sendBudget(a, planId);
    const base = {
      ...request,
      budgetContent: request.budgetContent as unknown as Prisma.InputJsonObject,
      tenantId: a.tenantId,
      tokenHash: hashSignatureToken(generateSignatureToken()),
    };
    await expect(
      owner.signatureRequest.create({
        data: { ...base, budgetContentHash: 'no-es-hash' },
      }),
    ).rejects.toThrow(/signature_requests_budget_check/);
    await expect(
      owner.signatureRequest.create({
        data: { ...base, treatmentPlanId: null },
      }),
    ).rejects.toThrow(/signature_requests_budget_check/);
  });

  it('la foto y su hash no cambian nunca, y la aceptación a distancia es inmutable', async () => {
    const planId = await presentedPlan(a);
    const { id } = await sendBudget(a, planId);
    await expect(
      owner.signatureRequest.update({
        where: { id },
        data: { budgetContentHash: 'd'.repeat(64) },
      }),
    ).rejects.toThrow(/no cambia/);
    await signBudget(a, id, planId);
    const acceptance = await owner.treatmentPlanAcceptance.findFirstOrThrow({
      where: { signatureRequestId: id },
    });
    await expect(
      owner.treatmentPlanAcceptance.update({
        where: { id: acceptance.id },
        data: { remoteDestinationMasked: 'otro' },
      }),
    ).rejects.toThrow();
  });

  it('CHECK de evidencias: con solicitud, todas; sin ella, ninguna', async () => {
    const planId = await presentedPlan(a);
    const { id } = await sendBudget(a, planId);
    await expect(
      signBudget(a, id, planId, {
        remoteDestinationMasked: '',
      }),
    ).rejects.toThrow(/treatment_plan_acceptances_remote_check/);
  });

  it('RLS: la clínica B no ve el presupuesto ni la solicitud de A, ni la firma', async () => {
    const planId = await presentedPlan(a);
    const { id } = await sendBudget(a, planId);
    expect(
      await asClinic(b.tenantId, () =>
        repo.loadBudget(a.patientId, planId, a.locationId),
      ),
    ).toBeNull();
    expect(await asClinic(b.tenantId, () => repo.findById(id))).toBeNull();
    await expect(signBudget(b, id, planId)).resolves.toBeNull();
    const rows = await owner.$queryRaw<{ relforcerowsecurity: boolean }[]>`
      SELECT relforcerowsecurity FROM pg_class
       WHERE relname IN ('signature_requests', 'treatment_plan_acceptances')`;
    expect(rows.every((r) => r.relforcerowsecurity)).toBe(true);
  });
});
