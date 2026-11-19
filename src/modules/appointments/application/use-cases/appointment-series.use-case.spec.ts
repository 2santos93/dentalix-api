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
import {
  SeriesSlotWriteError,
  SeriesStaleError,
} from '../../domain/ports/appointment-series-repository.port';
import { ArgumentsHost, Logger } from '@nestjs/common';
import { PrismaExceptionFilter } from '../../../../shared/prisma/prisma-exception.filter';
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
      snapshot?: unknown;
      applyChanges?: jest.Mock;
      timeZone?: string;
      linkBase?: string | null;
      noticeOutcome?: 'QUEUED' | 'QUOTA' | null;
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
        jest.fn().mockResolvedValue({
          seriesId: 's1',
          appointments: [{ id: 'a1' }],
          notice: over.noticeOutcome ?? null,
        }),
      noticeContext: jest.fn().mockResolvedValue(over.notice ?? null),
      findById: jest.fn().mockResolvedValue(over.snapshot ?? null),
      applyChanges:
        over.applyChanges ??
        jest.fn((input: { changes: { id: string }[] }) =>
          Promise.resolve(
            input.changes.map((c) => ({ id: c.id, series: { index: 1 } })),
          ),
        ),
    };
    const update = {
      checkSeriesMove: jest
        .fn()
        .mockResolvedValue({ warnings: [], warningCodes: [] }),
      planSeriesMove: jest.fn(
        (_a: unknown, slot: { start: Date; end: Date }) => ({
          start: slot.start,
          end: slot.end,
        }),
      ),
      planSeriesCancellation: jest.fn().mockResolvedValue({
        status: AppointmentStatus.CANCELLED,
      }),
    };
    const linkBases = {
      forTenant: jest.fn().mockResolvedValue(over.linkBase ?? null),
    };
    const config = { get: () => undefined };
    const email = { prepareInTx: jest.fn() };
    const outbound = { logRecorded: jest.fn() };
    const openings = {
      execute: jest.fn().mockResolvedValue({ openings: [] }),
    };
    const chairs = { raceConflict: jest.fn() };
    const locations = {
      findById: jest.fn().mockResolvedValue({
        id: 'l1',
        timeZone: over.timeZone ?? 'America/Caracas',
      }),
    };
    const tenantContext = {
      getTenantId: () => 't1',
      assertLocationAllowed: jest.fn(),
    };
    const useCase = new AppointmentSeriesUseCase(
      createUseCase as never,
      update as never,
      openings as never,
      chairs as never,
      seriesRepo as never,
      locations as never,
      email as never,
      tenantContext as never,
      outbound as never,
      linkBases as never,
      config as never,
    );
    return {
      useCase,
      createUseCase,
      seriesRepo,
      email,
      openings,
      outbound,
      update,
      chairs,
    };
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
        count: 2,
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

  it('crear: cada fecha en un día de la propuesta (400 si no) y una por día', async () => {
    const { useCase, seriesRepo } = build();
    const create = (starts: string[]) =>
      useCase.createSeries(
        {
          patientId: 'p1',
          start: context.input.start,
          intervalWeeks: 1,
          count: 3,
          occurrences: starts.map((x) => ({ start: at(x) })),
          notifyPatient: false,
        },
        ctx,
      );
    // Otro día (el martes): no es de la serie.
    await expect(
      create(['2030-01-07T14:00:00Z', '2030-01-15T14:00:00Z']),
    ).rejects.toThrow(new BadRequestException(SERIES_MESSAGES.offPattern(1)));
    // Dos horas el mismo día de la serie.
    await expect(
      create(['2030-01-07T14:00:00Z', '2030-01-07T18:00:00Z']),
    ).rejects.toThrow(new BadRequestException(SERIES_MESSAGES.sameDay));
    // Más allá de la propuesta (4.ª semana con count 3).
    await expect(
      create(['2030-01-07T14:00:00Z', '2030-01-28T14:00:00Z']),
    ).rejects.toThrow(new BadRequestException(SERIES_MESSAGES.offPattern(1)));
    expect(seriesRepo.create).not.toHaveBeenCalled();
    // Otra hora el MISMO día (la alternativa) sí vale.
    await create(['2030-01-07T14:00:00Z', '2030-01-14T19:30:00Z']);
    expect(seriesRepo.create).toHaveBeenCalledTimes(1);
  });

  it('crear: el index del 409 es el de la vista previa aunque se omitan fechas', async () => {
    const { useCase } = build({
      failuresFor: (start) =>
        start.getTime() === at('2030-01-21T14:00:00Z').getTime()
          ? [
              {
                step: 'PROVIDER_OVERLAP',
                error: new ConflictException(OVERLAP_MESSAGES.provider),
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
          count: 3,
          // Omitida la 2.ª (14/01).
          occurrences: [
            { start: at('2030-01-07T14:00:00Z') },
            { start: at('2030-01-21T14:00:00Z') },
          ],
          notifyPatient: false,
        },
        ctx,
      )
      .catch((e: unknown) => e);
    expect((error as ConflictException).getResponse()).toMatchObject({
      conflicts: [{ index: 3, start: '2030-01-21T14:00:00.000Z' }],
    });
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
          count: 2,
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
          count: 2,
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
          count: 2,
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
    const { useCase, email, seriesRepo, outbound } = build({
      notice: notice(),
      noticeOutcome: 'QUEUED',
    });
    const prepared = { insert: jest.fn(), kick: jest.fn() };
    email.prepareInTx.mockResolvedValue(prepared);
    const result = await useCase.createSeries(
      {
        patientId: 'p1',
        start: context.input.start,
        intervalWeeks: 1,
        count: 2,
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
        // El tope se mira en la transacción; el email enlaza su registro.
        enforceQuota: true,
        referenceId: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
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
    const referenceId = (
      email.prepareInTx.mock.calls[0] as [{ referenceId: string }]
    )[0].referenceId;
    expect(seriesRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        email: expect.objectContaining({
          outbound: {
            id: referenceId,
            recipient: 'ana@example.com',
            recipientKind: 'PATIENT',
            language: 'es',
            languageFallbackFrom: null,
          },
        }) as object,
      }),
    );
    // Tras el COMMIT, no antes.
    expect(prepared.kick).toHaveBeenCalledTimes(1);
    expect(outbound.logRecorded).toHaveBeenCalledWith(
      referenceId,
      't1',
      expect.objectContaining({
        template: 'appointment-series',
        appointmentId: 'a1',
      }),
    );
    expect(result).toMatchObject({
      patientNotified: true,
      notifyReason: null,
    });
  });

  it('el tope de emails lleno (visto en la transacción): la serie se crea, sin aviso, `notifyReason: QUOTA`', async () => {
    const { useCase, email, outbound } = build({
      notice: notice(),
      noticeOutcome: 'QUOTA',
    });
    const prepared = { insert: jest.fn(), kick: jest.fn() };
    email.prepareInTx.mockResolvedValue(prepared);
    const result = await useCase.createSeries(
      {
        patientId: 'p1',
        start: context.input.start,
        intervalWeeks: 1,
        count: 2,
        occurrences,
        notifyPatient: true,
      },
      ctx,
    );
    expect(result).toMatchObject({
      seriesId: 's1',
      patientNotified: false,
      notifyReason: 'QUOTA',
    });
    expect(prepared.kick).not.toHaveBeenCalled();
    expect(outbound.logRecorded).not.toHaveBeenCalled();
  });

  it('`notifyPatient: false`: DISABLED, sin preparar nada', async () => {
    const { useCase, email } = build({ notice: notice() });
    const result = await useCase.createSeries(
      {
        patientId: 'p1',
        start: context.input.start,
        intervalWeeks: 1,
        count: 2,
        occurrences,
        notifyPatient: false,
      },
      ctx,
    );
    expect(email.prepareInTx).not.toHaveBeenCalled();
    expect(result.notifyReason).toBe('DISABLED');
  });

  it.each([
    ['dado de baja', { reminderOptOutAt: new Date() }, 'OPTED_OUT'],
    ['canal WhatsApp', { contactChannel: 'WHATSAPP' }, 'CHANNEL_WHATSAPP'],
    ['canal ninguno', { contactChannel: 'NONE' }, 'CHANNEL_NONE'],
    ['sin email', { email: null }, 'NO_EMAIL'],
  ])(
    'sin aviso si el paciente está %s (DX-128)',
    async (_label, contact, reason) => {
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
          count: 2,
          occurrences,
          notifyPatient: true,
        },
        ctx,
      );
      expect(email.prepareInTx).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        patientNotified: false,
        notifyReason: reason,
      });
    },
  );

  it('un fallo al preparar el aviso no impide crear la serie', async () => {
    const { useCase, email, seriesRepo } = build({ notice: notice() });
    email.prepareInTx.mockRejectedValue(new Error('MAIL_ENCRYPTION_KEY'));
    const result = await useCase.createSeries(
      {
        patientId: 'p1',
        start: context.input.start,
        intervalWeeks: 1,
        count: 2,
        occurrences,
        notifyPatient: true,
      },
      ctx,
    );
    expect(seriesRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: null }),
    );
    expect(result).toMatchObject({
      patientNotified: false,
      notifyReason: 'UNAVAILABLE',
    });
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

  // --- Revisión independiente (DX-562) -----------------------------------

  /** Estado HTTP con el que el filtro global respondería a `error`. */
  function httpStatusOf(error: unknown): number {
    if (error instanceof ConflictException) return error.getStatus();
    const status = jest.fn(() => ({ json: jest.fn() }));
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status, setHeader: jest.fn() }),
      }),
    } as unknown as ArgumentsHost;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    new PrismaExceptionFilter().catch(error as never, host);
    jest.restoreAllMocks();
    return (status.mock.calls[0] as unknown as [number])[0];
  }

  const known = (
    code: string,
    message: string,
    meta?: Record<string, unknown>,
  ) =>
    new Prisma.PrismaClientKnownRequestError(message, {
      code,
      clientVersion: 'test',
      ...(meta ? { meta } : {}),
    });

  it.each([
    [
      'P2028 (la transacción superó su tope)',
      known('P2028', 'Transaction API error: expired transaction'),
      503,
    ],
    [
      'P2002 (único de ítems del plan)',
      known('P2002', 'Unique constraint failed', {
        target: 'appointment_plan_items_active_key',
      }),
      409,
    ],
    [
      '23503 (FK) por SQL crudo',
      known('P2010', 'Raw query failed. Code: `23503`', { code: '23503' }),
      409,
    ],
    [
      '40001 (serialización)',
      known('P2010', 'Raw query failed. Code: `40001`', { code: '40001' }),
      409,
    ],
  ])(
    'crear: una causa sin razón propia (%s) sale SIN el envoltorio, con su código (nunca 500)',
    async (_label, cause, expected) => {
      const { useCase } = build({
        create: jest
          .fn()
          .mockRejectedValue(new SeriesSlotWriteError({ position: 0 }, cause)),
      });
      const error = await useCase
        .createSeries(
          {
            patientId: 'p1',
            start: context.input.start,
            intervalWeeks: 1,
            count: 2,
            occurrences,
            notifyPatient: false,
          },
          ctx,
        )
        .catch((e: unknown) => e);
      expect(error).toBe(cause);
      expect(httpStatusOf(error)).toBe(expected);
    },
  );

  // Serie de 3 lunes a las 10:00 de Caracas (14:00Z), en el futuro.
  const seriesAppointment = (
    index: number,
    start: string,
    over: object = {},
  ) => ({
    id: `a${index}`,
    patientId: 'p1',
    providerId: 'd1',
    locationId: 'l1',
    chairId: null,
    status: AppointmentStatus.SCHEDULED,
    start: at(start),
    end: new Date(at(start).getTime() + 30 * MIN),
    series: { id: 's1', index, total: 3 },
    ...over,
  });
  const snapshot = (list: ReturnType<typeof seriesAppointment>[]) => ({
    id: 's1',
    intervalWeeks: 1,
    occurrences: list.length,
    appointments: list,
  });

  it('mover: cada cambio exige el estado y la hora leídos; se escribe por fecha actual en la dirección del desplazamiento', async () => {
    const applyChanges = jest.fn((input: { changes: { id: string }[] }) =>
      Promise.resolve(
        input.changes.map((c) => ({
          id: c.id,
          series: { index: Number(c.id.slice(1)) },
          start: at('2030-01-01T00:00:00Z'),
          end: at('2030-01-01T00:30:00Z'),
        })),
      ),
    );
    const { useCase } = build({
      applyChanges,
      snapshot: snapshot([
        seriesAppointment(1, '2030-01-07T14:00:00Z'),
        // La 2.ª se movió suelta DESPUÉS de la 3.ª.
        seriesAppointment(2, '2030-01-23T14:00:00Z'),
        seriesAppointment(3, '2030-01-21T14:00:00Z'),
      ]),
    });
    await useCase.moveFollowing(
      's1',
      { fromAppointmentId: 'a1', start: at('2030-01-08T14:00:00Z') },
      ctx,
    );
    const input = applyChanges.mock.calls[0][0] as unknown as {
      changes: { id: string; expect: { status: string; start: Date } }[];
    };
    expect(input.changes.map((c) => c.id)).toEqual(['a2', 'a3', 'a1']);
    expect(input.changes[0].expect).toEqual({
      status: 'SCHEDULED',
      start: at('2030-01-23T14:00:00Z'),
    });
  });

  it('mover a través de un cambio de hora (Nueva York): la misma hora de pared en cada cita', async () => {
    const { useCase, update } = build({
      timeZone: 'America/New_York',
      snapshot: snapshot([
        seriesAppointment(1, '2030-03-04T15:00:00Z'), // lunes 10:00 EST
        seriesAppointment(2, '2030-03-11T14:00:00Z'), // lunes 10:00 EDT
      ]),
    });
    // La 1.ª al martes a las 09:00 EST.
    await useCase.moveFollowing(
      's1',
      { fromAppointmentId: 'a1', start: at('2030-03-05T14:00:00Z') },
      ctx,
    );
    const slots = update.planSeriesMove.mock.calls.map(
      (c) => (c as unknown as [unknown, { start: Date }])[1].start,
    );
    expect(slots.map((d) => d.toISOString()).sort()).toEqual([
      '2030-03-05T14:00:00.000Z',
      '2030-03-12T13:00:00.000Z', // martes 09:00 EDT
    ]);
  });

  it('mover: una cita que cambió entre leer y escribir → 409 APPOINTMENT_SERIES_STALE', async () => {
    const { useCase } = build({
      snapshot: snapshot([
        seriesAppointment(1, '2030-01-07T14:00:00Z'),
        seriesAppointment(2, '2030-01-14T14:00:00Z'),
      ]),
      applyChanges: jest.fn().mockRejectedValue(new SeriesStaleError(['a2'])),
    });
    const error = await useCase
      .moveFollowing(
        's1',
        { fromAppointmentId: 'a1', start: at('2030-01-08T14:00:00Z') },
        ctx,
      )
      .catch((e: unknown) => e);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'APPOINTMENT_SERIES_STALE',
      message: SERIES_MESSAGES.stale,
      appointmentIds: ['a2'],
    });
  });

  it('mover y cancelar: un 40P01 vuelve a LEER y planificar (no repite el plan); el segundo, 409 sin fechas', async () => {
    const deadlock = new SeriesSlotWriteError(
      { appointmentId: 'a1' },
      new Prisma.PrismaClientUnknownRequestError(
        'ERROR: deadlock detected (40P01)',
        { clientVersion: 'test' },
      ),
    );
    const applyChanges = jest
      .fn()
      .mockRejectedValueOnce(deadlock)
      .mockResolvedValueOnce([]);
    const { useCase, seriesRepo } = build({
      snapshot: snapshot([seriesAppointment(1, '2030-01-07T14:00:00Z')]),
      applyChanges,
    });
    await useCase.moveFollowing(
      's1',
      { fromAppointmentId: 'a1', start: at('2030-01-08T14:00:00Z') },
      ctx,
    );
    expect(seriesRepo.findById).toHaveBeenCalledTimes(2);
    expect(applyChanges).toHaveBeenCalledTimes(2);

    applyChanges.mockReset().mockRejectedValue(deadlock);
    const error = await useCase
      .cancelFollowing(
        's1',
        {
          fromAppointmentId: 'a1',
          cancellation: { byKind: 'CLINIC', reasonCode: 'CLINIC_RESCHEDULE' },
        },
        ctx,
      )
      .catch((e: unknown) => e);
    expect(applyChanges).toHaveBeenCalledTimes(2);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'APPOINTMENT_SERIES_CONFLICT',
      message: SERIES_MESSAGES.busy,
      conflicts: [],
    });
  });

  it('cancelar: cada cambio exige el estado y la hora leídos', async () => {
    const applyChanges = jest.fn().mockResolvedValue([{ id: 'a2' }]);
    const { useCase } = build({
      snapshot: snapshot([
        seriesAppointment(1, '2030-01-07T14:00:00Z'),
        seriesAppointment(2, '2030-01-14T14:00:00Z', {
          status: AppointmentStatus.CONFIRMED,
        }),
      ]),
      applyChanges,
    });
    await useCase.cancelFollowing(
      's1',
      {
        fromAppointmentId: 'a2',
        cancellation: { byKind: 'CLINIC', reasonCode: 'CLINIC_RESCHEDULE' },
      },
      ctx,
    );
    expect(applyChanges).toHaveBeenCalledWith(
      expect.objectContaining({
        lock: null,
        changes: [
          expect.objectContaining({
            id: 'a2',
            expect: {
              status: 'CONFIRMED',
              start: at('2030-01-14T14:00:00Z'),
            },
          }),
        ],
      }),
    );
  });

  it('DX-128: con host seguro, el aviso lleva el enlace de baja y su fila va con el email', async () => {
    const { useCase, email, seriesRepo } = build({
      notice: notice(),
      noticeOutcome: 'QUEUED',
      linkBase: 'https://demo.dentalix.app',
    });
    email.prepareInTx.mockResolvedValue({ insert: jest.fn(), kick: jest.fn() });
    await useCase.createSeries(
      {
        patientId: 'p1',
        start: context.input.start,
        intervalWeeks: 1,
        count: 2,
        occurrences,
        notifyPatient: true,
      },
      ctx,
    );
    const vars = (
      email.prepareInTx.mock.calls[0] as [{ vars: { unsubscribeUrl: string } }]
    )[0].vars;
    expect(vars.unsubscribeUrl).toMatch(
      /^https:\/\/demo\.dentalix\.app\/baja\/[A-Za-z0-9_-]{43}$/,
    );
    const write = (
      seriesRepo.create.mock.calls[0] as [
        { email: { optOut: { patientId: string; tokenHash: string } } },
      ]
    )[0].email;
    expect(write.optOut.patientId).toBe('p1');
    expect(write.optOut.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
