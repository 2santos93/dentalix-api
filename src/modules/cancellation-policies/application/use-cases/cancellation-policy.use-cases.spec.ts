import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  CANCELLATION_POLICY_MESSAGES,
  type CancellationPolicyInput,
  type CancellationPolicyVersion,
} from '../../domain/cancellation-policy';
import type { CancellationPolicyRepository } from '../../domain/ports/cancellation-policy-repository.port';
import {
  CreateCancellationPolicyVersionUseCase,
  GetCancellationPolicyUseCase,
  PreviewReminderEmailUseCase,
} from './cancellation-policy.use-cases';
import { renderEmail } from '../../../notifications/email/application/templates/templates';
import type { EmailOutbox } from '../../../notifications/email/application/email-outbox.service';
import type { AppointmentReminderEmailVars } from '../../../notifications/email/domain/email-message';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';

const LOCATION = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

/** Doble en memoria: append-only, una lista de versiones por sede. */
class FakeRepo implements CancellationPolicyRepository {
  readonly versions = new Map<string, CancellationPolicyVersion[]>([
    [LOCATION, []],
  ]);

  listVersions(locationId: string) {
    const list = this.versions.get(locationId);
    return Promise.resolve(list ? [...list].reverse() : null);
  }

  createVersion(
    locationId: string,
    input: CancellationPolicyInput,
    createdById: string,
  ) {
    const list = this.versions.get(locationId);
    if (!list) return Promise.resolve(null);
    const version: CancellationPolicyVersion = {
      id: `v${list.length + 1}`,
      locationId,
      version: list.length + 1,
      noticeHours: input.noticeHours,
      suggestedFee: input.suggestedFee,
      currency: input.currency,
      patientText: input.patientText,
      receptionCanCharge: input.receptionCanCharge ?? false,
      createdAt: new Date('2026-10-23T12:00:00.000Z'),
      createdById,
      createdByName: 'Admin',
    };
    list.push(version);
    return Promise.resolve(version);
  }

  currencyExists(code: string) {
    return Promise.resolve(['COP', 'EUR', 'USD'].includes(code));
  }

  /** Formato y reloj de la sede de la vista previa (ajustes explícitos). */
  previewRegional: { locale: string | null; hourCycle: string | null } = {
    locale: 'es-CO',
    hourCycle: 'h23',
  };

  findPreviewLocation(locationId: string) {
    return Promise.resolve(
      this.versions.has(locationId)
        ? {
            id: locationId,
            name: 'Sede Principal',
            address: 'Calle 1 # 2-3',
            timeZone: 'America/Bogota',
            ...this.previewRegional,
          }
        : null,
    );
  }
}

describe('Política de cancelación por sede (DX-279)', () => {
  let repo: FakeRepo;
  let get: GetCancellationPolicyUseCase;
  let create: CreateCancellationPolicyVersionUseCase;

  beforeEach(() => {
    repo = new FakeRepo();
    get = new GetCancellationPolicyUseCase(repo);
    create = new CreateCancellationPolicyVersionUseCase(repo);
  });

  it('sin configurar: sin vigente y sin historial', async () => {
    await expect(get.execute(LOCATION)).resolves.toEqual({
      locationId: LOCATION,
      current: null,
      versions: [],
    });
  });

  it('cada guardado crea la versión siguiente y no toca la anterior', async () => {
    const v1 = await create.execute(
      LOCATION,
      {
        noticeHours: 24,
        suggestedFee: null,
        currency: null,
        patientText: ' Avísanos. ',
      },
      USER,
    );
    const v2 = await create.execute(
      LOCATION,
      {
        noticeHours: 48,
        suggestedFee: 50000,
        currency: 'cop',
        patientText: 'Nueva',
      },
      USER,
    );
    expect(v1).toMatchObject({
      version: 1,
      noticeHours: 24,
      patientText: 'Avísanos.',
    });
    expect(v2).toMatchObject({
      version: 2,
      suggestedFee: 50000,
      currency: 'COP',
    });
    const view = await get.execute(LOCATION);
    expect(view.current?.id).toBe(v2.id);
    expect(view.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(view.versions[1]).toEqual(v1);
  });

  it('400 en español con datos inválidos, sin escribir', async () => {
    await expect(
      create.execute(
        LOCATION,
        {
          noticeHours: 169,
          suggestedFee: null,
          currency: null,
          patientText: '',
        },
        USER,
      ),
    ).rejects.toEqual(
      new BadRequestException(CANCELLATION_POLICY_MESSAGES.noticeHours),
    );
    await expect(
      create.execute(
        LOCATION,
        { noticeHours: 24, suggestedFee: -5, currency: 'COP', patientText: '' },
        USER,
      ),
    ).rejects.toEqual(
      new BadRequestException(CANCELLATION_POLICY_MESSAGES.fee),
    );
    await expect(
      create.execute(
        LOCATION,
        { noticeHours: 24, suggestedFee: 5, currency: 'XXX', patientText: '' },
        USER,
      ),
    ).rejects.toEqual(
      new BadRequestException(CANCELLATION_POLICY_MESSAGES.currency),
    );
    expect(repo.versions.get(LOCATION)).toHaveLength(0);
  });

  it('una sede que no es de la clínica: 404', async () => {
    const other = '33333333-3333-4333-8333-333333333333';
    await expect(get.execute(other)).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      create.execute(
        other,
        {
          noticeHours: 24,
          suggestedFee: null,
          currency: null,
          patientText: '',
        },
        USER,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('vista previa del recordatorio (DX-291)', () => {
    const TENANT = '33333333-3333-4333-8333-333333333333';
    const ctx = new TenantContextService();
    const email = {
      preview: jest.fn(
        (
          _tenant: string,
          template: 'appointment-reminder',
          vars: AppointmentReminderEmailVars,
        ) =>
          Promise.resolve(
            renderEmail(template, vars, {
              clinicName: 'Clínica Sonrisa',
              logoUrl: null,
              primaryColor: '#0E7490',
            }),
          ),
      ),
    };
    const preview = () =>
      new PreviewReminderEmailUseCase(
        repo,
        email as unknown as EmailOutbox,
        ctx,
      );

    it('lleva la política vigente ({politica_cancelacion}) y datos de ejemplo', async () => {
      await create.execute(
        LOCATION,
        {
          noticeHours: 12,
          suggestedFee: null,
          currency: null,
          patientText: 'Primera versión.',
        },
        USER,
      );
      await create.execute(
        LOCATION,
        {
          noticeHours: 24,
          suggestedFee: 50000,
          currency: 'COP',
          patientText: 'Avísanos con un día.',
        },
        USER,
      );
      const rendered = await ctx.run(TENANT, () => preview().execute(LOCATION));
      expect(rendered.subject).toBe(
        'Recordatorio de tu cita en Clínica Sonrisa',
      );
      expect(rendered.text).toContain('Hola, Ana');
      expect(rendered.text).toContain(
        'avísanos con al menos 24 h de antelación. Avísanos con un día.',
      );
      expect(rendered.text).toContain('50.000');
      expect(rendered.text).not.toContain('Primera versión.');
    });

    it('DX-350: hora y cargo con el formato y el reloj de la sede', async () => {
      repo.previewRegional = { locale: 'en-US', hourCycle: 'h12' };
      await create.execute(
        LOCATION,
        {
          noticeHours: 24,
          suggestedFee: 25,
          currency: 'USD',
          patientText: 'Avísanos con un día.',
        },
        USER,
      );
      // Mañana a las 15:05 en la zona de la sede (UTC-5 en octubre).
      const now = new Date('2026-10-20T20:05:00.000Z');
      const rendered = await ctx.run(TENANT, () =>
        preview().execute(LOCATION, now),
      );
      expect(rendered.text).toContain(
        'miércoles 21 de octubre de 2026 a las 3:05 p. m.',
      );
      expect(rendered.text).toContain('$25.00');
    });

    it('DX-350: una sede sin reloj da 409 LOCATION_LOCALE_REQUIRED', async () => {
      repo.previewRegional = { locale: 'es-CO', hourCycle: null };
      const error = await ctx
        .run(TENANT, () => preview().execute(LOCATION))
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'LOCATION_LOCALE_REQUIRED',
        locationId: LOCATION,
      });
    });

    it('sin política: el email sale sin el bloque; sede ajena: 404', async () => {
      const rendered = await ctx.run(TENANT, () => preview().execute(LOCATION));
      expect(rendered.text).not.toContain('Política de cancelación');
      await expect(
        ctx.run(TENANT, () => preview().execute('otra-sede')),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
