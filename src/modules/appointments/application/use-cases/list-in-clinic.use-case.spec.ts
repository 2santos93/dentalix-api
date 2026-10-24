import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AppointmentStatus, ClinicRole } from '@prisma/client';
import { InMemoryAppointmentRepository } from './__fixtures__/in-memory-appointment.repository';
import { ListInClinicUseCase } from './list-in-clinic.use-case';
import type { LocationRepository } from '../../../locations/domain/ports/location-repository.port';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';

// DX-200: panel «En clínica» de la sede: tres grupos, minutos con el reloj del
// servidor, puntualidad por color y el día civil en la zona de la sede.

function locationsWith(zones: Record<string, string>): LocationRepository {
  return {
    findById: (id: string) =>
      Promise.resolve(zones[id] ? { id, timeZone: zones[id] } : null),
  } as unknown as LocationRepository;
}

const at = (iso: string) => new Date(iso);

describe('ListInClinicUseCase (DX-200)', () => {
  // 19 oct 2026, 09:20 en Bogotá (UTC−5).
  const NOW = at('2026-10-19T14:20:00.000Z');

  function setup() {
    const repo = new InMemoryAppointmentRepository();
    repo.providerNames.set('dent-1', 'Dra. Uno');
    const uc = new ListInClinicUseCase(
      repo,
      locationsWith({ bog: 'America/Bogota', mad: 'Europe/Madrid' }),
      new TenantContextService(),
    );
    return { repo, uc };
  }

  it('agrupa en espera / en sillón / listo para cobrar con minutos y color', async () => {
    const { repo, uc } = setup();
    // Llegó a las 08:50 a una cita de las 09:00: verde, 30 min esperando.
    const early = repo.seed({
      locationId: 'bog',
      providerId: 'dent-1',
      patientFirstName: 'Ana',
      patientLastName: 'Uno',
      status: AppointmentStatus.ARRIVED,
      start: at('2026-10-19T14:00:00.000Z'),
      end: at('2026-10-19T14:30:00.000Z'),
      arrivedAt: at('2026-10-19T13:50:00.000Z'),
      reason: 'Endodoncia molar 36',
    });
    // Llegó 4 min tarde: naranja.
    repo.seed({
      locationId: 'bog',
      status: AppointmentStatus.ARRIVED,
      start: at('2026-10-19T14:10:00.000Z'),
      end: at('2026-10-19T14:40:00.000Z'),
      arrivedAt: at('2026-10-19T14:14:00.000Z'),
    });
    // Llegó 15 min tarde y ya está en el sillón desde hace 2 min: rojo.
    repo.seed({
      locationId: 'bog',
      status: AppointmentStatus.IN_CHAIR,
      start: at('2026-10-19T13:30:00.000Z'),
      end: at('2026-10-19T14:30:00.000Z'),
      arrivedAt: at('2026-10-19T13:45:00.000Z'),
      seatedAt: at('2026-10-19T14:18:00.000Z'),
    });
    repo.seed({
      locationId: 'bog',
      status: AppointmentStatus.READY_FOR_CHECKOUT,
      start: at('2026-10-19T13:00:00.000Z'),
      end: at('2026-10-19T13:30:00.000Z'),
      arrivedAt: at('2026-10-19T12:55:00.000Z'),
      seatedAt: at('2026-10-19T13:00:00.000Z'),
      readyForCheckoutAt: at('2026-10-19T14:05:00.000Z'),
    });
    // Fuera del panel: agendada, completada, otra sede, otro día.
    repo.seed({ locationId: 'bog', start: at('2026-10-19T16:00:00.000Z') });
    repo.seed({
      locationId: 'bog',
      status: AppointmentStatus.COMPLETED,
      start: at('2026-10-19T12:00:00.000Z'),
    });
    repo.seed({
      locationId: 'mad',
      status: AppointmentStatus.ARRIVED,
      start: at('2026-10-19T14:00:00.000Z'),
      arrivedAt: at('2026-10-19T14:00:00.000Z'),
    });
    repo.seed({
      locationId: 'bog',
      status: AppointmentStatus.ARRIVED,
      start: at('2026-10-18T14:00:00.000Z'),
      arrivedAt: at('2026-10-18T14:00:00.000Z'),
    });

    const view = await uc.execute(
      { locationId: 'bog', role: ClinicRole.RECEPTION, userId: 'rec-1' },
      NOW,
    );

    expect(view).toMatchObject({
      date: '2026-10-19',
      locationId: 'bog',
      timeZone: 'America/Bogota',
      scope: 'LOCATION',
      now: NOW,
    });
    expect(view.waiting.map((i) => [i.minutesInStatus, i.punctuality])).toEqual(
      [
        [30, 'ON_TIME'],
        [6, 'LATE'],
      ],
    );
    expect(view.waiting[0]).toEqual({
      appointmentId: early.id,
      patientId: early.patientId,
      patientFirstName: 'Ana',
      patientLastName: 'Uno',
      providerId: 'dent-1',
      providerName: 'Dra. Uno',
      start: early.start,
      end: early.end,
      status: AppointmentStatus.ARRIVED,
      arrivedAt: at('2026-10-19T13:50:00.000Z'),
      seatedAt: null,
      readyForCheckoutAt: null,
      minutesInStatus: 30,
      waitedMinutes: 30,
      punctuality: 'ON_TIME',
      planItemsReservedElsewhere: [],
    });
    // Solo nombre y hora: nada clínico (ni motivo ni notas).
    expect(view.waiting[0]).not.toHaveProperty('reason');
    expect(view.waiting[0]).not.toHaveProperty('notes');
    expect(view.inChair).toHaveLength(1);
    expect(view.inChair[0]).toMatchObject({
      minutesInStatus: 2,
      waitedMinutes: 33,
      punctuality: 'VERY_LATE',
    });
    expect(view.readyForCheckout).toHaveLength(1);
    expect(view.readyForCheckout[0].minutesInStatus).toBe(15);
  });

  it('en espera, quien más lleva esperando va primero', async () => {
    const { repo, uc } = setup();
    const later = repo.seed({
      locationId: 'bog',
      status: AppointmentStatus.ARRIVED,
      start: at('2026-10-19T14:00:00.000Z'),
      arrivedAt: at('2026-10-19T14:10:00.000Z'),
    });
    const first = repo.seed({
      locationId: 'bog',
      status: AppointmentStatus.ARRIVED,
      start: at('2026-10-19T14:30:00.000Z'),
      arrivedAt: at('2026-10-19T13:55:00.000Z'),
    });
    const view = await uc.execute(
      { locationId: 'bog', role: ClinicRole.ADMIN, userId: 'adm' },
      NOW,
    );
    expect(view.waiting.map((i) => i.appointmentId)).toEqual([
      first.id,
      later.id,
    ]);
  });

  it('DENTIST: solo sus pacientes («Te esperan»)', async () => {
    const { repo, uc } = setup();
    repo.seed({
      locationId: 'bog',
      providerId: 'dent-1',
      status: AppointmentStatus.ARRIVED,
      start: at('2026-10-19T14:00:00.000Z'),
      arrivedAt: at('2026-10-19T14:00:00.000Z'),
    });
    repo.seed({
      locationId: 'bog',
      providerId: 'dent-2',
      status: AppointmentStatus.ARRIVED,
      start: at('2026-10-19T14:00:00.000Z'),
      arrivedAt: at('2026-10-19T14:00:00.000Z'),
    });
    const mine = await uc.execute(
      { locationId: 'bog', role: ClinicRole.DENTIST, userId: 'dent-1' },
      NOW,
    );
    expect(mine.scope).toBe('MINE');
    expect(mine.waiting.map((i) => i.providerId)).toEqual(['dent-1']);

    const all = await uc.execute(
      { locationId: 'bog', role: ClinicRole.ASSISTANT, userId: 'asi' },
      NOW,
    );
    expect(all.scope).toBe('LOCATION');
    expect(all.waiting).toHaveLength(2);
  });

  it('DX-273: cada persona trae los tratamientos reservados en otra cita', async () => {
    const { repo, uc } = setup();
    const waiting = repo.seed({
      locationId: 'bog',
      status: AppointmentStatus.ARRIVED,
      start: at('2026-10-19T14:00:00.000Z'),
      end: at('2026-10-19T14:30:00.000Z'),
      arrivedAt: at('2026-10-19T13:58:00.000Z'),
    });
    const reserved = {
      planItemId: 'item-1',
      name: 'Implante',
      toothNumber: '36',
      heldInClinic: false,
      appointmentId: 'future-1',
      start: at('2026-10-26T14:00:00.000Z'),
      locationId: 'bog',
      locationName: 'Sede Principal',
      timeZone: 'America/Bogota',
    };
    repo.reservedElsewhere.set(waiting.id, [reserved]);
    const view = await uc.execute(
      { locationId: 'bog', role: ClinicRole.RECEPTION, userId: 'r' },
      NOW,
    );
    expect(view.waiting[0].planItemsReservedElsewhere).toEqual([reserved]);
  });

  it('«hoy» es el día civil de la sede: a las 22:30 de Bogotá ya es mañana en Madrid', async () => {
    const { uc } = setup();
    const late = at('2026-10-20T03:30:00.000Z');
    const bog = await uc.execute(
      { locationId: 'bog', role: ClinicRole.ADMIN, userId: 'a' },
      late,
    );
    const mad = await uc.execute(
      { locationId: 'mad', role: ClinicRole.ADMIN, userId: 'a' },
      late,
    );
    expect(bog.date).toBe('2026-10-19');
    expect(mad.date).toBe('2026-10-20');
    expect(mad.timeZone).toBe('Europe/Madrid');
  });

  it('una cita de las 23:00 de Bogotá (04:00 UTC del día siguiente) cuenta en su día', async () => {
    const { repo, uc } = setup();
    repo.seed({
      locationId: 'bog',
      status: AppointmentStatus.ARRIVED,
      start: at('2026-10-20T04:00:00.000Z'),
      arrivedAt: at('2026-10-20T03:50:00.000Z'),
    });
    const view = await uc.execute(
      {
        locationId: 'bog',
        role: ClinicRole.ADMIN,
        userId: 'a',
        date: '2026-10-19',
      },
      at('2026-10-20T04:05:00.000Z'),
    );
    expect(view.waiting).toHaveLength(1);
    expect(view.waiting[0].minutesInStatus).toBe(15);
  });

  it('una fecha inválida es 400; sin sede, 400; una sede desconocida, 404', async () => {
    const { uc } = setup();
    await expect(
      uc.execute(
        {
          locationId: 'bog',
          role: ClinicRole.ADMIN,
          userId: 'a',
          date: '2026-02-30',
        },
        NOW,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      uc.execute(
        { locationId: undefined, role: ClinicRole.ADMIN, userId: 'a' },
        NOW,
      ),
    ).rejects.toThrow(/Elige una sede/);
    await expect(
      uc.execute(
        { locationId: 'zzz', role: ClinicRole.ADMIN, userId: 'a' },
        NOW,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
