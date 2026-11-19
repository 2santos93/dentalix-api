import {
  BadRequestException,
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AppointmentStatus, ClinicRole, Prisma } from '@prisma/client';
import {
  AppointmentSeriesUseCase,
  closestStart,
} from './appointment-series.use-case';
import {
  SERIES_MESSAGES,
  followingAppointments,
  reasonFromFailure,
  seriesConflict,
} from '../series-conflicts';
import { holidayConflict } from '../holiday-check';
import { RESERVED_SLOT_CODE } from '../schedule-block-check';
import { OVERLAP_MESSAGES } from '../appointment-overlap-error';
import { SeriesSlotWriteError } from '../../domain/ports/appointment-series-repository.port';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type { SeriesSlotContext } from './create-appointment.use-case';

const at = (iso: string) => new Date(iso);
const MIN = 60_000;

describe('closestStart (DX-562: alternativa del mismo día)', () => {
  const opening = (s: string, e: string) => ({ start: at(s), end: at(e) });

  it('el inicio libre más cercano; empate, el posterior; alineado a 5 min', () => {
    expect(
      closestStart(
        [
          opening('2027-01-18T13:00:00Z', '2027-01-18T14:00:00Z'),
          opening('2027-01-18T14:30:00Z', '2027-01-18T17:00:00Z'),
        ],
        at('2027-01-18T14:00:00Z'),
        30 * MIN,
      ),
    ).toEqual({
      start: at('2027-01-18T14:30:00Z'),
      end: at('2027-01-18T15:00:00Z'),
    });
  });

  it('dentro de un hueco largo, la misma hora si cabe', () => {
    expect(
      closestStart(
        [opening('2027-01-18T13:00:00Z', '2027-01-18T17:00:00Z')],
        at('2027-01-18T14:07:00Z'),
        30 * MIN,
      )?.start,
    ).toEqual(at('2027-01-18T14:05:00Z'));
  });

  it('un hueco donde no cabe la duración no cuenta; sin ninguno, null', () => {
    expect(
      closestStart(
        [opening('2027-01-18T13:00:00Z', '2027-01-18T13:20:00Z')],
        at('2027-01-18T13:00:00Z'),
        30 * MIN,
      ),
    ).toBeNull();
    expect(closestStart([], at('2027-01-18T13:00:00Z'), 30 * MIN)).toBeNull();
  });
});

describe('reasonFromFailure (DX-562)', () => {
  it('la regla da el código; el texto es el de la cita suelta', () => {
    expect(
      reasonFromFailure({
        step: 'PROVIDER_OVERLAP',
        error: new ConflictException(OVERLAP_MESSAGES.provider),
      }),
    ).toEqual({
      code: 'PROVIDER_OVERLAP',
      message: 'El profesional ya tiene una cita en ese horario',
    });
    expect(
      reasonFromFailure({
        step: 'BUSINESS_HOURS',
        error: new UnprocessableEntityException('Fuera del horario'),
      }),
    ).toEqual({ code: 'BUSINESS_HOURS', message: 'Fuera del horario' });
  });

  it('el festivo trae su día y nombre; el hueco reservado, su código', () => {
    expect(
      reasonFromFailure({
        step: 'LOCATION_HOLIDAY',
        error: holidayConflict({ date: '2027-02-08', name: 'Carnaval' }),
      }),
    ).toEqual({
      code: 'LOCATION_HOLIDAY',
      message:
        'Ese día la sede está cerrada por festivo («Carnaval»): elige otro día.',
      holiday: { date: '2027-02-08', name: 'Carnaval' },
    });
    expect(
      reasonFromFailure({
        step: 'SCHEDULE_BLOCK',
        error: new ConflictException({
          code: RESERVED_SLOT_CODE,
          message: 'Hueco reservado',
        }),
      }).code,
    ).toBe('RESERVED_SLOT');
    expect(
      reasonFromFailure({
        step: 'SCHEDULE_BLOCK',
        error: new ConflictException('Bloqueado'),
      }).code,
    ).toBe('SCHEDULE_BLOCKED');
  });
});

describe('seriesConflict (DX-562)', () => {
  it('409 APPOINTMENT_SERIES_CONFLICT con todas las fechas', () => {
    const error = seriesConflict([
      {
        index: 3,
        start: at('2027-02-01T14:00:00Z'),
        end: at('2027-02-01T14:30:00Z'),
        reasons: [{ code: 'PAST', message: 'x' }],
      },
    ]);
    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toEqual({
      statusCode: 409,
      error: 'Conflict',
      code: 'APPOINTMENT_SERIES_CONFLICT',
      message: SERIES_MESSAGES.conflict,
      conflicts: [
        {
          index: 3,
          start: '2027-02-01T14:00:00.000Z',
          end: '2027-02-01T14:30:00.000Z',
          reasons: [{ code: 'PAST', message: 'x' }],
        },
      ],
    });
  });
});

describe('followingAppointments (DX-562 D5/D6: esta y las siguientes)', () => {
  const now = at('2027-01-20T12:00:00Z');
  const a = (index: number, status: AppointmentStatus, start: string) => ({
    id: `a${index}`,
    status,
    start: at(start),
    series: { index },
  });

  it('posición ≥ la del pivote, pendientes y futuras; nunca atendidas, en clínica, canceladas ni anteriores', () => {
    const list = [
      a(5, AppointmentStatus.SCHEDULED, '2027-02-17T14:00:00Z'),
      a(1, AppointmentStatus.COMPLETED, '2027-01-13T14:00:00Z'),
      a(2, AppointmentStatus.SCHEDULED, '2027-01-20T11:00:00Z'), // ya empezó
      a(3, AppointmentStatus.CONFIRMED, '2027-02-03T14:00:00Z'),
      a(4, AppointmentStatus.CANCELLED, '2027-02-10T14:00:00Z'),
      a(6, AppointmentStatus.NO_SHOW, '2027-02-24T14:00:00Z'),
      a(7, AppointmentStatus.ARRIVED, '2027-03-03T14:00:00Z'),
    ];
    expect(followingAppointments(list, 2, now).map((x) => x.id)).toEqual([
      'a3',
      'a5',
    ]);
    expect(followingAppointments(list, 4, now).map((x) => x.id)).toEqual([
      'a5',
    ]);
  });
});

describe('AppointmentSeriesUseCase (DX-562)', () => {
  const ctx: AuditRequestContext = {
    tenantId: 't1',
    locationId: 'l1',
    actor: { userId: 'u1', role: ClinicRole.RECEPTION },
    requestId: null,
    ip: null,
    userAgent: null,
  };
  const context: SeriesSlotContext = {
    input: {
      patientId: 'p1',
      providerId: 'd1',
      locationId: 'l1',
      start: at('2030-01-07T14:00:00Z'),
      end: at('2030-01-07T14:30:00Z'),
    },
    chair: null,
    durationMs: 30 * MIN,
  };

  function build(
    over: {
      failuresFor?: (start: Date) => { step: string; error: Error }[];
      create?: jest.Mock;
      notice?: unknown;
    } = {},
  ) {
    const createUseCase = {
      prepareSeries: jest.fn().mockResolvedValue(context),
      checkSeriesSlot: jest.fn((_c: SeriesSlotContext, slot: { start: Date }) =>
        Promise.resolve({
          failures: over.failuresFor?.(slot.start) ?? [],
          warnings: { warnings: [], warningCodes: [] },
        }),
      ),
    };
    const seriesRepo = {
      create:
        over.create ??
        jest.fn().mockResolvedValue({ seriesId: 's1', appointments: [] }),
      noticeContext: jest.fn().mockResolvedValue(over.notice ?? null),
      findById: jest.fn(),
      applyChanges: jest.fn(),
    };
    const email = { prepareInTx: jest.fn() };
    const openings = {
      execute: jest.fn().mockResolvedValue({ openings: [] }),
    };
    const chairs = { raceConflict: jest.fn() };
    const locations = {
      findById: jest
        .fn()
        .mockResolvedValue({ id: 'l1', timeZone: 'America/Caracas' }),
    };
    const tenantContext = {
      getTenantId: () => 't1',
      assertLocationAllowed: jest.fn(),
    };
    const useCase = new AppointmentSeriesUseCase(
      createUseCase as never,
      {} as never,
      openings as never,
      chairs as never,
      seriesRepo,
      locations as never,
      email as never,
      tenantContext as never,
    );
    return { useCase, createUseCase, seriesRepo, email, openings };
  }

  const occurrences = [
    { start: at('2030-01-14T14:00:00Z') },
    { start: at('2030-01-07T14:00:00Z') },
  ];

  it('crear: las fechas por orden (posición 1..n) con la duración de la base', async () => {
    const { useCase, seriesRepo } = build();
    await useCase.createSeries(
      {
        patientId: 'p1',
        start: context.input.start,
        intervalWeeks: 1,
        occurrences,
        notifyPatient: false,
      },
      ctx,
    );
    expect(seriesRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        slots: [
          {
            start: at('2030-01-07T14:00:00Z'),
            end: at('2030-01-07T14:30:00Z'),
          },
          {
            start: at('2030-01-14T14:00:00Z'),
            end: at('2030-01-14T14:30:00Z'),
          },
        ],
        email: null,
        createdById: 'u1',
      }),
    );
  });

  it('crear con dos fechas iguales: 400', async () => {
    const { useCase } = build();
    await expect(
      useCase.createSeries(
        {
          patientId: 'p1',
          start: context.input.start,
          intervalWeeks: 1,
          occurrences: [occurrences[0], occurrences[0]],
          notifyPatient: false,
        },
        ctx,
      ),
    ).rejects.toThrow(new BadRequestException(SERIES_MESSAGES.duplicateStarts));
  });

  it('crear con una fecha que falla: 409 con TODAS las razones y no se escribe nada', async () => {
    const { useCase, seriesRepo } = build({
      failuresFor: (start) =>
        start.getTime() === at('2030-01-14T14:00:00Z').getTime()
          ? [
              {
                step: 'BUSINESS_HOURS',
                error: new UnprocessableEntityException('Fuera del horario'),
              },
              {
                step: 'PATIENT_OVERLAP',
                error: new ConflictException(OVERLAP_MESSAGES.patient),
              },
            ]
          : [],
    });
    const error = await useCase
      .createSeries(
        {
          patientId: 'p1',
          start: context.input.start,
          intervalWeeks: 1,
          occurrences,
          notifyPatient: true,
        },
        ctx,
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'APPOINTMENT_SERIES_CONFLICT',
      conflicts: [
        {
          index: 2,
          reasons: [{ code: 'BUSINESS_HOURS' }, { code: 'PATIENT_OVERLAP' }],
        },
      ],
    });
    expect(seriesRepo.create).not.toHaveBeenCalled();
  });

  it('crear: si la BD resuelve una carrera en la 2.ª (EXCLUDE del paciente), 409 con esa fecha', async () => {
    const exclusion = new Prisma.PrismaClientUnknownRequestError(
      'ERROR: conflicting key value violates exclusion constraint "appointments_no_overlap_per_patient" (23P01)',
      { clientVersion: 'test' },
    );
    const { useCase } = build({
      create: jest
        .fn()
        .mockRejectedValue(
          new SeriesSlotWriteError({ position: 1 }, exclusion),
        ),
    });
    const error = await useCase
      .createSeries(
        {
          patientId: 'p1',
          start: context.input.start,
          intervalWeeks: 1,
          occurrences,
          notifyPatient: false,
        },
        ctx,
      )
      .catch((e: unknown) => e);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'APPOINTMENT_SERIES_CONFLICT',
      conflicts: [
        {
          index: 2,
          start: '2030-01-14T14:00:00.000Z',
          reasons: [
            {
              code: 'PATIENT_OVERLAP',
              message: OVERLAP_MESSAGES.patient,
            },
          ],
        },
      ],
    });
  });

  it('crear: un interbloqueo que se repite es 409 sin fechas (reintentar), no un 500', async () => {
    const deadlock = new Prisma.PrismaClientUnknownRequestError(
      'ERROR: deadlock detected (40P01)',
      { clientVersion: 'test' },
    );
    const { useCase } = build({
      create: jest
        .fn()
        .mockRejectedValue(new SeriesSlotWriteError({ position: 0 }, deadlock)),
    });
    const error = await useCase
      .createSeries(
        {
          patientId: 'p1',
          start: context.input.start,
          intervalWeeks: 1,
          occurrences,
          notifyPatient: false,
        },
        ctx,
      )
      .catch((e: unknown) => e);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'APPOINTMENT_SERIES_CONFLICT',
      message: SERIES_MESSAGES.busy,
      conflicts: [],
    });
  });

  const notice = (over: object = {}) => ({
    clinicName: 'Sonrisas del Norte',
    locationName: 'Chacao',
    locationTimeZone: 'America/Caracas',
    locationLocale: 'es-VE',
    locationHourCycle: 'h12',
    providerName: 'Dra. Rosa Pérez',
    preferredLanguage: null,
    contact: {
      contactChannel: 'EMAIL',
      reminderOptOutAt: null,
      email: 'ana@example.com',
    },
    recipient: {
      firstName: 'Ana',
      birthDate: null,
      email: 'ana@example.com',
      emergencyContactName: null,
    },
    responsibles: [],
    majorityReview: null,
    majorityAge: 18,
    ...over,
  });

  it('el aviso: un email con todas las fechas a quien recibe los recordatorios', async () => {
    const { useCase, email, seriesRepo } = build({ notice: notice() });
    const prepared = { insert: jest.fn(), kick: jest.fn() };
    email.prepareInTx.mockResolvedValue(prepared);
    const result = await useCase.createSeries(
      {
        patientId: 'p1',
        start: context.input.start,
        intervalWeeks: 1,
        occurrences,
        notifyPatient: true,
      },
      ctx,
    );
    expect(email.prepareInTx).toHaveBeenCalledTimes(1);
    expect(email.prepareInTx).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'ana@example.com',
        template: 'appointment-series',
        locale: 'es',
        vars: expect.objectContaining({
          recipientFirstName: 'Ana',
          patientFirstName: null,
          clinicName: 'Sonrisas del Norte',
          locationName: 'Chacao',
          providerName: 'Dra. Rosa Pérez',
          dateLabels: [
            expect.stringContaining('2030'),
            expect.stringContaining('2030'),
          ],
        }) as object,
      }),
    );
    expect(seriesRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: prepared }),
    );
    // Tras el COMMIT, no antes.
    expect(prepared.kick).toHaveBeenCalledTimes(1);
    expect(result.patientNotified).toBe(true);
  });

  it.each([
    ['dado de baja', { reminderOptOutAt: new Date() }],
    ['canal WhatsApp', { contactChannel: 'WHATSAPP' }],
    ['canal ninguno', { contactChannel: 'NONE' }],
    ['sin email', { email: null }],
  ])('sin aviso si el paciente está %s (DX-128)', async (_label, contact) => {
    const base = notice();
    const { useCase, email } = build({
      notice: {
        ...base,
        contact: { ...base.contact, ...contact },
        recipient: {
          ...base.recipient,
          email: (contact as { email?: null }).email ?? base.recipient.email,
        },
      },
    });
    const result = await useCase.createSeries(
      {
        patientId: 'p1',
        start: context.input.start,
        intervalWeeks: 1,
        occurrences,
        notifyPatient: true,
      },
      ctx,
    );
    expect(email.prepareInTx).not.toHaveBeenCalled();
    expect(result.patientNotified).toBe(false);
  });

  it('un fallo al preparar el aviso no impide crear la serie', async () => {
    const { useCase, email, seriesRepo } = build({ notice: notice() });
    email.prepareInTx.mockRejectedValue(new Error('MAIL_ENCRYPTION_KEY'));
    const result = await useCase.createSeries(
      {
        patientId: 'p1',
        start: context.input.start,
        intervalWeeks: 1,
        occurrences,
        notifyPatient: true,
      },
      ctx,
    );
    expect(seriesRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: null }),
    );
    expect(result.patientNotified).toBe(false);
  });

  it('vista previa: fechas generadas con sus razones; recurrencia inválida = 400 en español', async () => {
    const { useCase, openings } = build({
      failuresFor: (start) =>
        start.getTime() === at('2030-01-14T14:00:00Z').getTime()
          ? [
              {
                step: 'PROVIDER_OVERLAP',
                error: new ConflictException(OVERLAP_MESSAGES.provider),
              },
            ]
          : [],
    });
    openings.execute.mockResolvedValue({
      openings: [
        { start: at('2030-01-14T14:30:00Z'), end: at('2030-01-14T17:00:00Z') },
      ],
    });
    const view = await useCase.preview(
      {
        patientId: 'p1',
        start: context.input.start,
        intervalWeeks: 1,
        count: 3,
      },
      ctx,
    );
    expect(view.durationMinutes).toBe(30);
    expect(view.occurrences.map((o) => [o.index, o.status])).toEqual([
      [1, 'OK'],
      [2, 'CONFLICT'],
      [3, 'OK'],
    ]);
    expect(view.occurrences[1].alternative).toEqual({
      start: at('2030-01-14T14:30:00Z'),
      end: at('2030-01-14T15:00:00Z'),
    });
    expect(openings.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'd1',
        locationId: 'l1',
        from: '2030-01-14',
        to: '2030-01-14',
        durationMinutes: 30,
        patientId: 'p1',
      }),
    );
    await expect(
      useCase.preview(
        {
          patientId: 'p1',
          start: context.input.start,
          intervalWeeks: 13,
          count: 3,
        },
        ctx,
      ),
    ).rejects.toThrow(
      new BadRequestException('Repite la cita cada 1 a 12 semanas.'),
    );
  });
});
