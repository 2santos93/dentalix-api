import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { CreateConfirmationLinkUseCase } from './create-confirmation-link.use-case';
import { InMemoryAppointmentConfirmationRepository } from './__fixtures__/in-memory-appointment-confirmation.repository';
import { hashConfirmationToken } from '../confirmation-token';

describe('CreateConfirmationLinkUseCase', () => {
  let repo: InMemoryAppointmentConfirmationRepository;
  let uc: CreateConfirmationLinkUseCase;

  beforeEach(() => {
    repo = new InMemoryAppointmentConfirmationRepository();
    uc = new CreateConfirmationLinkUseCase(repo);
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

  it('whatsappPhone es null si el paciente no tiene un teléfono utilizable', async () => {
    const appointment = repo.addAppointment({ patientPhone: null });
    const result = await uc.execute({ appointmentId: appointment.id });
    expect(result.whatsappPhone).toBeNull();
  });

  it('emitir otro enlace revoca el anterior (solo vale el último)', async () => {
    const appointment = repo.addAppointment();
    await uc.execute({ appointmentId: appointment.id });
    await uc.execute({ appointmentId: appointment.id });

    expect(repo.confirmations).toHaveLength(2);
    expect(repo.confirmations[0].revokedAt).toBeInstanceOf(Date);
    expect(repo.confirmations[1].revokedAt).toBeNull();
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
});
