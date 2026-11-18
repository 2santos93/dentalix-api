import {
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { patientsInClinic } from '../../../patients/application/__fixtures__/patients-in-clinic.fake';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { CreateClinicalEntryUseCase } from './create-clinical-entry.use-case';
import {
  InMemoryClinicalEntryRepository,
  InMemoryClinicalEntrySettingsRepository,
} from '../__fixtures__/in-memory-clinical-entries';
import { InMemoryClinicalNoteTemplateRepository } from '../../../clinical-note-templates/application/__fixtures__/in-memory-clinical-note-templates';
import type { IdempotencySignals } from '../../../../shared/validation/idempotent-create';

const KEY = '7d3c2b1a-0f9e-4d8c-a7b6-5e4d3c2b1a09';

function useCase(repo: InMemoryClinicalEntryRepository) {
  return new CreateClinicalEntryUseCase(
    repo,
    patientsInClinic('p1', 'p2'),
    new InMemoryClinicalNoteTemplateRepository(),
    new TenantContextService(),
    new InMemoryClinicalEntrySettingsRepository(),
  );
}

describe('CreateClinicalEntryUseCase — Idempotency-Key (DX-574)', () => {
  it('repetir la misma evolución con la misma clave devuelve la original sin otra fila', async () => {
    const repo = new InMemoryClinicalEntryRepository();
    const uc = useCase(repo);
    const input = { notes: 'Obturación 36 con resina, sin complicaciones' };

    const first = await uc.execute(
      'p1',
      input,
      'user-1',
      undefined,
      undefined,
      {
        idempotencyKey: KEY,
      },
    );
    const signals: IdempotencySignals = {};
    const again = await uc.execute(
      'p1',
      { ...input },
      'user-1',
      undefined,
      undefined,
      { idempotencyKey: KEY.toUpperCase(), signals },
    );

    expect(again.id).toBe(first.id);
    expect(again.recallUpdates).toEqual([]);
    expect(signals.replayed).toBe(true);
    expect(repo.rows).toHaveLength(1);
  });

  it('la misma clave con otro texto es un 422 IDEMPOTENCY_KEY_REUSED', async () => {
    const repo = new InMemoryClinicalEntryRepository();
    const uc = useCase(repo);
    await uc.execute(
      'p1',
      { notes: 'Texto A' },
      'user-1',
      undefined,
      undefined,
      {
        idempotencyKey: KEY,
      },
    );

    const reused = uc.execute(
      'p1',
      { notes: 'Texto B' },
      'user-1',
      undefined,
      undefined,
      { idempotencyKey: KEY },
    );

    await expect(reused).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(reused).rejects.toMatchObject({
      response: { code: 'IDEMPOTENCY_KEY_REUSED' },
    });
    expect(repo.rows).toHaveLength(1);
  });

  it('la misma clave para otro paciente también es un 422', async () => {
    const repo = new InMemoryClinicalEntryRepository();
    const uc = useCase(repo);
    await uc.execute('p1', { notes: 'Igual' }, 'user-1', undefined, undefined, {
      idempotencyKey: KEY,
    });

    await expect(
      uc.execute('p2', { notes: 'Igual' }, 'user-1', undefined, undefined, {
        idempotencyKey: KEY,
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('una clave que no es UUID es un 400 y no guarda nada', async () => {
    const repo = new InMemoryClinicalEntryRepository();
    const uc = useCase(repo);

    await expect(
      uc.execute('p1', { notes: 'Nota' }, 'user-1', undefined, undefined, {
        idempotencyKey: 'no-es-uuid',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.rows).toHaveLength(0);
  });

  it('sin clave, dos envíos crean dos evoluciones (comportamiento de siempre)', async () => {
    const repo = new InMemoryClinicalEntryRepository();
    const uc = useCase(repo);

    await uc.execute('p1', { notes: 'Nota' }, 'user-1');
    await uc.execute('p1', { notes: 'Nota' }, 'user-1');

    expect(repo.rows).toHaveLength(2);
  });

  it('si otra petición con la misma clave gana la carrera, devuelve la suya', async () => {
    const repo = new InMemoryClinicalEntryRepository();
    const uc = useCase(repo);
    const input = { notes: 'Carrera' };
    // La primera lectura (antes de crear) no ve nada: la otra petición aún
    // no había confirmado; al crear choca con el único y relee.
    const original = repo.findByIdempotencyKey.bind(repo);
    let calls = 0;
    repo.findByIdempotencyKey = (key: string) => {
      calls += 1;
      return calls === 1 ? Promise.resolve(null) : original(key);
    };
    await uc.execute('p1', input, 'user-1', undefined, undefined, {
      idempotencyKey: KEY,
    });
    calls = 0;
    const signals: IdempotencySignals = {};
    const raced = await uc.execute(
      'p1',
      input,
      'user-1',
      undefined,
      undefined,
      {
        idempotencyKey: KEY,
        signals,
      },
    );

    expect(raced.id).toBe(repo.rows[0].id);
    expect(signals.replayed).toBe(true);
    expect(repo.rows).toHaveLength(1);
  });
});
