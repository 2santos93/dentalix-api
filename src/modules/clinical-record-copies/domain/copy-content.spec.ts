import { civilRangeInZone } from '../../../shared/time/civil-day';
import type { ClinicalEntry } from '../../clinical-entries/domain/entities/clinical-entry.entity';
import type { MedicalHistory } from '../../medical-history/domain/entities/medical-history.entity';
import type { ToothRecord } from '../../odontogram/domain/entities/tooth-record.entity';
import type { AnesthesiaAdministration } from '../../anesthesia/domain/entities';
import type { SedationSheet } from '../../sedation/domain/entities';
import type { PatientConsentSummary } from '../../consents/domain/entities/patient-consent.entity';
import type { Prescription } from '../../prescriptions/domain/entities/prescription.entity';
import {
  assembleCopyContent,
  isCopyEmpty,
  type CopyAppointmentSource,
  type CopyLookups,
  type CopyWindow,
} from './copy-content';
import { CLINICAL_RECORD_COPY_SECTIONS } from './clinical-record-copy';

// Caracas es UTC−4 todo el año: el 1 de marzo de 2026 en la sede va de
// 2026-03-01T04:00Z a 2026-03-02T04:00Z (exclusivo).
const ZONE = 'America/Caracas';
const range = civilRangeInZone('2026-03-01', '2026-03-01', ZONE);
const GENERATED = new Date('2026-03-10T15:00:00Z');
const W: CopyWindow = { ...range, asOf: GENERATED };

const names: CopyLookups = {
  userName: (id) => (id ? `Usuario ${id}` : null),
  locationName: (id) => (id ? `Sede ${id}` : null),
  entryLocationId: () => 'caracas',
  catalogLabel: (id) => (id ? `Proc ${id}` : null),
};

function entry(
  id: string,
  entryDate: string,
  patch: Partial<ClinicalEntry> = {},
): ClinicalEntry {
  return {
    id,
    tenantId: 't',
    patientId: 'p',
    entryDate: new Date(entryDate),
    reason: null,
    notes: `Nota ${id}`,
    performedById: 'dra',
    authorProfessionalLicense: 'MPPS-123',
    appointmentId: null,
    templateId: null,
    appointment: null,
    createdAt: new Date(entryDate),
    addenda: [],
    diagnoses: [],
    ...patch,
  };
}

describe('assembleCopyContent (DX-456)', () => {
  it('borde del día en America/Caracas: 23:59 locales entran, 00:00 del día siguiente no', () => {
    const content = assembleCopyContent(
      ['EVOLUTIONS'],
      {
        evolutions: [
          entry('antes', '2026-03-01T03:59:59.999Z'), // 28/02 23:59 en Caracas
          entry('primera', '2026-03-01T04:00:00.000Z'), // 01/03 00:00
          entry('ultima', '2026-03-02T03:59:59.999Z'), // 01/03 23:59
          entry('despues', '2026-03-02T04:00:00.000Z'), // 02/03 00:00
        ],
      },
      W,
      names,
    );
    expect(content.evolutions?.map((e) => e.notes)).toEqual([
      'Nota primera',
      'Nota ultima',
    ]);
  });

  it('cada evolución lleva autor, registro, sede y adendas en orden; nada escrito tras la generación', () => {
    const content = assembleCopyContent(
      ['EVOLUTIONS'],
      {
        evolutions: [
          entry('e1', '2026-03-01T14:00:00Z', {
            addenda: [
              {
                id: 'a1',
                tenantId: 't',
                patientId: 'p',
                clinicalEntryId: 'e1',
                reason: 'Corrección',
                text: 'Primera adenda',
                authorId: 'dra',
                createdAt: new Date('2026-03-02T10:00:00Z'),
              },
              {
                id: 'a2',
                tenantId: 't',
                patientId: 'p',
                clinicalEntryId: 'e1',
                reason: 'Corrección',
                text: 'Escrita después de generar',
                authorId: 'dra',
                createdAt: new Date('2026-03-11T10:00:00Z'),
              },
            ],
          }),
          // Fecha del período, pero escrita después de generar: no entra.
          entry('tardia', '2026-03-01T15:00:00Z', {
            createdAt: new Date('2026-03-12T09:00:00Z'),
          }),
        ],
      },
      W,
      names,
    );
    expect(content.evolutions).toEqual([
      expect.objectContaining({
        authorName: 'Usuario dra',
        authorLicense: 'MPPS-123',
        locationName: 'Sede caracas',
        addenda: [
          expect.objectContaining({
            text: 'Primera adenda',
            authorName: 'Usuario dra',
          }),
        ],
      }),
    ]);
    // Sin ids internos en lo que sale.
    expect(JSON.stringify(content)).not.toMatch(/"id":|"a1"/);
  });

  it('solo trae las claves de las secciones elegidas', () => {
    const content = assembleCopyContent(['CONSENTS'], {}, W, names);
    expect(Object.keys(content)).toEqual(['consents']);
    expect(isCopyEmpty(content)).toBe(true);
  });

  it('diagnósticos: los de las evoluciones del período, con su fecha', () => {
    const content = assembleCopyContent(
      ['DIAGNOSES'],
      {
        evolutions: [
          entry('e1', '2026-03-01T14:00:00Z', {
            diagnoses: [
              {
                id: 'd1',
                icd10Code: 'K02.1',
                labelEs: 'Caries de la dentina',
                kind: 'PRINCIPAL',
                toothFdi: '16',
                position: 0,
              },
            ],
          }),
          entry('fuera', '2026-02-20T14:00:00Z', {
            diagnoses: [
              {
                id: 'd2',
                icd10Code: 'K05.1',
                labelEs: 'Gingivitis crónica',
                kind: 'PRINCIPAL',
                toothFdi: null,
                position: 0,
              },
            ],
          }),
        ],
      },
      W,
      names,
    );
    expect(content.diagnoses).toEqual([
      {
        icd10Code: 'K02.1',
        label: 'Caries de la dentina',
        kind: 'PRINCIPAL',
        toothFdi: '16',
        entryDate: new Date('2026-03-01T14:00:00Z'),
        authorName: 'Usuario dra',
      },
    ]);
  });

  it('odontograma: la misma proyección que la carta (lo anulado en el período no sale; lo anulado después, sí)', () => {
    const tooth = (
      id: string,
      recordedAt: string,
      patch: Partial<ToothRecord> = {},
    ): ToothRecord => ({
      id,
      tenantId: 't',
      patientId: 'p',
      toothNumber: '16',
      surfaces: ['OCCLUSAL'],
      kind: 'DIAGNOSIS',
      catalogItemId: 'caries',
      status: 'COMPLETED',
      notes: null,
      clinicalEntryId: null,
      performedById: 'dra',
      sourcePlanItemId: null,
      origin: 'THIS_CLINIC',
      voidsRecordId: null,
      voidReason: null,
      recordedAt: new Date(recordedAt),
      createdAt: new Date(recordedAt),
      ...patch,
    });
    const content = assembleCopyContent(
      ['ODONTOGRAM'],
      {
        toothRecords: [
          tooth('anulado-en-periodo', '2026-03-01T13:00:00Z'),
          tooth('anulacion', '2026-03-01T13:30:00Z', {
            voidsRecordId: 'anulado-en-periodo',
          }),
          tooth('anulado-luego', '2026-03-01T14:00:00Z', { toothNumber: '26' }),
          tooth('anulacion-tardia', '2026-03-05T10:00:00Z', {
            voidsRecordId: 'anulado-luego',
          }),
          tooth('fuera', '2026-02-27T10:00:00Z', { toothNumber: '36' }),
        ],
      },
      W,
      names,
    );
    expect(content.odontogram).toEqual([
      expect.objectContaining({ toothNumber: '26', label: 'Proc caries' }),
    ]);
  });

  it('anamnesis, anestesia, sedación, consentimientos, recetas y citas del período', () => {
    const inRange = new Date('2026-03-01T16:00:00Z');
    const outRange = new Date('2026-03-03T16:00:00Z');
    const content = assembleCopyContent(
      CLINICAL_RECORD_COPY_SECTIONS,
      {
        anamnesis: [
          { version: 2, createdAt: inRange, createdById: 'dra' },
          { version: 3, createdAt: outRange, createdById: 'dra' },
        ] as unknown as MedicalHistory[],
        anesthesia: [
          {
            administeredAt: inRange,
            createdAt: inRange,
            anestheticName: 'Lidocaína 2% con epinefrina',
            authorId: 'dra',
            locationId: 'caracas',
          },
          { administeredAt: outRange, createdAt: outRange, authorId: 'dra' },
        ] as unknown as AnesthesiaAdministration[],
        sedation: [
          {
            assessedAt: inRange,
            createdAt: inRange,
            grade: 'MINIMAL',
            asaClass: 'I',
            author: { id: 'dra', name: 'Dra. Rivas' },
            locationId: 'caracas',
            agents: [],
            discharge: {
              dischargedAt: new Date('2026-03-01T18:00:00Z'),
              createdAt: new Date('2026-03-01T18:00:00Z'),
            },
          },
        ] as unknown as SedationSheet[],
        consents: [
          {
            title: 'Consentimiento de exodoncia',
            signedAt: inRange,
            signerType: 'PATIENT',
            signerName: 'Luis Gómez',
            professionalName: 'Dra. Rivas',
            professionalSignedAt: new Date('2026-03-15T10:00:00Z'),
            complete: true,
          },
        ] as unknown as PatientConsentSummary[],
        prescriptions: [
          {
            issuedAt: inRange,
            professionalName: 'Dra. Rivas',
            locationName: 'Caracas Centro',
            voidedAt: new Date('2026-03-20T10:00:00Z'),
            notes: null,
            items: [],
          },
        ] as unknown as Prescription[],
        appointments: [
          {
            start: inRange,
            end: new Date('2026-03-01T16:30:00Z'),
            status: 'COMPLETED',
            providerId: 'dra',
            locationId: 'caracas',
            typeName: 'Control',
            reason: null,
            createdAt: new Date('2026-02-20T10:00:00Z'),
          },
        ] satisfies CopyAppointmentSource[],
      },
      W,
      names,
    );
    expect(content.anamnesis?.map((a) => a.version)).toEqual([2]);
    expect(content.anesthesia?.map((a) => a.anestheticName)).toEqual([
      'Lidocaína 2% con epinefrina',
    ]);
    expect(content.sedation?.[0]).toEqual(
      expect.objectContaining({ authorName: 'Dra. Rivas', grade: 'MINIMAL' }),
    );
    // La contrafirma llegó después de generar: en la copia sigue pendiente.
    expect(content.consents?.[0].complete).toBe(false);
    // Anulada después de generar: en la copia figura emitida.
    expect(content.prescriptions?.[0].status).toBe('ISSUED');
    expect(content.appointments?.[0]).toEqual(
      expect.objectContaining({
        providerName: 'Usuario dra',
        locationName: 'Sede caracas',
        typeName: 'Control',
      }),
    );
    expect(isCopyEmpty(content)).toBe(false);
  });

  it('un rango sin nada: todas las secciones vacías', () => {
    const content = assembleCopyContent(
      CLINICAL_RECORD_COPY_SECTIONS,
      { evolutions: [entry('fuera', '2026-01-10T12:00:00Z')] },
      W,
      names,
    );
    expect(isCopyEmpty(content)).toBe(true);
    expect(content.evolutions).toEqual([]);
  });
});
