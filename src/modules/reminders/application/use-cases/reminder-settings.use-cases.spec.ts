import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { FakeReminderRepository } from '../__fixtures__/fake-reminder.repository';
import {
  ListReminderSettingsUseCase,
  UpdateReminderSettingsUseCase,
} from './reminder-settings.use-cases';

const LOCATION = '0b5f8d8e-3a3c-4f7e-9d0a-111111111111';
const AUDIT: AuditRequestContext = {
  tenantId: '0b5f8d8e-3a3c-4f7e-9d0a-000000000001',
  locationId: null,
  actor: { userId: 'admin-1', role: ClinicRole.ADMIN },
  requestId: null,
  ip: null,
  userAgent: null,
};

describe('ajustes de recordatorio por sede (DX-026)', () => {
  let repo: FakeReminderRepository;

  beforeEach(() => {
    repo = new FakeReminderRepository();
    repo.locations.set(LOCATION, {
      locationId: LOCATION,
      locationName: 'Sede principal',
      enabled: false,
      leadHours: [],
      calendarAlarmHours: 24,
      updatedAt: null,
    });
  });

  it('lista las sedes; sin configurar, desactivadas', async () => {
    expect(await new ListReminderSettingsUseCase(repo).execute()).toEqual([
      expect.objectContaining({ locationId: LOCATION, enabled: false }),
    ]);
  });

  it('guarda activo con las antelaciones de mayor a menor', async () => {
    const saved = await new UpdateReminderSettingsUseCase(repo).execute(
      LOCATION,
      { enabled: true, leadHours: [2, 48] },
      AUDIT,
    );
    expect(saved).toMatchObject({ enabled: true, leadHours: [48, 2] });
  });

  it('400 en español si la lista no es válida o activa sin antelaciones', async () => {
    const uc = new UpdateReminderSettingsUseCase(repo);
    await expect(
      uc.execute(LOCATION, { enabled: true, leadHours: [] }, AUDIT),
    ).rejects.toThrow(
      new BadRequestException(
        'Para activar los recordatorios elige al menos una antelación.',
      ),
    );
    await expect(
      uc.execute(LOCATION, { enabled: true, leadHours: [200] }, AUDIT),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('DX-469: la alarma del calendario se guarda (0 la quita) y fuera de 0..168 da 400', async () => {
    const uc = new UpdateReminderSettingsUseCase(repo);
    const saved = await uc.execute(
      LOCATION,
      { enabled: false, leadHours: [], calendarAlarmHours: 0 },
      AUDIT,
    );
    expect(saved).toMatchObject({ calendarAlarmHours: 0 });
    for (const bad of [-1, 169, 2.5]) {
      await expect(
        uc.execute(
          LOCATION,
          { enabled: false, leadHours: [], calendarAlarmHours: bad },
          AUDIT,
        ),
      ).rejects.toThrow(
        new BadRequestException(
          'La alarma del calendario debe ser de 0 a 168 horas antes (0 la quita).',
        ),
      );
    }
  });

  it('404 en español si la sede no es de esta clínica (o no existe)', async () => {
    await expect(
      new UpdateReminderSettingsUseCase(repo).execute(
        '0b5f8d8e-3a3c-4f7e-9d0a-999999999999',
        { enabled: false, leadHours: [] },
        AUDIT,
      ),
    ).rejects.toThrow(new NotFoundException('Sede no encontrada'));
  });
});
