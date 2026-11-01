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
