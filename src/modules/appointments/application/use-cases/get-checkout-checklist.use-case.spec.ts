import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { GetCheckoutChecklistUseCase } from './get-checkout-checklist.use-case';

/*
 * SEC-069: la «próxima cita» de la salida solo mira las sedes permitidas al
 * usuario (DX-089), sin la sede activa de la cabecera: es del paciente, no de
 * la sede en la que se trabaja. Transacción falsa que aplica el `where` de
 * sede sobre unas citas en memoria: el test mira el resultado, no la forma
 * de la consulta.
 */
const TENANT = '11111111-1111-4111-8111-111111111111';
const NORTE = '22222222-2222-4222-8222-222222222222';
const SUR = '33333333-3333-4333-8333-333333333333';
const APPOINTMENT = '44444444-4444-4444-8444-444444444444';
const PATIENT = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-11-06T12:00:00.000Z');
const IN_SUR = new Date('2026-11-10T14:00:00.000Z');
const IN_NORTE = new Date('2026-11-20T14:00:00.000Z');

interface FutureRow {
  locationId: string;
  start: Date;
}

type LocationFilter = Prisma.AppointmentWhereInput['locationId'];

function matchesLocation(filter: LocationFilter, locationId: string): boolean {
  if (filter === undefined) return true;
  if (typeof filter === 'string') return filter === locationId;
  const list = filter?.in;
  if (Array.isArray(list)) return list.includes(locationId);
  throw new Error(`Filtro de sede no soportado: ${JSON.stringify(filter)}`);
}

function build(future: FutureRow[]) {
  const tx = {
    appointment: {
      findFirst: jest.fn(
        (args: { where: Prisma.AppointmentWhereInput }): Promise<unknown> => {
          if (args.where.id === APPOINTMENT) {
            return Promise.resolve({
              id: APPOINTMENT,
              locationId: NORTE,
              patient: {
                id: PATIENT,
                phone: '+58 414 555 0169',
                email: null,
                reminderOptOutAt: null,
              },
            });
          }
          if (args.where.patientId !== PATIENT) return Promise.resolve(null);
          const next = future
            .filter((r) => matchesLocation(args.where.locationId, r.locationId))
            .sort((a, b) => a.start.getTime() - b.start.getTime())[0];
          return Promise.resolve(next ? { start: next.start } : null);
        },
      ),
    },
    patientRecall: { findFirst: jest.fn(() => Promise.resolve(null)) },
  };
  const prisma = {
    runWithTenant: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaService;
  const tenantContext = new TenantContextService();
  return {
    useCase: new GetCheckoutChecklistUseCase(prisma, tenantContext),
    tenantContext,
  };
}

function run(
  tenantContext: TenantContextService,
  allowed: readonly string[] | undefined,
  fn: () => Promise<unknown>,
  activeLocationId?: string,
) {
  return tenantContext.run(TENANT, activeLocationId, fn, allowed);
}

describe('GetCheckoutChecklistUseCase — próxima cita por sede (SEC-069)', () => {
  const bothSites: FutureRow[] = [
    { locationId: SUR, start: IN_SUR },
    { locationId: NORTE, start: IN_NORTE },
  ];

  it('un miembro acotado a Norte no ve la cita de Sur: sale la de Norte', async () => {
    const { useCase, tenantContext } = build(bothSites);
    const list = await run(tenantContext, [NORTE], () =>
      useCase.execute(APPOINTMENT, NOW),
    );
    expect(list).toMatchObject({ nextAppointmentStart: IN_NORTE });
  });

  it('si la única próxima cita es de una sede no permitida, no hay próxima cita', async () => {
    const { useCase, tenantContext } = build([
      { locationId: SUR, start: IN_SUR },
    ]);
    const list = await run(tenantContext, [NORTE], () =>
      useCase.execute(APPOINTMENT, NOW),
    );
    expect(list).toMatchObject({ nextAppointmentStart: null });
  });

  it('sin restricción de sedes ve la más cercana de cualquier sede, como antes', async () => {
    const { useCase, tenantContext } = build(bothSites);
    const list = await run(tenantContext, undefined, () =>
      useCase.execute(APPOINTMENT, NOW),
    );
    expect(list).toMatchObject({ nextAppointmentStart: IN_SUR });
  });

  it('la sede activa de la cabecera no acota la próxima cita de quien ve todas', async () => {
    const { useCase, tenantContext } = build(bothSites);
    const list = await run(
      tenantContext,
      undefined,
      () => useCase.execute(APPOINTMENT, NOW),
      NORTE,
    );
    expect(list).toMatchObject({ nextAppointmentStart: IN_SUR });
  });

  it('acotado a varias sedes, cuenta cualquiera de ellas aunque la cabecera fije otra', async () => {
    const { useCase, tenantContext } = build(bothSites);
    const list = await run(
      tenantContext,
      [NORTE, SUR],
      () => useCase.execute(APPOINTMENT, NOW),
      NORTE,
    );
    expect(list).toMatchObject({ nextAppointmentStart: IN_SUR });
  });

  it('la cita de una sede no permitida sigue dando 403', async () => {
    const { useCase, tenantContext } = build(bothSites);
    await expect(
      run(tenantContext, [SUR], () => useCase.execute(APPOINTMENT, NOW)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('una cita que no existe en la clínica da 404', async () => {
    const { useCase, tenantContext } = build(bothSites);
    await expect(
      run(tenantContext, undefined, () =>
        useCase.execute('66666666-6666-4666-8666-666666666666', NOW),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
