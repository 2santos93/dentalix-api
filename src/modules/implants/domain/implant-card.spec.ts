import { composeImplantCard } from './implant-card';
import type { PatientImplant } from './entities/patient-implant.entity';

function implant(over: Partial<PatientImplant>): PatientImplant {
  return {
    id: 'i1',
    patientId: 'p1',
    locationId: 'l1',
    locationName: 'Sede principal',
    professionalId: 'u1',
    professionalName: 'Dra. Ruiz',
    placedOn: '2026-10-10',
    toothNumber: '36',
    treatmentPlanItemId: null,
    kind: 'IMPLANT',
    manufacturer: 'Straumann',
    system: 'BLT',
    reference: '021.5310',
    lot: 'LOT-1',
    udi: null,
    diameterMm: 4.1,
    lengthMm: 10,
    sanitaryRegistration: 'INVIMA 2020DM-0001',
    notes: 'Nota clínica que no va en la tarjeta',
    createdAt: new Date('2026-10-10T15:00:00Z'),
    voidedAt: null,
    voidedById: null,
    voidedByName: null,
    voidReason: null,
    cardDeliveredAt: null,
    ...over,
  };
}

const PATIENT = {
  id: 'p1',
  firstName: 'Ana',
  lastName: 'Gómez',
  docType: 'CC',
  docNumber: '52123456',
  birthDate: new Date('1980-05-02T00:00:00Z'),
};

describe('composeImplantCard (DX-191)', () => {
  const card = composeImplantCard({
    clinicName: 'Clínica Demo',
    patient: PATIENT,
    placedOn: '2026-10-10',
    locations: [
      { id: 'l1', name: 'Sede principal', address: 'Cra 1 # 2-3' },
      { id: 'l2', name: 'Sede Norte', address: null },
    ],
    implants: [
      implant({
        id: 'pilar',
        kind: 'ABUTMENT',
        reference: 'RC-ABUT',
        lot: 'LOT-2',
        createdAt: new Date('2026-10-10T16:00:00Z'),
        voidedAt: new Date('2026-10-11T10:00:00Z'),
        voidReason: 'Lote mal transcrito',
        cardDeliveredAt: new Date('2026-10-12T10:00:00Z'),
      }),
      implant({
        id: 'impl',
        cardDeliveredAt: new Date('2026-10-11T09:00:00Z'),
      }),
    ],
  });

  it('lleva identidad del paciente, centro y fecha', () => {
    expect(card).toMatchObject({
      patientName: 'Ana Gómez',
      patientDocument: 'CC 52123456',
      patientBirthDate: '1980-05-02',
      clinicName: 'Clínica Demo',
      locations: [{ id: 'l1', name: 'Sede principal', address: 'Cra 1 # 2-3' }],
      placedOn: '2026-10-10',
      professionals: ['Dra. Ruiz'],
    });
  });

  it('lista los dos componentes por diente y hora, y marca el anulado', () => {
    expect(card.items.map((i) => [i.id, i.kindLabel, i.voided])).toEqual([
      ['impl', 'Implante', false],
      ['pilar', 'Pilar', true],
    ]);
  });

  it('no incluye notas ni motivo de anulación', () => {
    const json = JSON.stringify(card);
    expect(json).not.toContain('Nota clínica');
    expect(json).not.toContain('mal transcrito');
  });

  it('la entrega es la primera registrada', () => {
    expect(card.deliveredAt).toEqual(new Date('2026-10-11T09:00:00Z'));
  });

  it('sin documento, null (nunca se inventa)', () => {
    const noDoc = composeImplantCard({
      clinicName: 'C',
      patient: { ...PATIENT, docNumber: ' ' },
      placedOn: '2026-10-10',
      locations: [],
      implants: [],
    });
    expect(noDoc.patientDocument).toBeNull();
    expect(noDoc.deliveredAt).toBeNull();
  });
});
