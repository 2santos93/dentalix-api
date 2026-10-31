import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { CreateConfirmationLinkUseCase } from './create-confirmation-link.use-case';
import { InMemoryAppointmentConfirmationRepository } from './__fixtures__/in-memory-appointment-confirmation.repository';
import { hashConfirmationToken } from '../confirmation-token';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { LOCATION_NOT_ALLOWED_MESSAGE } from '../../../../shared/tenancy/location-access';

describe('CreateConfirmationLinkUseCase', () => {
  let repo: InMemoryAppointmentConfirmationRepository;
  let uc: CreateConfirmationLinkUseCase;
  let ctx: TenantContextService;

  beforeEach(() => {
    repo = new InMemoryAppointmentConfirmationRepository();
    ctx = new TenantContextService();
    uc = new CreateConfirmationLinkUseCase(repo, ctx);
  });

  it('genera un token de un solo uso que caduca al inicio de la cita y guarda SOLO su hash', async () => {
    const appointment = repo.addAppointment();

    const result = await uc.execute({
      appointmentId: appointment.id,
      createdById: 'user-1',
    });

    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.expiresAt).toEqual(appointment.start);
    expect(repo.confirmations).toHaveLength(1);
    const stored = repo.confirmations[0];
    expect(stored.tokenHash).toBe(hashConfirmationToken(result.token));
    expect(JSON.stringify(stored)).not.toContain(result.token);
    expect(stored.appointmentStart).toEqual(appointment.start);
    expect(stored.appointmentStatus).toBe('SCHEDULED');
    expect(
      repo.appointments.get(appointment.id)?.confirmationSentAt,
    ).toBeInstanceOf(Date);
  });

  it('devuelve los datos del mensaje (nombre de pila, profesional, sede) y el número de WhatsApp', async () => {
    const appointment = repo.addAppointment();

    const result = await uc.execute({ appointmentId: appointment.id });

    expect(result.whatsappPhone).toBe('573105550101');
    expect(result.appointment).toEqual({
      patientFirstName: 'Ana',
      start: appointment.start,
      end: appointment.end,
      providerName: 'Dra. Pérez',
      locationName: 'Sede Principal',
      locationAddress: 'Calle 1 # 2-3',
    });
  });

  it('el recordatorio automático (DX-026) pide conservar «pide llamada»; recepción, no', async () => {
    const appointment = repo.addAppointment();
    const issue = jest.spyOn(repo, 'issue');

    await uc.execute({ appointmentId: appointment.id, automatic: true });
    expect(issue).toHaveBeenLastCalledWith(
      expect.objectContaining({ keepCallbackRequest: true }),
    );

    await uc.execute({ appointmentId: appointment.id, createdById: 'u-1' });
    expect(issue).toHaveBeenLastCalledWith(
      expect.objectContaining({ keepCallbackRequest: false }),
    );
  });

  it('whatsappPhone es null si el paciente no tiene un teléfono utilizable', async () => {
    const appointment = repo.addAppointment({ patientPhone: null });
    const result = await uc.execute({ appointmentId: appointment.id });
    expect(result.whatsappPhone).toBeNull();
  });

  it("a number without + is read with the appointment's location region", async () => {
    const withRegion = repo.addAppointment({
      patientPhone: '0412-1234567',
      locationPhoneRegion: 'VE',
    });
    expect(
      (await uc.execute({ appointmentId: withRegion.id })).whatsappPhone,
    ).toBe('584121234567');
    const withoutRegion = repo.addAppointment({ patientPhone: '0412-1234567' });
    expect(
      (await uc.execute({ appointmentId: withoutRegion.id })).whatsappPhone,
    ).toBeNull();
    const ambiguous = repo.addAppointment({
      patientPhone: '0058 412 1234567',
      locationPhoneRegion: 'CO',
    });
    expect(
      (await uc.execute({ appointmentId: ambiguous.id })).whatsappPhone,
    ).toBeNull();
  });

  it('emitir otro enlace revoca el anterior (solo vale el último)', async () => {
    const appointment = repo.addAppointment();
    await uc.execute({ appointmentId: appointment.id });
    await uc.execute({ appointmentId: appointment.id });

    expect(repo.confirmations).toHaveLength(2);
    expect(repo.confirmations[0].revokedAt).toBeInstanceOf(Date);
    expect(repo.confirmations[1].revokedAt).toBeNull();
  });

  it('automático conserva tanto el manual como el recordatorio anterior', async () => {
    const appointment = repo.addAppointment();
    await uc.execute({ appointmentId: appointment.id });
    await uc.execute({ appointmentId: appointment.id, automatic: true });
    await uc.execute({ appointmentId: appointment.id, automatic: true });
    expect(repo.confirmations).toHaveLength(3);
    expect(repo.confirmations.every((c) => c.revokedAt === null)).toBe(true);
  });

  it('también vale para una cita ya CONFIRMED (reenviar)', async () => {
    const appointment = repo.addAppointment({ status: 'CONFIRMED' });
    await expect(
      uc.execute({ appointmentId: appointment.id }),
    ).resolves.toBeDefined();
  });

  it('cita inexistente o de otra clínica -> 404', async () => {
    await expect(uc.execute({ appointmentId: 'nope' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it.each(['CANCELLED', 'COMPLETED', 'NO_SHOW'] as const)(
    'cita %s -> 409 sin crear enlace',
    async (status) => {
      const appointment = repo.addAppointment({ status });
      await expect(
        uc.execute({ appointmentId: appointment.id }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repo.confirmations).toHaveLength(0);
    },
  );

  it('cita que ya empezó -> 400 (el enlace nacería caducado)', async () => {
    const appointment = repo.addAppointment({
      start: new Date(Date.now() - 60_000),
    });
    await expect(
      uc.execute({ appointmentId: appointment.id }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.confirmations).toHaveLength(0);
  });

  // DX-361: recepción genera o reenvía el enlace → evento en la cita.
  describe('auditoría', () => {
    const audit = {
      tenantId: 't-1',
      locationId: null,
      actor: { userId: 'user-1', role: 'RECEPTION' as const },
      requestId: 'req-1',
      ip: '10.0.0.1',
      userAgent: 'jest',
    };

    it('generar deja CONFIRMATION_LINK_CREATED y reenviar CONFIRMATION_LINK_RESENT, con la cita, quién y origen STAFF', async () => {
      const appointment = repo.addAppointment({ locationId: 'loc-norte' });

      const first = await uc.execute({
        appointmentId: appointment.id,
        createdById: 'user-1',
        audit,
      });
      const second = await uc.execute({
        appointmentId: appointment.id,
        createdById: 'user-1',
        audit,
      });

      expect(repo.auditEvents).toEqual([
        expect.objectContaining({
          tenantId: 't-1',
          locationId: 'loc-norte',
          actor: { kind: 'user', userId: 'user-1', role: 'RECEPTION' },
          action: 'UPDATE',
          resourceType: 'APPOINTMENT',
          resourceId: appointment.id,
          metadata: { origin: 'STAFF', reason: 'CONFIRMATION_LINK_CREATED' },
        }),
        expect.objectContaining({
          resourceId: appointment.id,
          metadata: { origin: 'STAFF', reason: 'CONFIRMATION_LINK_RESENT' },
        }),
      ]);
      const text = JSON.stringify(repo.auditEvents);
      for (const token of [first.token, second.token]) {
        expect(text).not.toContain(token);
        expect(text).not.toContain(hashConfirmationToken(token));
      }
    });

    it('el recordatorio automático no pasa contexto: sin evento', async () => {
      const appointment = repo.addAppointment();
      await uc.execute({ appointmentId: appointment.id, automatic: true });
      expect(repo.auditEvents).toEqual([]);
    });

    it('si no se emite (404, 409, 400) no queda evento', async () => {
      await expect(
        uc.execute({ appointmentId: 'nope', audit }),
      ).rejects.toBeInstanceOf(NotFoundException);
      const cancelled = repo.addAppointment({ status: 'CANCELLED' });
      await expect(
        uc.execute({ appointmentId: cancelled.id, audit }),
      ).rejects.toBeInstanceOf(ConflictException);
      const started = repo.addAppointment({
        start: new Date(Date.now() - 60_000),
      });
      await expect(
        uc.execute({ appointmentId: started.id, audit }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.auditEvents).toEqual([]);
    });
  });

  // SEC-045: la restricción por sedes de DX-089, como GET /appointments/:id.
  describe('sedes permitidas', () => {
    const asMemberOf = <T>(locationIds: string[], fn: () => Promise<T>) =>
      ctx.run('t-1', undefined, fn, locationIds);

    it('cita de una sede no permitida -> 403 sin revocar el enlace vigente', async () => {
      const appointment = repo.addAppointment({ locationId: 'loc-sur' });
      await uc.execute({ appointmentId: appointment.id });
      const issue = jest.spyOn(repo, 'issue');

      const denied = asMemberOf(['loc-norte'], () =>
        uc.execute({ appointmentId: appointment.id }),
      );
      await expect(denied).rejects.toBeInstanceOf(ForbiddenException);
      await expect(denied).rejects.toThrow(LOCATION_NOT_ALLOWED_MESSAGE);
      expect(issue).not.toHaveBeenCalled();
      expect(repo.confirmations).toHaveLength(1);
      expect(repo.confirmations[0].revokedAt).toBeNull();
    });

    it('cita de una sede permitida, o sin restricción -> emite', async () => {
      const appointment = repo.addAppointment({ locationId: 'loc-norte' });
      await expect(
        asMemberOf(['loc-norte'], () =>
          uc.execute({ appointmentId: appointment.id }),
        ),
      ).resolves.toBeDefined();
      await expect(
        ctx.run('t-1', () => uc.execute({ appointmentId: appointment.id })),
      ).resolves.toBeDefined();
      expect(repo.confirmations).toHaveLength(2);
    });
  });
});
