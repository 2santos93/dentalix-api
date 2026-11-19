import { ConflictException } from '@nestjs/common';
import {
  DENTIST_ID,
  InMemoryPrescriptionRepository,
  makePatient,
  PATIENT_ID,
} from '../__fixtures__/in-memory-prescriptions';
import { FixedDocumentTypeNamesReader } from '../../../document-type-names/__fixtures__/fixed-document-type-names.reader';
import {
  IssuePrescriptionUseCase,
  type IssuePrescriptionInput,
} from './prescriptions.use-cases';
import { emptySafetyAnamnesis } from '../../domain/prescription-safety';

const NOW = new Date('2026-10-16T15:00:00.000Z');
const KEY = '9f8e7d6c-5b4a-4c3d-9e2f-1a0b9c8d7e6f';

const ibuprofeno = {
  activeIngredient: 'Ibuprofeno',
  concentration: '400 mg',
  pharmaceuticalForm: 'Tableta',
  route: 'Oral',
  dose: '1 tableta',
  frequency: 'Cada 8 horas',
  durationDays: 3,
  totalQuantity: 9,
  quantityUnit: 'tabletas',
};

function input(
  extra: Partial<IssuePrescriptionInput> = {},
): IssuePrescriptionInput {
  return { items: [ibuprofeno], ...extra };
}

describe('IssuePrescriptionUseCase — Idempotency-Key (DX-574)', () => {
  let repo: InMemoryPrescriptionRepository;
  let useCase: IssuePrescriptionUseCase;

  beforeEach(() => {
    repo = new InMemoryPrescriptionRepository();
    useCase = new IssuePrescriptionUseCase(
      repo,
      () => NOW,
      new FixedDocumentTypeNamesReader(),
    );
  });

  it('repetir la misma emisión con la misma clave devuelve la receta original', async () => {
    const first = await useCase.execute(PATIENT_ID, input(), DENTIST_ID, {
      idempotencyKey: KEY,
    });
    const signals: { replayed?: boolean } = {};
    const again = await useCase.execute(PATIENT_ID, input(), DENTIST_ID, {
      idempotencyKey: KEY,
      signals,
    });

    expect(again.id).toBe(first.id);
    expect(again.verificationCode).toBe(first.verificationCode);
    expect(signals.replayed).toBe(true);
    expect(repo.rows).toHaveLength(1);
  });

  it('el reintento no recalcula los avisos: una alergia anotada después no da 409', async () => {
    const first = await useCase.execute(PATIENT_ID, input(), DENTIST_ID, {
      idempotencyKey: KEY,
    });
    repo.patients.set(
      PATIENT_ID,
      makePatient({
        anamnesis: { ...emptySafetyAnamnesis(), allergens: ['Ibuprofeno'] },
      }),
    );

    const again = await useCase.execute(PATIENT_ID, input(), DENTIST_ID, {
      idempotencyKey: KEY,
    });
    expect(again.id).toBe(first.id);
    // Sin clave, la misma petición sí choca con el aviso nuevo.
    await expect(
      useCase.execute(PATIENT_ID, input(), DENTIST_ID),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('la misma clave con otros medicamentos es un 422', async () => {
    await useCase.execute(PATIENT_ID, input(), DENTIST_ID, {
      idempotencyKey: KEY,
    });

    await expect(
      useCase.execute(
        PATIENT_ID,
        input({ notes: 'Tomar después de comer' }),
        DENTIST_ID,
        { idempotencyKey: KEY },
      ),
    ).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REUSED' } });
    expect(repo.rows).toHaveLength(1);
  });

  it('la clave no entra en el sello de la receta', async () => {
    await useCase.execute(PATIENT_ID, input(), DENTIST_ID, {
      idempotencyKey: KEY,
    });
    expect(JSON.stringify(repo.lastCreateInput)).not.toContain(KEY);
  });
});
