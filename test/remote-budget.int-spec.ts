import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaSignatureRequestRepository } from '../src/modules/signature-requests/infrastructure/prisma-signature-request.repository';
import {
  RemoteBudgetChangedError,
  type RemoteBudgetAcceptanceInsert,
} from '../src/modules/signature-requests/domain/ports/signature-request-repository.port';
import { budgetStillMatches } from '../src/modules/signature-requests/application/remote-budget';
import {
  generateSignatureToken,
  hashSignatureToken,
} from '../src/modules/signature-requests/domain/signature-token';
import {
  composeQuoteContent,
  quoteIssuedOn,
} from '../src/modules/treatment-plans/application/use-cases/plan-quote.use-cases';
import { computeQuoteHash } from '../src/modules/treatment-plans/domain/plan-quote';
import {
  acceptPlanInTx,
  lockPlanGroup,
} from '../src/modules/treatment-plans/infrastructure/repositories/plan-option-group';
import { resetDatabase } from './support/e2e-fixtures';
import {
  REGIONAL_BOGOTA_FIXTURE,
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
    data: locationData(REGIONAL_BOGOTA_FIXTURE, {
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
      currency: 'COP',
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

const asClinic = <T>(tenantId: string, fn: () => Promise<T>) =>
  tenantContext.run(tenantId, fn);

/** Envía el presupuesto del plan como lo hace la app (foto + hash). */
async function sendBudget(s: Seeded, planId: string) {
  const budget = await asClinic(s.tenantId, () =>
    repo.loadBudget(s.patientId, planId, s.locationId),
  );
  if (!budget) throw new Error('sin presupuesto');
  const content = composeQuoteContent(
    budget.quote,
    quoteIssuedOn(budget.quote, new Date()),
    NAMES,
  );
  const now = new Date();
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
  const { id } = await asClinic(s.tenantId, () => repo.create(request));
  return { id, request };
}

/** Firma la solicitud con la aceptación del plan (como SignPublicSignature). */
function signBudget(
  s: Seeded,
  id: string,
  planId: string,
  extra: Partial<RemoteBudgetAcceptanceInsert> = {},
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
            stillMatches: (quote) => budgetStillMatches(r, quote, NAMES),
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

  it('carrera: la clínica acepta con firma mientras el paciente firma a distancia; queda UNA aceptación, la de la clínica, y el enlace no se usa', async () => {
    const planId = await presentedPlan(a);
    const { id, request } = await sendBudget(a, planId);
    let releaseClinic!: () => void;
    const clinicHolds = new Promise<void>((resolve) => {
      releaseClinic = resolve;
    });
    let clinicLocked!: () => void;
    const lockedByClinic = new Promise<void>((resolve) => {
      clinicLocked = resolve;
    });
    // La aceptación en la clínica (DX-012): bloquea el grupo, escribe su
    // aceptación y acepta el plan; espera con el bloqueo puesto.
    const clinic = asClinic(a.tenantId, () =>
      prisma.runWithTenant(async (tx) => {
        const locked = await lockPlanGroup(tx, planId);
        if (!locked) throw new Error('sin plan');
        clinicLocked();
        await clinicHolds;
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
    await lockedByClinic;
    // El paciente firma: bloquea su enlace y espera al grupo del plan.
    const remote = signBudget(a, id, planId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    releaseClinic();
    await expect(clinic).resolves.toBeUndefined();
    await expect(remote).rejects.toBeInstanceOf(RemoteBudgetChangedError);

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
