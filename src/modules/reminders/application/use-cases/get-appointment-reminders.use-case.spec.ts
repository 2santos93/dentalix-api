import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { FakeReminderRepository } from '../__fixtures__/fake-reminder.repository';
import { GetAppointmentRemindersUseCase } from './get-appointment-reminders.use-case';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { LOCATION_NOT_ALLOWED_MESSAGE } from '../../../../shared/tenancy/location-access';

const HOUR = 3_600_000;
const NOW = new Date('2026-10-20T12:00:00.000Z');

const tenantContext = new TenantContextService();
const useCase = (repo: FakeReminderRepository) =>
  new GetAppointmentRemindersUseCase(repo, { now: () => NOW }, tenantContext);

describe('GetAppointmentRemindersUseCase (DX-026)', () => {
  it('404 en español si la cita no es de esta clínica', async () => {
    const uc = useCase(new FakeReminderRepository());
    await expect(uc.execute('x')).rejects.toThrow(
      new NotFoundException('Cita no encontrada'),
    );
  });

  it('devuelve los ajustes de la sede y la línea de recordatorios', async () => {
    const repo = new FakeReminderRepository();
    const start = new Date(NOW.getTime() + 30 * HOUR);
    repo.snapshot = {
      appointment: { start, status: 'SCHEDULED', deleted: false },
      locationId: 'loc-norte',
      settings: { enabled: true, leadHours: [48, 2] },
      contact: {
        contactChannel: 'EMAIL',
        reminderOptOutAt: null,
        email: 'ana@example.com',
      },
      records: [
        {
          leadHours: 48,
          appointmentStart: start,
          status: 'SKIPPED',
          skipReason: 'NO_EMAIL',
          sentAt: null,
          emailDelivery: null,
        },
      ],
    };
    const result = await useCase(repo).execute('a-1');
    expect(result.enabled).toBe(true);
    expect(result.leadHours).toEqual([48, 2]);
    expect(result.patientBlocker).toBeNull();
    expect(
      result.items.map((i) => [i.leadHours, i.state, i.skipReason]),
    ).toEqual([
      [48, 'SKIPPED', 'NO_EMAIL'],
      [2, 'PENDING', null],
    ]);
  });

  // DX-128: un paciente con baja o con otro canal no tiene nada pendiente por
  // email; el panel lo dice en vez de mostrar «Pendiente» y luego «No salió».
  it.each([
    [{ reminderOptOutAt: new Date(NOW.getTime() - HOUR) }, 'OPTED_OUT'],
    [{ contactChannel: 'NONE' as const }, 'CHANNEL_NONE'],
    [{ contactChannel: 'WHATSAPP' as const }, 'CHANNEL_WHATSAPP'],
  ])('con %j no fabrica pendientes y explica el motivo', async (over, why) => {
    const repo = new FakeReminderRepository();
    const start = new Date(NOW.getTime() + 30 * HOUR);
    const sent = {
      leadHours: 48,
      appointmentStart: start,
      status: 'SENT' as const,
      skipReason: null,
      sentAt: new Date(NOW.getTime() - 18 * HOUR),
      emailDelivery: 'SENT' as const,
    };
    repo.snapshot = {
      appointment: { start, status: 'SCHEDULED', deleted: false },
      locationId: 'loc-norte',
      settings: { enabled: true, leadHours: [48, 2] },
      contact: {
        contactChannel: 'EMAIL',
        reminderOptOutAt: null,
        email: 'ana@example.com',
        ...over,
      },
      records: [sent],
    };
    const result = await useCase(repo).execute('a-1');
    expect(result.patientBlocker).toBe(why);
    // Lo ya enviado se sigue viendo; lo que faltaba ya no sale.
    expect(result.items.map((i) => [i.leadHours, i.state])).toEqual([
      [48, 'SENT'],
    ]);
  });

  it('sin email sigue como antes: pendiente y, al llegar su hora, NO_EMAIL', async () => {
    const repo = new FakeReminderRepository();
    const start = new Date(NOW.getTime() + 30 * HOUR);
    repo.snapshot = {
      appointment: { start, status: 'SCHEDULED', deleted: false },
      locationId: 'loc-norte',
      settings: { enabled: true, leadHours: [2] },
      contact: { contactChannel: 'EMAIL', reminderOptOutAt: null, email: null },
      records: [],
    };
    const result = await useCase(repo).execute('a-1');
    expect(result.patientBlocker).toBeNull();
    expect(result.items.map((i) => i.state)).toEqual(['PENDING']);
  });

  // SEC-045: la restricción por sedes de DX-089, como GET /appointments/:id.
  it('403 si la cita es de una sede que el miembro no tiene; 200 en la suya', async () => {
    const repo = new FakeReminderRepository();
    repo.snapshot = {
      appointment: {
        start: new Date(NOW.getTime() + 30 * HOUR),
        status: 'SCHEDULED',
        deleted: false,
      },
      locationId: 'loc-sur',
      settings: { enabled: true, leadHours: [2] },
      contact: { contactChannel: 'EMAIL', reminderOptOutAt: null, email: null },
      records: [],
    };
    const asMemberOf = (locationIds: string[]) =>
      tenantContext.run(
        't-1',
        undefined,
        () => useCase(repo).execute('a-1'),
        locationIds,
      );
    const denied = asMemberOf(['loc-norte']);
    await expect(denied).rejects.toBeInstanceOf(ForbiddenException);
    await expect(denied).rejects.toThrow(LOCATION_NOT_ALLOWED_MESSAGE);
    await expect(asMemberOf(['loc-sur'])).resolves.toMatchObject({
      enabled: true,
    });
  });
});
