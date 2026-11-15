import { FixedDocumentTypeNamesReader } from '../../document-type-names/__fixtures__/fixed-document-type-names.reader';
import {
  DENTIST_ID,
  InMemoryPrescriptionRepository,
  PATIENT_ID,
} from '../application/__fixtures__/in-memory-prescriptions';
import { IssuePrescriptionUseCase } from '../application/use-cases/prescriptions.use-cases';
import { presentPublicPrescriptionCopy } from './prescription.presenter';

const NOW = new Date('2026-11-15T15:00:00.000Z');
const EXPIRES = new Date('2026-12-15T15:00:00.000Z');
const CLINIC = { name: 'Clínica Demo', primaryColor: null, logoUrl: null };
const FORMAT = {
  timeZone: 'America/Caracas',
  locale: 'es-VE',
  hourCycle: 'h12' as const,
};

async function issued() {
  const repo = new InMemoryPrescriptionRepository();
  const rx = await new IssuePrescriptionUseCase(
    repo,
    () => NOW,
    new FixedDocumentTypeNamesReader(),
  ).execute(
    PATIENT_ID,
    {
      items: [
        {
          activeIngredient: 'Amoxicilina',
          concentration: '500 mg',
          pharmaceuticalForm: 'Cápsula',
          route: 'Oral',
          dose: '1 cápsula',
          frequency: 'Cada 8 horas',
          durationDays: 7,
          totalQuantity: 21,
          quantityUnit: 'cápsulas',
        },
      ],
      safetyOverride: true,
      safetyOverrideReason: 'Motivo interno del prescriptor',
    },
    DENTIST_ID,
  );
  return {
    ...rx,
    clinicLogoUrl: null,
    locationFormat: FORMAT,
    integrityOk: true,
  };
}

describe('presentPublicPrescriptionCopy (DX-468)', () => {
  it('vigente: la receta que se imprime, sin las notas internas de seguridad, con el pie y el formato de la sede', async () => {
    const rx = await issued();
    const dto = presentPublicPrescriptionCopy({
      status: 'AVAILABLE',
      clinic: CLINIC,
      expiresAt: EXPIRES,
      footer: 'Copia para el paciente.',
      prescription: {
        ...rx,
        allergyMatches: [
          { allergen: 'Penicilina', activeIngredient: 'Amoxicilina' },
        ],
      },
    });
    expect(dto).toMatchObject({
      status: 'AVAILABLE',
      clinic: CLINIC,
      expiresAt: EXPIRES,
      footer: 'Copia para el paciente.',
      voidedOn: null,
      locale: 'es-VE',
      hourCycle: 'h12',
    });
    expect(dto.prescription).toMatchObject({
      id: rx.id,
      verificationCode: rx.verificationCode,
      items: [expect.objectContaining({ activeIngredient: 'Amoxicilina' })],
      allergyMatches: [],
      safetyAlerts: [],
      safetyOverrideReason: null,
      voidReason: null,
      voidedByName: null,
    });
  });

  it('anulada: solo el día civil de la anulación en la zona de la sede; ni receta ni pie', () => {
    expect(
      presentPublicPrescriptionCopy({
        status: 'VOIDED',
        clinic: CLINIC,
        expiresAt: EXPIRES,
        voidedAt: new Date('2026-11-16T02:00:00.000Z'),
        locationFormat: FORMAT,
      }),
    ).toEqual({
      status: 'VOIDED',
      clinic: CLINIC,
      expiresAt: EXPIRES,
      footer: null,
      prescription: null,
      voidedOn: '2026-11-15',
      locale: 'es-VE',
      hourCycle: 'h12',
    });
  });

  it('no verificable: nada de la receta', () => {
    expect(
      presentPublicPrescriptionCopy({
        status: 'UNVERIFIABLE',
        clinic: null,
        expiresAt: EXPIRES,
      }),
    ).toMatchObject({
      status: 'UNVERIFIABLE',
      prescription: null,
      footer: null,
    });
  });
});
