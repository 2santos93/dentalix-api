import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  CANCELLATION_POLICY_MESSAGES,
  type CancellationPolicyInput,
  type CancellationPolicyVersion,
} from '../../domain/cancellation-policy';
import type { CancellationPolicyRepository } from '../../domain/ports/cancellation-policy-repository.port';
import {
  CreateCancellationPolicyVersionUseCase,
  GetCancellationPolicyUseCase,
} from './cancellation-policy.use-cases';

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
});
