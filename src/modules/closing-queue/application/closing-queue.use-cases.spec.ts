import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import {
  ClosingQueueUseCases,
  CLOSING_OWN_ONLY_MESSAGE,
  CLOSING_SECTION_FORBIDDEN_MESSAGE,
  DISMISSAL_NOT_PENDING_MESSAGE,
  DISMISSAL_REASON_TEXT_MESSAGE,
  type ClosingQueueQuery,
} from './closing-queue.use-cases';
import {
  DismissalExistsError,
  type ClosingAppointmentRow,
  type ClosingQueueRepository,
  type ClosingScope,
} from '../domain/ports/closing-queue-repository.port';

const NOW = new Date('2026-11-01T15:00:00Z');
const MAIN = '00000000-0000-4000-8000-000000000001';
const NORTH = '00000000-0000-4000-8000-000000000002';
const APPT = '00000000-0000-4000-8000-0000000000a1';

function row(over: Partial<ClosingAppointmentRow> = {}): ClosingAppointmentRow {
  return {
    appointmentId: APPT,
    patientId: 'p-1',
    patientName: 'Ana Pérez',
    start: new Date('2026-10-31T15:00:00Z'),
    end: new Date('2026-10-31T15:30:00Z'),
    status: 'CONFIRMED',
    locationId: MAIN,
    locationName: 'Principal',
    timeZone: 'America/Bogota',
    professionalId: 'd-1',
    professionalName: 'Dra. Uno',
    ...over,
  };
}

function fakeRepo() {
  const scopes: Record<string, ClosingScope[]> = {
    outcome: [],
    evolution: [],
    treatment: [],
  };
  type Repo = ClosingQueueRepository;
  const fn = <K extends keyof Repo>(impl: Repo[K]) =>
    jest.fn<ReturnType<Repo[K]>, Parameters<Repo[K]>>(
      impl as (...args: Parameters<Repo[K]>) => ReturnType<Repo[K]>,
    );
  const repo = {
    listLocations: fn<'listLocations'>((allowed) =>
      Promise.resolve(
        [
          { id: MAIN, name: 'Principal', timeZone: 'America/Bogota' },
          { id: NORTH, name: 'Norte', timeZone: 'Europe/Madrid' },
        ].filter((l) => allowed === 'ALL' || allowed.includes(l.id)),
      ),
    ),
    outcome: fn<'outcome'>((scope) => {
      scopes.outcome.push(scope);
      return Promise.resolve({ rows: [row()], total: 1 });
    }),
    evolution: fn<'evolution'>((scope) => {
      scopes.evolution.push(scope);
      return Promise.resolve({ rows: [], total: 0 });
    }),
    treatment: fn<'treatment'>((scope) => {
      scopes.treatment.push(scope);
      return Promise.resolve({ rows: [], total: 0 });
    }),
    keptOverbooks: fn<'keptOverbooks'>(() =>
      Promise.resolve({
        rows: [{ ...row(), keptAt: NOW, keptByName: 'Recepción Uno' }],
        total: 1,
      }),
    ),
    staleInClinic: fn<'staleInClinic'>(() => Promise.resolve(2)),
    findAppointment: fn<'findAppointment'>(() =>
      Promise.resolve({
        id: APPT,
        patientId: 'p-1',
        locationId: MAIN,
        providerId: 'd-1',
      }),
    ),
    createDismissal: fn<'createDismissal'>(() =>
      Promise.resolve({ id: 'dis-1', createdAt: NOW }),
    ),
  };
  return { repo, scopes };
}

const query = (
  role: ClinicRole,
  over: Partial<ClosingQueueQuery> = {},
): ClosingQueueQuery => ({
  actor: { userId: role === ClinicRole.DENTIST ? 'd-1' : 'u-1', role },
  allowedLocationIds: 'ALL',
  ...over,
});

const ctx = (role: ClinicRole, userId = 'u-1'): AuditRequestContext => ({
  tenantId: 't-1',
  locationId: null,
  actor: { userId, role },
  requestId: 'r-1',
  ip: null,
  userAgent: null,
});

describe('ClosingQueueUseCases (DX-439)', () => {
  it('ADMIN: las tres secciones, el contador aparte de «en clínica» y el total', async () => {
    const { repo } = fakeRepo();
    const q = await new ClosingQueueUseCases(repo, () => NOW).list(
      query(ClinicRole.ADMIN),
    );
    expect(q.sections).toEqual(['OUTCOME', 'EVOLUTION', 'TREATMENT']);
    expect(q.outcome?.total).toBe(1);
    expect(q.outcome?.items[0]).toEqual(
      expect.objectContaining({
        appointmentId: APPT,
        patientName: 'Ana Pérez',
      }),
    );
    expect(q.evolution).toEqual({ total: 0, items: [] });
    expect(q.treatment).toEqual({ total: 0, items: [] });
    expect(q.staleInClinic).toBe(2);
    expect(q.total).toBe(1);
    expect(q.defaultDays).toBe(14);
  });

  it('RECEPTION: solo el desenlace; DENTIST: evolución y tratamiento, de sus citas', async () => {
    const reception = fakeRepo();
    const r = await new ClosingQueueUseCases(reception.repo, () => NOW).list(
      query(ClinicRole.RECEPTION),
    );
    expect(r.sections).toEqual(['OUTCOME']);
    expect(r.evolution).toBeNull();
    expect(r.treatment).toBeNull();
    expect(reception.repo.evolution).not.toHaveBeenCalled();

    const dentist = fakeRepo();
    const d = await new ClosingQueueUseCases(dentist.repo, () => NOW).list(
      query(ClinicRole.DENTIST),
    );
    expect(d.sections).toEqual(['EVOLUTION', 'TREATMENT']);
    expect(d.outcome).toBeNull();
    expect(d.staleInClinic).toBeNull();
    expect(dentist.repo.outcome).not.toHaveBeenCalled();
    expect(dentist.scopes.evolution[0].professionalId).toBe('d-1');
  });

  it('un DENTIST que pide las citas de otro profesional: 403', async () => {
    const { repo } = fakeRepo();
    await expect(
      new ClosingQueueUseCases(repo, () => NOW).list(
        query(ClinicRole.DENTIST, { professionalId: 'd-2' }),
      ),
    ).rejects.toThrow(new ForbiddenException(CLOSING_OWN_ONLY_MESSAGE));
  });

  it('una sede no permitida: 403; sin sede, solo las permitidas', async () => {
    const { repo, scopes } = fakeRepo();
    const useCases = new ClosingQueueUseCases(repo, () => NOW);
    await expect(
      useCases.list(
        query(ClinicRole.RECEPTION, {
          allowedLocationIds: [MAIN],
          locationId: NORTH,
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await useCases.list(
      query(ClinicRole.RECEPTION, { allowedLocationIds: [MAIN] }),
    );
    expect(scopes.outcome[0].branches.flatMap((b) => b.locationIds)).toEqual([
      MAIN,
    ]);
  });

  it('la sede activa de la cabecera acota la lista si no se pide otra', async () => {
    const { repo, scopes } = fakeRepo();
    await new ClosingQueueUseCases(repo, () => NOW).list(
      query(ClinicRole.ADMIN, { activeLocationId: NORTH }),
    );
    expect(scopes.outcome[0].branches.flatMap((b) => b.locationIds)).toEqual([
      NORTH,
    ]);
  });

  it('período inválido o de más de 92 días: 400', async () => {
    const { repo } = fakeRepo();
    const useCases = new ClosingQueueUseCases(repo, () => NOW);
    await expect(
      useCases.list(
        query(ClinicRole.ADMIN, { from: '2026-10-20', to: '2026-10-01' }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      useCases.list(
        query(ClinicRole.ADMIN, { from: '2026-01-01', to: '2026-10-01' }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('una sede sin zona no se omite en silencio: sale en locationsWithoutZone', async () => {
    const { repo, scopes } = fakeRepo();
    repo.listLocations.mockResolvedValueOnce([
      { id: MAIN, name: 'Principal', timeZone: 'America/Bogota' },
      { id: NORTH, name: 'Norte', timeZone: null },
    ]);
    const q = await new ClosingQueueUseCases(repo, () => NOW).list(
      query(ClinicRole.ADMIN),
    );
    expect(q.locationsWithoutZone).toEqual([{ id: NORTH, name: 'Norte' }]);
    expect(scopes.outcome[0].branches.flatMap((b) => b.locationIds)).toEqual([
      MAIN,
    ]);
  });

  it('DX-509-bis: los sobrecupos mantenidos salen aparte, sin sumar en el total ni en el contador', async () => {
    const admin = fakeRepo();
    const q = await new ClosingQueueUseCases(admin.repo, () => NOW).list(
      query(ClinicRole.ADMIN),
    );
    expect(q.keptOverbooks).toEqual({
      total: 1,
      items: [
        expect.objectContaining({
          appointmentId: APPT,
          keptAt: NOW,
          keptByName: 'Recepción Uno',
        }),
      ],
    });
    expect(q.total).toBe(1);
    const c = await new ClosingQueueUseCases(admin.repo, () => NOW).count(
      query(ClinicRole.ADMIN),
    );
    expect(c.total).toBe(1);
    expect(admin.repo.keptOverbooks).toHaveBeenCalledTimes(1);

    // Un DENTIST, solo los suyos (mismo alcance que sus secciones).
    const dentist = fakeRepo();
    await new ClosingQueueUseCases(dentist.repo, () => NOW).list(
      query(ClinicRole.DENTIST),
    );
    expect(dentist.repo.keptOverbooks.mock.calls[0][0].professionalId).toBe(
      'd-1',
    );
  });

  it('el contador no calcula «en clínica»', async () => {
    const { repo } = fakeRepo();
    await new ClosingQueueUseCases(repo, () => NOW).count(
      query(ClinicRole.ADMIN),
    );
    expect(repo.staleInClinic).not.toHaveBeenCalled();
  });

  it('el contador del menú suma solo las secciones del rol', async () => {
    const { repo } = fakeRepo();
    const c = await new ClosingQueueUseCases(repo, () => NOW).count(
      query(ClinicRole.DENTIST),
    );
    expect(c).toEqual({ total: 0, outcome: null, evolution: 0, treatment: 0 });
  });

  describe('descartar', () => {
    const body = {
      section: 'OUTCOME' as const,
      appointmentId: APPT,
      reasonCode: 'DUPLICATE_APPOINTMENT' as const,
    };

    it('comprueba que sigue pendiente (desde siempre hasta ayer) y guarda descarte y auditoría', async () => {
      const { repo, scopes } = fakeRepo();
      const result = await new ClosingQueueUseCases(repo, () => NOW).dismiss(
        body,
        { userId: 'u-1', role: ClinicRole.ADMIN },
        'ALL',
        ctx(ClinicRole.ADMIN),
      );
      expect(result).toEqual({
        id: 'dis-1',
        section: 'OUTCOME',
        appointmentId: APPT,
        planItemId: null,
        reasonCode: 'DUPLICATE_APPOINTMENT',
        createdAt: NOW,
      });
      expect(scopes.outcome[0]).toEqual(
        expect.objectContaining({ appointmentId: APPT }),
      );
      expect(repo.createDismissal).toHaveBeenCalledWith(
        {
          ...body,
          planItemId: null,
          reasonText: null,
          patientId: 'p-1',
          locationId: MAIN,
        },
        ctx(ClinicRole.ADMIN),
      );
    });

    it('«Otro» sin texto: 400', async () => {
      const { repo } = fakeRepo();
      await expect(
        new ClosingQueueUseCases(repo, () => NOW).dismiss(
          { ...body, reasonCode: 'OTHER', reasonText: ' ' },
          { userId: 'u-1', role: ClinicRole.ADMIN },
          'ALL',
          ctx(ClinicRole.ADMIN),
        ),
      ).rejects.toThrow(new BadRequestException(DISMISSAL_REASON_TEXT_MESSAGE));
      expect(repo.createDismissal).not.toHaveBeenCalled();
    });

    it('una sección que el rol no ve: 403', async () => {
      const { repo } = fakeRepo();
      await expect(
        new ClosingQueueUseCases(repo, () => NOW).dismiss(
          body,
          { userId: 'd-1', role: ClinicRole.DENTIST },
          'ALL',
          ctx(ClinicRole.DENTIST, 'd-1'),
        ),
      ).rejects.toThrow(
        new ForbiddenException(CLOSING_SECTION_FORBIDDEN_MESSAGE),
      );
    });

    it('la cita de otro profesional (DENTIST): 403; de una sede no permitida: 403', async () => {
      const { repo } = fakeRepo();
      const useCases = new ClosingQueueUseCases(repo, () => NOW);
      await expect(
        useCases.dismiss(
          { ...body, section: 'EVOLUTION' },
          { userId: 'd-2', role: ClinicRole.DENTIST },
          'ALL',
          ctx(ClinicRole.DENTIST, 'd-2'),
        ),
      ).rejects.toThrow(new ForbiddenException(CLOSING_OWN_ONLY_MESSAGE));
      await expect(
        useCases.dismiss(
          body,
          { userId: 'u-1', role: ClinicRole.RECEPTION },
          [NORTH],
          ctx(ClinicRole.RECEPTION),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('cita inexistente: 404; ya no pendiente o ya descartada: 409', async () => {
      const { repo } = fakeRepo();
      const useCases = new ClosingQueueUseCases(repo, () => NOW);
      const admin = { userId: 'u-1', role: ClinicRole.ADMIN };
      repo.findAppointment.mockResolvedValueOnce(null);
      await expect(
        useCases.dismiss(body, admin, 'ALL', ctx(ClinicRole.ADMIN)),
      ).rejects.toBeInstanceOf(NotFoundException);
      repo.outcome.mockResolvedValueOnce({ rows: [], total: 0 });
      await expect(
        useCases.dismiss(body, admin, 'ALL', ctx(ClinicRole.ADMIN)),
      ).rejects.toThrow(new ConflictException(DISMISSAL_NOT_PENDING_MESSAGE));
      repo.createDismissal.mockRejectedValueOnce(new DismissalExistsError());
      await expect(
        useCases.dismiss(body, admin, 'ALL', ctx(ClinicRole.ADMIN)),
      ).rejects.toThrow(new ConflictException(DISMISSAL_NOT_PENDING_MESSAGE));
    });
  });
});
