import {
  BadRequestException,
  ConflictException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { CreateConfirmationLinkUseCase } from './create-confirmation-link.use-case';
import { GetPublicConfirmationUseCase } from './get-public-confirmation.use-case';
import { RespondConfirmationUseCase } from './respond-confirmation.use-case';
import { InMemoryAppointmentConfirmationRepository } from './__fixtures__/in-memory-appointment-confirmation.repository';

const TENANT = '11111111-1111-4111-8111-111111111111';

describe('Enlace público de confirmación (Get + Respond)', () => {
  let repo: InMemoryAppointmentConfirmationRepository;
  let ctx: TenantContextService;
  let create: CreateConfirmationLinkUseCase;
  let get: GetPublicConfirmationUseCase;
  let respond: RespondConfirmationUseCase;

  const inTenant = <T>(fn: () => Promise<T>): Promise<T> => ctx.run(TENANT, fn);

  async function issue(overrides = {}) {
    const appointment = repo.addAppointment(overrides);
    const { token } = await create.execute({ appointmentId: appointment.id });
    return { appointment, token };
  }

  beforeEach(() => {
    repo = new InMemoryAppointmentConfirmationRepository();
    ctx = new TenantContextService();
    create = new CreateConfirmationLinkUseCase(repo, ctx);
    get = new GetPublicConfirmationUseCase(ctx, repo);
    respond = new RespondConfirmationUseCase(ctx, repo);
  });

  describe('GET', () => {
    it('PENDING con datos mínimos: nombre de pila, cuándo, profesional, sede y branding', async () => {
      const { appointment, token } = await issue();

      const view = await inTenant(() => get.execute(token));

      expect(view).toEqual({
        status: 'PENDING',
        clinic: {
          name: 'Clínica Sonrisa',
          primaryColor: '#0E7490',
          logoUrl: null,
        },
        appointment: {
          patientFirstName: 'Ana',
          start: appointment.start,
          end: appointment.end,
          providerName: 'Dra. Pérez',
          locationName: 'Sede Principal',
          locationAddress: 'Calle 1 # 2-3',
        },
        response: null,
        respondedAt: null,
        cancellationPolicy: null,
        isLate: false,
      });
    });

    it('no cambia nada (a prueba de previsualizadores de enlaces)', async () => {
      const { appointment, token } = await issue();
      const before = JSON.stringify([
        ...repo.confirmations,
        ...repo.appointments.values(),
      ]);

      await inTenant(() => get.execute(token));
      await inTenant(() => get.execute(token));

      expect(
        JSON.stringify([...repo.confirmations, ...repo.appointments.values()]),
      ).toBe(before);
      expect(repo.appointments.get(appointment.id)?.status).toBe('SCHEDULED');
    });

    it('sin tenant en contexto (host apex/desconocido) -> 404 sin tocar el repo', async () => {
      const { token } = await issue();
      const spy = jest.spyOn(repo, 'findByTokenHash');
      await expect(get.execute(token)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(spy).not.toHaveBeenCalled();
    });

    it('token mal formado o desconocido -> 404', async () => {
      await expect(
        inTenant(() => get.execute('guess-1')),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        inTenant(() => get.execute('A'.repeat(43))),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('EXPIRED sin datos de la cita cuando la cita se reagendó', async () => {
      const { appointment, token } = await issue();
      repo.appointments.get(appointment.id)!.start = new Date(
        appointment.start.getTime() + 3600_000,
      );

      const view = await inTenant(() => get.execute(token));

      expect(view.status).toBe('EXPIRED');
      expect(view.appointment).toBeNull();
      expect(view.clinic?.name).toBe('Clínica Sonrisa');
    });
  });

  describe('POST', () => {
    it('confirm -> la cita pasa a CONFIRMED y se registra respondedAt + respuesta', async () => {
      const { appointment, token } = await issue();

      const view = await inTenant(() => respond.execute(token, 'confirm'));

      expect(view.status).toBe('RESPONDED');
      expect(view.response).toBe('confirm');
      expect(view.respondedAt).toBeInstanceOf(Date);
      expect(repo.appointments.get(appointment.id)?.status).toBe('CONFIRMED');
      expect(repo.confirmations[0].response).toBe('CONFIRM');
      expect(repo.confirmations[0].respondedAt).toBeInstanceOf(Date);
    });

    it('cancel -> CANCELLED', async () => {
      const { appointment, token } = await issue();
      await inTenant(() => respond.execute(token, 'cancel'));
      expect(repo.appointments.get(appointment.id)?.status).toBe('CANCELLED');
    });

    it('call_me -> sigue SCHEDULED pero marca "pide llamada"', async () => {
      const { appointment, token } = await issue();
      const view = await inTenant(() => respond.execute(token, 'call_me'));
      const stored = repo.appointments.get(appointment.id)!;
      expect(stored.status).toBe('SCHEDULED');
      expect(stored.callbackRequestedAt).toBeInstanceOf(Date);
      expect(view.response).toBe('call_me');
    });

    it('reutilizado: un segundo POST -> 409 y la primera respuesta queda', async () => {
      const { appointment, token } = await issue();
      await inTenant(() => respond.execute(token, 'confirm'));

      await expect(
        inTenant(() => respond.execute(token, 'cancel')),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repo.appointments.get(appointment.id)?.status).toBe('CONFIRMED');

      // Y el GET muestra la respuesta ya dada.
      const view = await inTenant(() => get.execute(token));
      expect(view.status).toBe('RESPONDED');
      expect(view.response).toBe('confirm');
    });

    it('carrera perdida en la escritura (ALREADY_USED) -> 409', async () => {
      const { token } = await issue();
      jest.spyOn(repo, 'respond').mockResolvedValueOnce('ALREADY_USED');
      await expect(
        inTenant(() => respond.execute(token, 'confirm')),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('expirado (llegó la hora de la cita) -> 410 sin tocar la cita', async () => {
      const { appointment, token } = await issue();
      repo.confirmations[0].expiresAt = new Date(Date.now() - 1);

      await expect(
        inTenant(() => respond.execute(token, 'confirm')),
      ).rejects.toBeInstanceOf(GoneException);
      expect(repo.appointments.get(appointment.id)?.status).toBe('SCHEDULED');
    });

    it('revocado por un enlace más nuevo -> 410', async () => {
      const { appointment, token } = await issue();
      await create.execute({ appointmentId: appointment.id });
      await expect(
        inTenant(() => respond.execute(token, 'confirm')),
      ).rejects.toBeInstanceOf(GoneException);
    });

    it('la cita cambió de estado entre la lectura y la escritura (STALE) -> 410', async () => {
      const { token } = await issue();
      jest.spyOn(repo, 'respond').mockResolvedValueOnce('STALE');
      await expect(
        inTenant(() => respond.execute(token, 'confirm')),
      ).rejects.toBeInstanceOf(GoneException);
    });

    it('sin tenant o token desconocido -> 404', async () => {
      const { token } = await issue();
      await expect(respond.execute(token, 'confirm')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(
        inTenant(() => respond.execute('B'.repeat(43), 'confirm')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('política de cancelación en el enlace (DX-291)', () => {
    const POLICY = {
      id: 'pol-v2',
      version: 2,
      noticeHours: 24,
      patientText: 'Avísanos con 24 h o se cobra la cita.',
      suggestedFee: 50000,
      currency: 'COP',
    };
    const fiveHours = () => ({ start: new Date(Date.now() + 5 * 3600_000) });

    beforeEach(() => {
      repo.policy = POLICY;
    });

    it('la vista PENDING lleva el texto, las horas y el importe, e isLate a 5 h de una política de 24 h', async () => {
      const { token } = await issue(fiveHours());
      const view = await inTenant(() => get.execute(token));
      expect(view.cancellationPolicy).toEqual({
        policyVersionId: 'pol-v2',
        noticeHours: 24,
        text: 'Avísanos con 24 h o se cobra la cita.',
        suggestedFee: 50000,
        currency: 'COP',
      });
      expect(view.isLate).toBe(true);
    });

    it('con tiempo de sobra no es tardía', async () => {
      const { token } = await issue({
        start: new Date(Date.now() + 48 * 3600_000),
      });
      const view = await inTenant(() => get.execute(token));
      expect(view.isLate).toBe(false);
    });

    it('cancelar tarde sin acknowledgePolicy: 400 en español y la cita sigue igual', async () => {
      const { appointment, token } = await issue(fiveHours());
      await expect(
        inTenant(() => respond.execute(token, 'cancel')),
      ).rejects.toThrow(
        new BadRequestException(
          'Cancelación con menos de 24 h de aviso: para cancelar, acepta la política de cancelación de la clínica.',
        ),
      );
      const row = repo.appointments.get(appointment.id)!;
      expect(row.status).toBe('SCHEDULED');
      expect(row.policyVersionId).toBeNull();
      expect(repo.confirmations[0].respondedAt).toBeNull();
    });

    it('con acknowledgePolicy cancela, marca tardía y guarda la versión comunicada', async () => {
      const { appointment, token } = await issue(fiveHours());
      const view = await inTenant(() =>
        respond.execute(token, 'cancel', {
          acknowledgePolicy: true,
          policyVersionId: 'pol-v2',
        }),
      );
      expect(view.status).toBe('RESPONDED');
      const row = repo.appointments.get(appointment.id)!;
      expect(row.status).toBe('CANCELLED');
      expect(row.noticeLate).toBe(true);
      expect(row.policyVersionId).toBe('pol-v2');
    });

    it('«Quiero que me llamen» sigue disponible sin aceptar la política', async () => {
      const { appointment, token } = await issue(fiveHours());
      await inTenant(() => respond.execute(token, 'call_me'));
      expect(
        repo.appointments.get(appointment.id)!.callbackRequestedAt,
      ).not.toBeNull();
    });

    it('si la página mostró otra versión: 409 y no se registra nada', async () => {
      const { token } = await issue(fiveHours());
      await expect(
        inTenant(() =>
          respond.execute(token, 'confirm', { policyVersionId: 'pol-v1' }),
        ),
      ).rejects.toThrow(ConflictException);
      expect(repo.confirmations[0].respondedAt).toBeNull();
    });

    it('la vista no expone nada clínico ni de la cita más allá de lo de siempre', async () => {
      const { token } = await issue(fiveHours());
      const view = await inTenant(() => get.execute(token));
      expect(Object.keys(view.appointment ?? {}).sort()).toEqual([
        'end',
        'locationAddress',
        'locationName',
        'patientFirstName',
        'providerName',
        'start',
      ]);
    });
  });
});
