import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import type {
  LockedPostOpCheck,
  PostOpCheckRepository,
  PostOpCheckRow,
} from '../domain/post-op-check-repository.port';
import { PostOpChecksUseCases, toListItem } from './post-op-checks.use-cases';

const NOW = new Date('2026-11-17T15:00:00.000Z');
const AUDIT: AuditRequestContext = {
  tenantId: 't-1',
  locationId: null,
  actor: { userId: 'u-1', role: ClinicRole.DENTIST },
  requestId: null,
  ip: null,
  userAgent: null,
};

const ROW: PostOpCheckRow = {
  id: 'c-1',
  status: 'PENDING',
  dueOn: '2026-11-15',
  today: '2026-11-17',
  locationId: 'l-1',
  patientId: 'p-1',
  patientName: 'Luisa Fernández',
  patientPhone: '0414-123-4567',
  phoneRegion: 'VE',
  professionalId: 'u-2',
  professionalName: 'Dra. Carmen Rojas',
  appointmentId: 'a-1',
  appointmentStart: new Date('2026-11-13T14:00:00.000Z'),
  procedureName: 'Extracción simple',
  attempts: [
    {
      id: 't-1',
      outcome: 'NO_ANSWER',
      note: 'Buzón de voz',
      byId: 'u-3',
      byName: 'Ana',
      at: NOW,
    },
  ],
  instructions: [
    { deliveryId: 'd-1', title: 'Tras una extracción', deliveredAt: NOW },
  ],
};

describe('toListItem: recorte por rol (DX-566 · D5)', () => {
  it('un rol clínico ve procedimiento, intentos con nota e indicaciones', () => {
    const item = toListItem(ROW, true);
    expect(item).toMatchObject({
      clinicalHidden: false,
      procedureName: 'Extracción simple',
      attemptsCount: 1,
      overdueDays: 2,
      patientPhone: '0414-123-4567',
      whatsAppDigits: '584141234567',
    });
    expect(item.attempts).toHaveLength(1);
    expect(item.instructions).toHaveLength(1);
  });

  it('recepción ve paciente, teléfono, WhatsApp, cita y nº de intentos; nada clínico', () => {
    const item = toListItem(ROW, false);
    expect(item).toMatchObject({
      clinicalHidden: true,
      procedureName: null,
      attempts: null,
      instructions: null,
      attemptsCount: 1,
      patientName: 'Luisa Fernández',
      patientPhone: '0414-123-4567',
      whatsAppDigits: '584141234567',
      appointmentId: 'a-1',
    });
    expect(JSON.stringify(item)).not.toContain('Buzón de voz');
    expect(JSON.stringify(item)).not.toContain('Extracción');
  });
});

describe('PostOpChecksUseCases.recordAttempt (DX-566 · D6)', () => {
  function setUp(locked: LockedPostOpCheck | null) {
    const recordAttempt = jest.fn(
      (
        _input: unknown,
        decide: (l: LockedPostOpCheck) => unknown,
      ): Promise<unknown> => {
        if (!locked) return Promise.resolve(null);
        const decision = decide(locked);
        return Promise.resolve({ decision });
      },
    );
    const repo = {
      list: jest.fn(),
      count: jest.fn(),
      recordAttempt,
    } as unknown as PostOpCheckRepository;
    const tenantContext = new TenantContextService();
    const uc = new PostOpChecksUseCases(repo, tenantContext, () => NOW);
    const run = (fn: () => Promise<unknown>) =>
      tenantContext.run('t-1', 'l-1', fn, ['l-1']);
    return { uc, recordAttempt, run };
  }
  const pending: LockedPostOpCheck = {
    id: 'c-1',
    patientId: 'p-1',
    locationId: 'l-1',
    status: 'PENDING',
    noAnswers: 2,
  };
  const dentist = { userId: 'u-1', role: ClinicRole.DENTIST };

  it('recepción: 403 sin tocar nada', async () => {
    const { uc, recordAttempt } = setUp(pending);
    await expect(
      uc.recordAttempt(
        'c-1',
        { outcome: 'FINE' },
        { userId: 'u-9', role: ClinicRole.RECEPTION },
        AUDIT,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(recordAttempt).not.toHaveBeenCalled();
  });

  it('nota de más de 1000: 400', async () => {
    const { uc } = setUp(pending);
    await expect(
      uc.recordAttempt(
        'c-1',
        { outcome: 'FINE', note: 'x'.repeat(1001) },
        dentist,
        AUDIT,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('no existe: 404', async () => {
    const { uc, run } = setUp(null);
    await expect(
      run(() => uc.recordAttempt('c-1', { outcome: 'FINE' }, dentist, AUDIT)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('cerrado: 409', async () => {
    const { uc, run } = setUp({ ...pending, status: 'DONE' });
    await expect(
      run(() => uc.recordAttempt('c-1', { outcome: 'FINE' }, dentist, AUDIT)),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('de una sede no permitida: 403', async () => {
    const { uc, run } = setUp({ ...pending, locationId: 'l-2' });
    await expect(
      run(() => uc.recordAttempt('c-1', { outcome: 'FINE' }, dentist, AUDIT)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('el tercer «No contesta» decide cerrar como UNREACHABLE; la nota llega recortada', async () => {
    const { uc, run, recordAttempt } = setUp(pending);
    const result = await run(() =>
      uc.recordAttempt(
        'c-1',
        { outcome: 'NO_ANSWER', note: '  buzón  ' },
        dentist,
        AUDIT,
      ),
    );
    expect(recordAttempt.mock.calls[0][0]).toEqual({
      checkId: 'c-1',
      outcome: 'NO_ANSWER',
      note: 'buzón',
      actorId: 'u-1',
    });
    expect(result).toEqual({
      decision: { close: true, status: 'UNREACHABLE', outcome: null },
    });
  });
});
