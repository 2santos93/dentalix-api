import { ConfigService } from '@nestjs/config';
import { Logger, NotFoundException } from '@nestjs/common';
import { hashConfirmationToken } from '../../../appointment-confirmations/application/confirmation-token';
import type { AuditEventDraft } from '../../../audit/domain/audit-event';
import { FakeReminderOptOutRepository } from '../__fixtures__/fake-reminder-opt-out.repository';
import {
  ConfirmPublicOptOutUseCase,
  GetPublicOptOutUseCase,
  OptOutByMessageUseCase,
} from './reminder-opt-out.use-cases';

const TENANT = '9f3a1b2c-0000-4000-8000-0000000000aa';
const ANA = '5a1c7d2e-0000-4000-8000-000000000101';
const LUIS = '5a1c7d2e-0000-4000-8000-000000000102';
const NOW = new Date('2026-10-20T12:00:00.000Z');
const TOKEN = 'A'.repeat(43);
const META = { ip: '10.0.0.9', userAgent: 'Mozilla', requestId: 'req-1' };

/** Contexto de tenant mínimo: el de la petición pública o el fijado por `run`. */
function fakeTenantContext(initial: string | undefined) {
  let current = initial;
  return {
    getTenantId: () => current,
    run<T>(tenantId: string, fn: () => T): T {
      const before = current;
      current = tenantId;
      try {
        return fn();
      } finally {
        current = before;
      }
    },
  };
}

describe('Baja de recordatorios por enlace (DX-128)', () => {
  let repo: FakeReminderOptOutRepository;
  let audit: { record: jest.Mock };
  const clock = { now: () => NOW };

  beforeEach(async () => {
    repo = new FakeReminderOptOutRepository();
    repo.addPatient(ANA);
    await repo.issueLink(ANA, hashConfirmationToken(TOKEN));
    audit = { record: jest.fn().mockResolvedValue(undefined) };
  });

  // null = petición sin clínica en el host.
  const get = (tenant: string | null = TENANT) =>
    new GetPublicOptOutUseCase(
      fakeTenantContext(tenant ?? undefined) as never,
      repo,
      clock,
    );
  const confirm = (tenant: string | null = TENANT) =>
    new ConfirmPublicOptOutUseCase(
      fakeTenantContext(tenant ?? undefined) as never,
      repo,
      audit as never,
      clock,
    );

  it('ver el enlace no cambia nada: solo el nombre de pila y la clínica', async () => {
    await expect(get().execute(TOKEN)).resolves.toEqual({
      status: 'ACTIVE',
      patientFirstName: 'Ana',
      optedOutAt: null,
      clinic: {
        name: 'Sonrisas del Norte',
        primaryColor: '#0E7490',
        logoUrl: null,
      },
    });
    expect(repo.patients.get(ANA)?.optedOutAt).toBeNull();
  });

  it('confirmar registra la baja con origen LINK y la audita sin actor', async () => {
    const view = await confirm().execute(TOKEN, META);
    expect(view).toMatchObject({ status: 'OPTED_OUT', optedOutAt: NOW });
    expect(repo.patients.get(ANA)).toMatchObject({
      optedOutAt: NOW,
      optOutSource: 'LINK',
    });
    expect(audit.record).toHaveBeenCalledTimes(1);
    const [draft] = audit.record.mock.calls[0] as [AuditEventDraft];
    expect(draft).toEqual({
      tenantId: TENANT,
      locationId: null,
      actor: { kind: 'patient' },
      action: 'UPDATE',
      resourceType: 'PATIENT',
      resourceId: ANA,
      patient: { kind: 'patient', id: ANA },
      requestId: 'req-1',
      ip: '10.0.0.9',
      userAgent: 'Mozilla',
      metadata: {
        reason: 'REMINDER_OPT_OUT',
        origin: 'LINK',
        changedFields: ['reminderOptOutAt'],
      },
    });
  });

  it('un enlace usado devuelve el mismo404 en GET/POST sin otra auditoría', async () => {
    await confirm().execute(TOKEN, META);
    await expect(get().execute(TOKEN)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(confirm().execute(TOKEN, META)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('caduca exactamente a los60d y no cambia el paciente', async () => {
    Object.assign(repo.links.get(hashConfirmationToken(TOKEN))!, {
      expiresAt: NOW,
    });
    await expect(get().execute(TOKEN)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(confirm().execute(TOKEN, META)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repo.patients.get(ANA)?.optedOutAt).toBeNull();
  });

  it('un enlace invalidado después de leerlo rechaza consumo sin inventar éxito', async () => {
    jest.spyOn(repo, 'optOut').mockResolvedValue(null);
    await expect(confirm().execute(TOKEN, META)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repo.patients.get(ANA)?.optedOutAt).toBeNull();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('un paciente ya dado de baja (por otra vía) ve la baja con su fecha', async () => {
    const before = new Date('2026-10-01T09:00:00.000Z');
    repo.patients.get(ANA)!.optedOutAt = before;
    repo.patients.get(ANA)!.optOutSource = 'STAFF';
    await expect(get().execute(TOKEN)).resolves.toMatchObject({
      status: 'OPTED_OUT',
      optedOutAt: before,
    });
    await expect(confirm().execute(TOKEN, META)).resolves.toMatchObject({
      status: 'OPTED_OUT',
      optedOutAt: before,
    });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each([
    ['token mal formado', 'corto', TENANT],
    ['token desconocido', 'B'.repeat(43), TENANT],
    ['sin clínica en el host', TOKEN, null],
  ])('404 con %s, sin tocar nada', async (_, token, tenant) => {
    await expect(get(tenant).execute(token)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(confirm(tenant).execute(token, META)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repo.patients.get(ANA)?.optedOutAt).toBeNull();
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('Baja de recordatorios por mensaje entrante (DX-128, para DX-126)', () => {
  let repo: FakeReminderOptOutRepository;
  let audit: { record: jest.Mock };
  let useCase: OptOutByMessageUseCase;

  beforeEach(() => {
    repo = new FakeReminderOptOutRepository();
    repo.addPatient(ANA, { phone: '310 123 4567' });
    // Mismo móvil escrito de otra forma: la madre con dos hijos, p. ej.
    repo.addPatient(LUIS, { phone: '+57 (310) 123-4567' });
    // Mismos 8 últimos dígitos, otro país: no es el mismo móvil.
    repo.addPatient('5a1c7d2e-0000-4000-8000-000000000103', {
      phone: '+34 6 1012 34567'.replace(/\s/g, ''),
    });
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    useCase = new OptOutByMessageUseCase(
      fakeTenantContext(undefined) as never,
      repo,
      audit as never,
      { now: () => NOW },
    );
  });

  it('«BAJA» del móvil registra la baja de cada paciente de ese móvil, con origen MESSAGE', async () => {
    const result = await useCase.execute({
      tenantId: TENANT,
      fromPhone: '573101234567',
      text: ' Baja ',
    });
    expect(result).toEqual({ isOptOut: true, optedOut: [ANA, LUIS] });
    expect(repo.patients.get(ANA)).toMatchObject({
      optedOutAt: NOW,
      optOutSource: 'MESSAGE',
    });
    expect(repo.patients.get(LUIS)?.optOutSource).toBe('MESSAGE');
    expect(audit.record).toHaveBeenCalledTimes(2);
    const [draft] = audit.record.mock.calls[0] as [AuditEventDraft];
    expect(draft).toMatchObject({
      tenantId: TENANT,
      actor: { kind: 'patient' },
      patient: { kind: 'patient', id: ANA },
      metadata: {
        reason: 'REMINDER_OPT_OUT',
        origin: 'MESSAGE',
        changedFields: ['reminderOptOutAt'],
      },
    });
  });

  it('seis coincidencias no dan de baja a ninguno y dejan aviso sin PII', async () => {
    for (let i = 0; i < 4; i++)
      repo.addPatient(`shared-${i}`, { phone: '+573101234567' });
    const warning = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      expect(
        await useCase.execute({
          tenantId: TENANT,
          fromPhone: '573101234567',
          text: 'BAJA',
        }),
      ).toEqual({ isOptOut: true, optedOut: [] });
      expect(
        [...repo.patients.values()].every((p) => p.optedOutAt === null),
      ).toBe(true);
      expect(audit.record).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith({
        event: 'reminders.opt_out_match_limit',
        tenantId: TENANT,
        matches: 6,
        limit: 5,
      });
    } finally {
      warning.mockRestore();
    }
  });

  it('el máximo es configurable y cuenta todas las coincidencias antes de escribir', async () => {
    const limited = new OptOutByMessageUseCase(
      fakeTenantContext(undefined) as never,
      repo,
      audit as never,
      { now: () => NOW },
      new ConfigService({ REMINDER_OPT_OUT_MESSAGE_MAX_MATCHES: '1' }),
    );
    const warning = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      expect(
        await limited.execute({
          tenantId: TENANT,
          fromPhone: '573101234567',
          text: 'BAJA',
        }),
      ).toEqual({ isOptOut: true, optedOut: [] });
      expect(repo.patients.get(ANA)?.optedOutAt).toBeNull();
      expect(repo.patients.get(LUIS)?.optedOutAt).toBeNull();
    } finally {
      warning.mockRestore();
    }
  });

  it('acepta el número con + y separadores', async () => {
    const result = await useCase.execute({
      tenantId: TENANT,
      fromPhone: '+57 310 123 4567',
      text: 'STOP',
    });
    expect(result.optedOut).toEqual([ANA, LUIS]);
  });

  it('un mensaje que no es de baja no toca nada', async () => {
    const result = await useCase.execute({
      tenantId: TENANT,
      fromPhone: '573101234567',
      text: 'No puedo ir mañana',
    });
    expect(result).toEqual({ isOptOut: false, optedOut: [] });
    expect(repo.patients.get(ANA)?.optedOutAt).toBeNull();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('repetir «BAJA» no vuelve a registrar ni a auditar', async () => {
    await useCase.execute({
      tenantId: TENANT,
      fromPhone: '573101234567',
      text: 'BAJA',
    });
    const again = await useCase.execute({
      tenantId: TENANT,
      fromPhone: '573101234567',
      text: 'no más',
    });
    expect(again).toEqual({ isOptOut: true, optedOut: [] });
    expect(audit.record).toHaveBeenCalledTimes(2);
  });

  it('un móvil desconocido o sin dígitos suficientes no hace nada', async () => {
    for (const fromPhone of ['573009999999', '123', '']) {
      await expect(
        useCase.execute({ tenantId: TENANT, fromPhone, text: 'BAJA' }),
      ).resolves.toEqual({ isOptOut: true, optedOut: [] });
    }
    expect(audit.record).not.toHaveBeenCalled();
  });
});
