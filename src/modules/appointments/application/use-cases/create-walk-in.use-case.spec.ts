import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  AppointmentStatus,
  ClinicRole,
  DocumentType,
  Prisma,
  TriageFlag,
} from '@prisma/client';
import { CreateWalkInUseCase } from './create-walk-in.use-case';
import { InMemoryAppointmentRepository } from './__fixtures__/in-memory-appointment.repository';
import { InMemoryScheduleBlockRepository } from '../../../schedule-blocks/application/__fixtures__/in-memory-schedule-blocks';
import { InMemoryAppointmentTypeRepository } from '../../../appointment-types/application/__fixtures__/in-memory-appointment-types';
import { inMemoryAvailability } from '../../../provider-schedule/application/__fixtures__/availability';
import type { PatientRepository } from '../../../patients/domain/ports/patient-repository.port';
import type { StaffRepository } from '../../../staff/domain/ports/staff-repository.port';
import type { LocationRepository } from '../../../locations/domain/ports/location-repository.port';
import type {
  WalkInReplay,
  WalkInRepository,
  WalkInWrite,
} from '../../domain/ports/walk-in-repository.port';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { PROVIDER_NOT_AT_LOCATION_MESSAGE } from '../../../staff/domain/provider-location';
import {
  IDEMPOTENCY_KEY_REUSED_CODE,
  NO_RESERVED_SLOT_CODE,
  PATIENT_DUPLICATE_CODE,
  WALK_IN_MESSAGES,
  WALK_IN_ROLES,
} from '../../domain/walk-in';
import { PATIENT_ROLES } from '../../../auth/presentation/guards/clinic-role-sets';
import { DOC_TAKEN_MESSAGE } from '../../../patients/infrastructure/repositories/prisma-patient.repository';

// DX-470: «Atender sin cita». Martes 10 nov 2026 en la zona de la sede (UTC−5): las
// 10:07:42 del reloj del servidor son las 15:07:42 UTC.
const NOW = new Date('2026-11-10T15:07:42.000Z');
const utc = (hhmm: string) => new Date(`2026-11-10T${hhmm}:00.000Z`);

const CTX: AuditRequestContext = {
  tenantId: 't1',
  locationId: 'loc1',
  actor: { userId: 'rec-1', role: ClinicRole.RECEPTION },
  requestId: 'req-1',
  ip: null,
  userAgent: null,
};

function setup(
  options: {
    patientExists?: boolean;
    provider?: { userId: string; locationIds: string[] | null } | null;
    /** Paciente vivo de la clínica con ese documento normalizado. */
    docOwner?: { id: string; firstName: string; lastName: string } | null;
  } = {},
) {
  const appointments = new InMemoryAppointmentRepository();
  const blocks = new InMemoryScheduleBlockRepository();
  const types = new InMemoryAppointmentTypeRepository();
  const urgent = types.seed({
    name: 'Consulta de urgencia',
    durationMinutes: 30,
    isUrgent: true,
  });
  const cleaning = types.seed({ name: 'Limpieza', durationMinutes: 30 });
  const writes: WalkInWrite[] = [];
  let failWith: Error | null = null;
  const docLookups: string[] = [];
  // DX-510: lo que el doble guarda por Idempotency-Key (como la columna).
  const byKey = new Map<string, WalkInReplay>();
  const walkIns: WalkInRepository = {
    findLivePatientIdByDoc: (docNumber) => {
      docLookups.push(docNumber);
      return Promise.resolve(options.docOwner?.id ?? null);
    },
    findByIdempotencyKey: (key) => Promise.resolve(byKey.get(key) ?? null),
    create: (input) => {
      writes.push(input);
      if (failWith) return Promise.reject(failWith);
      const stored = input.idempotency && byKey.get(input.idempotency.key);
      if (stored) return Promise.resolve({ replayed: true, ...stored });
      const patientId =
        input.patient.kind === 'existing' ? input.patient.id : 'new-patient';
      const appointment = appointments.seed({
        patientId,
        providerId: input.providerId,
        locationId: input.locationId,
        appointmentTypeId: input.appointmentTypeId,
        start: input.start,
        end: input.end,
        status: AppointmentStatus.ARRIVED,
        arrivedAt: input.arrivedAt,
        walkIn: true,
        overbooked: input.overbookReason !== null,
        triageFlags: input.triageFlags,
        triageNote: input.triageNote,
      });
      const overbookId = input.overbookReason !== null ? 'override-1' : null;
      if (input.idempotency) {
        byKey.set(input.idempotency.key, {
          appointment,
          overbookId,
          fingerprint: input.idempotency.fingerprint,
        });
      }
      return Promise.resolve({
        replayed: false,
        appointment,
        patientCreated: input.patient.kind === 'new',
        overbookId,
      });
    },
  };
  const patients = {
    findById: (id: string) =>
      Promise.resolve(
        options.docOwner && id === options.docOwner.id
          ? options.docOwner
          : options.patientExists === false
            ? null
            : { id: 'p1' },
      ),
  } as unknown as PatientRepository;
  const provider =
    options.provider === undefined
      ? { userId: 'prov1', locationIds: null }
      : options.provider;
  const staff = {
    findById: () => Promise.resolve(provider),
  } as unknown as StaffRepository;
  const locations = {
    findById: (id: string) =>
      Promise.resolve({ id, name: 'Sede', timeZone: 'America/Bogota' }),
  } as unknown as LocationRepository;
  const uc = new CreateWalkInUseCase(
    appointments,
    walkIns,
    patients,
    staff,
    types,
    blocks,
    locations,
    inMemoryAvailability(),
    () => NOW,
  );
  const reserved = (start: string, end: string, typeIds = [urgent.id]) =>
    blocks.seed({
      kind: 'RESERVED',
      providerId: 'prov1',
      locationId: 'loc1',
      start: utc(start),
      end: utc(end),
      reservedForTypeIds: typeIds,
    });
  return {
    uc,
    appointments,
    blocks,
    types,
    urgent,
    cleaning,
    writes,
    docLookups,
    reserved,
    byKey,
    fail: (error: Error) => {
      failWith = error;
    },
  };
}

const NEW_PATIENT = {
  firstName: ' Lucía ',
  lastName: 'Pérez',
  phone: ' +57 300 123 4567 ',
};

describe('CreateWalkInUseCase (DX-470)', () => {
  it('paciente nuevo en el primer hueco reservado libre: ARRIVED, urgente, llegada ahora', async () => {
    const { uc, writes, reserved, urgent } = setup();
    reserved('20:00', '20:30');
    const block = reserved('17:00', '18:00');

    const result = await uc.execute(
      {
        newPatient: NEW_PATIENT,
        providerId: 'prov1',
        triageFlags: [TriageFlag.SWELLING, TriageFlag.PAIN, TriageFlag.PAIN],
        triageNote: '  Muela 36  ',
      },
      CTX,
    );

    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({
      patient: {
        kind: 'new',
        data: {
          firstName: 'Lucía',
          lastName: 'Pérez',
          phone: '+57 300 123 4567',
          docType: DocumentType.OTHER,
          docTypeLabel: null,
          docNumber: undefined,
        },
      },
      providerId: 'prov1',
      locationId: 'loc1',
      appointmentTypeId: urgent.id,
      start: utc('17:00'),
      end: utc('17:30'),
      arrivedAt: NOW,
      triageFlags: ['PAIN', 'SWELLING'],
      triageNote: 'Muela 36',
      overbookReason: null,
      createdById: 'rec-1',
    });
    expect(block.id).toBeDefined();
    expect(result).toMatchObject({
      status: AppointmentStatus.ARRIVED,
      walkIn: true,
      overbooked: false,
      patientCreated: true,
      overbookId: null,
      warnings: [],
    });
  });

  it('un reservado en curso: la cita empieza en el minuto actual', async () => {
    const { uc, writes, reserved } = setup();
    reserved('15:00', '16:00');
    await uc.execute({ patientId: 'p1', providerId: 'prov1' }, CTX);
    expect(writes[0]).toMatchObject({
      patient: { kind: 'existing', id: 'p1' },
      start: utc('15:07'),
      end: utc('15:37'),
    });
  });

  it('salta lo ocupado del profesional y del paciente', async () => {
    const { uc, writes, reserved, appointments } = setup();
    reserved('17:00', '18:30');
    appointments.seed({
      providerId: 'prov1',
      patientId: 'p-otra',
      start: utc('17:00'),
      end: utc('17:30'),
    });
    appointments.seed({
      providerId: 'other',
      patientId: 'p1',
      start: utc('17:30'),
      end: utc('18:00'),
    });
    await uc.execute({ patientId: 'p1', providerId: 'prov1' }, CTX);
    expect(writes[0]).toMatchObject({ start: utc('18:00'), end: utc('18:30') });
  });

  it('sin hueco reservado libre: 409 NO_RESERVED_SLOT que ofrece el sobrecupo', async () => {
    const { uc, writes, reserved, cleaning } = setup();
    reserved('13:00', '14:00'); // ya pasó
    reserved('17:00', '18:00', [cleaning.id]); // otro tipo
    const error = await uc
      .execute({ patientId: 'p1', providerId: 'prov1' }, CTX)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toEqual({
      statusCode: 409,
      error: 'Conflict',
      code: NO_RESERVED_SLOT_CODE,
      message: WALK_IN_MESSAGES.noReservedSlot,
      canOverbook: true,
    });
    expect(writes).toHaveLength(0);
  });

  it('alta mínima con documento repetido y sin hueco: 409 PATIENT_DUPLICATE con el existente ANTES del sobrecupo', async () => {
    const owner = {
      id: 'p-dup',
      firstName: 'Sebastián',
      lastName: 'Niño Cabrera',
    };
    const { uc, writes, docLookups } = setup({ docOwner: owner });
    // Sin ningún reservado: antes pedía el motivo del sobrecupo primero.
    const error = await uc
      .execute(
        {
          newPatient: { ...NEW_PATIENT, docNumber: ' DEMO-0024 ' },
          providerId: 'prov1',
        },
        CTX,
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toEqual({
      statusCode: 409,
      error: 'Conflict',
      code: PATIENT_DUPLICATE_CODE,
      message: DOC_TAKEN_MESSAGE,
      existingPatientId: 'p-dup',
      existingPatient: {
        id: 'p-dup',
        firstName: 'Sebastián',
        lastName: 'Niño Cabrera',
      },
    });
    expect(docLookups).toEqual(['DEMO-0024']);
    expect(writes).toHaveLength(0);
  });

  it('documento repetido también con motivo de sobrecupo o con hueco: el duplicado manda', async () => {
    const owner = { id: 'p-dup', firstName: 'Sebastián', lastName: 'Niño' };
    const { uc, writes, reserved } = setup({ docOwner: owner });
    reserved('17:00', '18:00');
    for (const extra of [{}, { overbookReason: 'Dolor agudo' }]) {
      const error = await uc
        .execute(
          {
            newPatient: { ...NEW_PATIENT, docNumber: '470.001' },
            providerId: 'prov1',
            ...extra,
          },
          CTX,
        )
        .catch((e: unknown) => e);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: PATIENT_DUPLICATE_CODE,
        existingPatient: { id: 'p-dup', firstName: 'Sebastián' },
      });
    }
    expect(writes).toHaveLength(0);
  });

  it('sin documento o con un documento libre: no se busca duplicado o sigue al hueco', async () => {
    const { uc, writes, docLookups, reserved } = setup();
    reserved('17:00', '18:00');
    await uc.execute({ newPatient: NEW_PATIENT, providerId: 'prov1' }, CTX);
    expect(docLookups).toEqual([]);
    await expect(
      uc.execute(
        {
          newPatient: { ...NEW_PATIENT, docNumber: 'LIBRE-1' },
          providerId: 'prov1',
        },
        CTX,
      ),
    ).resolves.toMatchObject({ patientCreated: true });
    expect(docLookups).toEqual(['LIBRE-1']);
    expect(writes).toHaveLength(2);
  });

  it('carrera: el duplicado que detecta la transacción también trae al existente', async () => {
    const owner = { id: 'p-dup', firstName: 'Sebastián', lastName: 'Niño' };
    const { uc, reserved, fail } = setup();
    reserved('17:00', '18:00');
    // La consulta previa no lo vio (otra alta en paralelo); la transacción sí.
    fail(
      new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: PATIENT_DUPLICATE_CODE,
        message: DOC_TAKEN_MESSAGE,
        existingPatientId: 'p-dup',
      }),
    );
    const patients = (uc as unknown as { patients: { findById: unknown } })
      .patients;
    patients.findById = () => Promise.resolve(owner);
    const error = await uc
      .execute(
        {
          newPatient: { ...NEW_PATIENT, docNumber: 'X-1' },
          providerId: 'prov1',
        },
        CTX,
      )
      .catch((e: unknown) => e);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: PATIENT_DUPLICATE_CODE,
      existingPatientId: 'p-dup',
      existingPatient: {
        id: 'p-dup',
        firstName: 'Sebastián',
        lastName: 'Niño',
      },
    });
  });

  it('quien puede «Atender sin cita» puede leer pacientes: el 409 puede nombrar al existente', () => {
    for (const role of WALK_IN_ROLES) expect(PATIENT_ROLES).toContain(role);
  });

  it('sobrecupo con motivo: ahora, anotado aunque el profesional esté ocupado', async () => {
    const { uc, writes, appointments } = setup();
    appointments.seed({
      providerId: 'prov1',
      patientId: 'p-otra',
      start: utc('15:00'),
      end: utc('15:30'),
    });
    const result = await uc.execute(
      {
        patientId: 'p1',
        providerId: 'prov1',
        overbookReason: '  Dolor agudo, no puede esperar  ',
      },
      CTX,
    );
    expect(writes[0]).toMatchObject({
      start: utc('15:07'),
      end: utc('15:37'),
      overbookReason: 'Dolor agudo, no puede esperar',
    });
    expect(result).toMatchObject({
      overbooked: true,
      overbookId: 'override-1',
    });
  });

  it('motivo del sobrecupo inválido y nota de más de 200: 400 sin escribir', async () => {
    const { uc, writes } = setup();
    await expect(
      uc.execute(
        { patientId: 'p1', providerId: 'prov1', overbookReason: 'ya' },
        CTX,
      ),
    ).rejects.toThrow(/entre 5 y 300/);
    await expect(
      uc.execute(
        { patientId: 'p1', providerId: 'prov1', triageNote: 'x'.repeat(201) },
        CTX,
      ),
    ).rejects.toThrow('La nota de triaje admite como mucho 200 caracteres.');
    expect(writes).toHaveLength(0);
  });

  it('exactamente uno: paciente existente o alta mínima', async () => {
    const { uc } = setup();
    await expect(uc.execute({ providerId: 'prov1' }, CTX)).rejects.toThrow(
      WALK_IN_MESSAGES.patientChoice,
    );
    await expect(
      uc.execute(
        { patientId: 'p1', newPatient: NEW_PATIENT, providerId: 'prov1' },
        CTX,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('alta mínima con nombre, apellido o teléfono en blanco tras recortar: 400 sin escribir', async () => {
    const { uc, writes } = setup();
    for (const patch of [
      { firstName: '   ' },
      { lastName: '\t ' },
      { phone: '  12   ' },
    ]) {
      await expect(
        uc.execute(
          { newPatient: { ...NEW_PATIENT, ...patch }, providerId: 'prov1' },
          CTX,
        ),
      ).rejects.toThrow(WALK_IN_MESSAGES.newPatientBlank);
    }
    expect(writes).toHaveLength(0);
  });

  it('paciente o profesional de otra clínica (o inexistentes): 404', async () => {
    await expect(
      setup({ patientExists: false }).uc.execute(
        { patientId: 'p-ajeno', providerId: 'prov1' },
        CTX,
      ),
    ).rejects.toThrow(NotFoundException);
    await expect(
      setup({ provider: null }).uc.execute(
        { patientId: 'p1', providerId: 'prov-ajeno' },
        CTX,
      ),
    ).rejects.toThrow('Profesional no encontrado');
  });

  it('profesional que no atiende en la sede: 400', async () => {
    await expect(
      setup({
        provider: { userId: 'prov1', locationIds: ['loc2'] },
      }).uc.execute(
        { patientId: 'p1', providerId: 'prov1', overbookReason: 'Dolor agudo' },
        CTX,
      ),
    ).rejects.toThrow(PROVIDER_NOT_AT_LOCATION_MESSAGE);
  });

  it('tipo: el pedido tiene que ser urgente y activo; sin urgentes, 409', async () => {
    const { uc, cleaning, types, urgent } = setup();
    await expect(
      uc.execute(
        {
          patientId: 'p1',
          providerId: 'prov1',
          appointmentTypeId: cleaning.id,
        },
        CTX,
      ),
    ).rejects.toThrow(WALK_IN_MESSAGES.notUrgentType);
    await types.update(urgent.id, { active: false });
    await expect(
      uc.execute(
        { patientId: 'p1', providerId: 'prov1', overbookReason: 'Dolor agudo' },
        CTX,
      ),
    ).rejects.toThrow(WALK_IN_MESSAGES.noUrgentType);
  });

  it('un bloqueo que no deja agendar (vacaciones) manda: 409', async () => {
    const { uc, blocks, writes } = setup();
    blocks.seed({
      providerId: 'prov1',
      start: utc('12:00'),
      end: utc('23:00'),
      kind: 'VACATION',
    });
    await expect(
      uc.execute(
        { patientId: 'p1', providerId: 'prov1', overbookReason: 'Dolor agudo' },
        CTX,
      ),
    ).rejects.toThrow(ConflictException);
    expect(writes).toHaveLength(0);
  });

  it('el paciente ya está en otra cita a esa hora: 409', async () => {
    const { uc, appointments } = setup();
    appointments.seed({
      providerId: 'other',
      patientId: 'p1',
      start: utc('15:00'),
      end: utc('15:30'),
    });
    await expect(
      uc.execute(
        { patientId: 'p1', providerId: 'prov1', overbookReason: 'Dolor agudo' },
        CTX,
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('carrera por el mismo hueco (EXCLUDE 23P01): 409 que pide reintentar', async () => {
    const { uc, reserved, fail } = setup();
    reserved('17:00', '17:30');
    fail(
      new Prisma.PrismaClientUnknownRequestError(
        'code: "23P01", message: "conflicting key value violates exclusion constraint \\"appointments_no_overlap_per_provider\\""',
        { clientVersion: 'test' },
      ),
    );
    await expect(
      uc.execute({ patientId: 'p1', providerId: 'prov1' }, CTX),
    ).rejects.toThrow(WALK_IN_MESSAGES.slotTaken);
  });

  describe('Idempotency-Key (DX-510)', () => {
    const KEY = '0F8FAD5B-D9CB-469F-A165-70867728950E';

    it('dos envíos con la misma clave: la misma cita, sin segundo paciente ni segunda cita', async () => {
      const { uc, writes, reserved, appointments } = setup();
      reserved('17:00', '18:00');
      const input = { newPatient: NEW_PATIENT, providerId: 'prov1' };

      const first = await uc.execute(input, CTX, KEY);
      const second = await uc.execute(
        { ...input, newPatient: { ...NEW_PATIENT, firstName: 'Lucía' } },
        CTX,
        ` ${KEY.toLowerCase()} `,
      );

      expect(first.patientCreated).toBe(true);
      expect(second.id).toBe(first.id);
      expect(second.patientCreated).toBe(false);
      expect(second.overbookId).toBe(first.overbookId);
      // El atajo encontró la cita antes de escribir: una sola escritura.
      expect(writes).toHaveLength(1);
      expect(writes[0].idempotency).toEqual({
        key: KEY.toLowerCase(),
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
      });
      expect(
        await appointments.findOverlapping('prov1', utc('00:00'), utc('23:59')),
      ).toHaveLength(1);
    });

    it('misma clave con otros datos: 422 IDEMPOTENCY_KEY_REUSED y nada nuevo', async () => {
      const { uc, writes, reserved } = setup();
      reserved('17:00', '19:00');
      await uc.execute({ patientId: 'p1', providerId: 'prov1' }, CTX, KEY);

      const variants = [
        {
          patientId: 'p1',
          providerId: 'prov1',
          triageFlags: [TriageFlag.PAIN],
        },
        { patientId: 'p1', providerId: 'prov1', triageNote: 'otra' },
        { patientId: 'p2', providerId: 'prov1' },
        {
          patientId: 'p1',
          providerId: 'prov1',
          overbookReason: 'Dolor agudo, no espera',
        },
      ];
      for (const variant of variants) {
        const error = await uc
          .execute(variant, CTX, KEY)
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(UnprocessableEntityException);
        expect(
          (error as UnprocessableEntityException).getResponse(),
        ).toMatchObject({
          code: IDEMPOTENCY_KEY_REUSED_CODE,
          message: WALK_IN_MESSAGES.idempotencyKeyReused,
        });
      }
      expect(writes).toHaveLength(1);
    });

    it('la transacción encuentra la cita de la otra petición con la misma clave: la devuelve', async () => {
      const { uc, writes, reserved, byKey } = setup();
      reserved('17:00', '18:00');
      const input = { patientId: 'p1', providerId: 'prov1' };
      const first = await uc.execute(input, CTX, KEY);
      // Simula la carrera: el atajo no la vio (la primera aún no había
      // confirmado) pero la transacción, tras el candado, sí.
      const stored = byKey.get(KEY.toLowerCase())!;
      byKey.delete(KEY.toLowerCase());
      let lookups = 0;
      const original = byKey.get.bind(byKey);
      byKey.get = (k: string) =>
        lookups++ === 0 ? undefined : (original(k) ?? stored);

      const second = await uc.execute(input, CTX, KEY);
      expect(second.id).toBe(first.id);
      expect(second.patientCreated).toBe(false);
      expect(writes).toHaveLength(2);
    });

    it('carrera: lo que ve la segunda petición (p. ej. el hueco ocupado) es la cita de la primera', async () => {
      const { uc, reserved, byKey, fail } = setup();
      reserved('17:00', '18:00');
      const input = { patientId: 'p1', providerId: 'prov1' };
      const first = await uc.execute(input, CTX, KEY);
      const stored = byKey.get(KEY.toLowerCase())!;
      byKey.delete(KEY.toLowerCase());
      fail(
        new Prisma.PrismaClientUnknownRequestError(
          'conflicting key value violates exclusion constraint "appointments_no_overlap_per_provider" 23P01',
          { clientVersion: 'x' },
        ),
      );
      let lookups = 0;
      const original = byKey.get.bind(byKey);
      byKey.get = (k: string) =>
        lookups++ === 0 ? undefined : (original(k) ?? stored);

      const second = await uc.execute(input, CTX, KEY);
      expect(second.id).toBe(first.id);
    });

    it('sin clave: como siempre (dos envíos, dos citas); clave que no es UUID: 400', async () => {
      const { uc, writes, reserved } = setup();
      reserved('17:00', '18:00');
      await uc.execute({ patientId: 'p1', providerId: 'prov1' }, CTX);
      await uc.execute({ patientId: 'p2', providerId: 'prov1' }, CTX, '  ');
      expect(writes).toHaveLength(2);
      expect(writes.every((w) => w.idempotency === undefined)).toBe(true);
      await expect(
        uc.execute({ patientId: 'p1', providerId: 'prov1' }, CTX, 'doble-clic'),
      ).rejects.toThrow(
        new BadRequestException(WALK_IN_MESSAGES.idempotencyKeyInvalid),
      );
      expect(writes).toHaveLength(2);
    });
  });
});
