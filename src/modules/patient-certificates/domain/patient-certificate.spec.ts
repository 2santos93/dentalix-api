import { PdfkitCertificatePdfRenderer } from '../infrastructure/certificate-pdf.renderer';
import type { CertificateSnapshot } from './certificate-snapshot';
import {
  DIAGNOSIS_OMITTED_NOTE,
  buildCertificatePdfModel,
  certificateFileName,
  type PatientCertificate,
} from './patient-certificate';

const snapshot: CertificateSnapshot = {
  version: 1,
  patient: { name: 'Mariela Rondón', document: 'Cédula V-12345678' },
  professional: {
    name: 'Dra. Ana Pérez',
    license: 'MPPS 45678',
    specialty: 'Cirugía bucal',
  },
  location: {
    name: 'Sede Chacao',
    address: 'Av. Francisco de Miranda, Caracas',
    healthRegistrationNumber: 'RS-001',
    timeZone: 'America/Caracas',
    locale: 'es-VE',
    hourCycle: 'h12',
  },
  clinic: {
    name: 'Clínica Dental Ávila',
    legalName: 'Odontología Ávila C.A.',
    taxIdLabel: 'RIF',
    taxId: 'J-12345678-9',
  },
};

const base: PatientCertificate = {
  id: 'c1',
  patientId: 'p1',
  appointmentId: 'a1',
  locationId: 'l1',
  professionalMembershipId: 'm1',
  issuedById: 'u1',
  issuedByName: 'Recepción',
  kind: 'ATTENDANCE',
  number: 12,
  issuedAt: new Date('2026-11-16T15:00:00Z'),
  // 09:00–09:41 en Caracas (UTC−4).
  attendedFrom: new Date('2026-11-16T13:00:00Z'),
  attendedUntil: new Date('2026-11-16T13:41:00Z'),
  timesSource: 'ACTUAL',
  restDays: null,
  restStartDate: null,
  restEndDate: null,
  diagnosis: null,
  snapshot,
  documentId: null,
  voidedAt: null,
  voidedById: null,
  voidedByName: null,
  voidReason: null,
  voidedDocumentId: null,
};

describe('PDF del certificado (DX-306)', () => {
  it('justificante: «asistió a consulta» con las horas en la zona y el reloj de la sede, sin diagnóstico', () => {
    const model = buildCertificatePdfModel(base, { withDiagnosis: true });
    expect(model.title).toBe('Justificante de asistencia');
    expect(model.numberLabel).toBe('Nº 000012');
    expect(model.header.lines).toEqual([
      'Odontología Ávila C.A.',
      'RIF: J-12345678-9',
      'Sede Chacao',
      'Av. Francisco de Miranda, Caracas',
      'Nº de registro sanitario: RS-001',
    ]);
    const body = model.paragraphs.join('\n');
    expect(body).toContain(
      'Mariela Rondón, con Cédula V-12345678, asistió a consulta en Sede Chacao',
    );
    expect(body).toMatch(/de 9:00\s?a\.\s?m\. a 9:41\s?a\.\s?m\./);
    expect(body).not.toContain('Diagnóstico');
    expect(model.notes).toEqual([]);
    expect(model.signature).toEqual([
      'Dra. Ana Pérez',
      'Cirugía bucal',
      'Nº de registro profesional: MPPS 45678',
    ]);
    expect(model.voided).toBeNull();
  });

  it('horas programadas: lo dice en una nota', () => {
    const model = buildCertificatePdfModel(
      {
        ...base,
        timesSource: 'SCHEDULED',
      },
      { withDiagnosis: true },
    );
    expect(model.notes).toEqual([
      'Horas programadas de la cita: no constan las horas reales de llegada y salida.',
    ]);
  });

  it('reposo: días, desde y hasta, y el diagnóstico solo si lo lleva', () => {
    const rest = {
      ...base,
      kind: 'REST' as const,
      restDays: 3,
      restStartDate: '2026-11-16',
      restEndDate: '2026-11-18',
    };
    const without = buildCertificatePdfModel(rest, {
      withDiagnosis: true,
    }).paragraphs.join('\n');
    expect(without).toContain('requiere reposo de 3 días');
    expect(without).toContain('desde el 16 de noviembre de 2026');
    expect(without).toContain('hasta el 18 de noviembre de 2026');
    expect(without).not.toContain('Diagnóstico');
    const withDx = buildCertificatePdfModel(
      {
        ...rest,
        diagnosis: 'Exodoncia del 38',
      },
      { withDiagnosis: true },
    ).paragraphs;
    expect(withDx).toContain('Diagnóstico: Exodoncia del 38');
    // La copia archivada y la pública: sin el diagnóstico, con la nota.
    const redacted = buildCertificatePdfModel(
      { ...rest, diagnosis: 'Exodoncia del 38' },
      { withDiagnosis: false },
    );
    expect(JSON.stringify(redacted)).not.toContain('Exodoncia');
    expect(redacted.notes).toEqual([DIAGNOSIS_OMITTED_NOTE]);
    expect(
      buildCertificatePdfModel(rest, { withDiagnosis: false }).notes,
    ).toEqual([]);
  });

  it('sin datos fiscales ni registro, no imprime esas líneas', () => {
    const model = buildCertificatePdfModel(
      {
        ...base,
        snapshot: {
          ...snapshot,
          clinic: { ...snapshot.clinic, legalName: null, taxId: null },
          location: {
            ...snapshot.location,
            address: null,
            healthRegistrationNumber: null,
          },
        },
      },
      { withDiagnosis: true },
    );
    expect(model.header.lines).toEqual(['Sede Chacao']);
  });

  it('anulado: sello y línea con fecha y motivo; el nombre del fichero lo dice', () => {
    const voided = {
      ...base,
      voidedAt: new Date('2026-11-17T14:00:00Z'),
      voidReason: 'Fecha equivocada',
    };
    const model = buildCertificatePdfModel(voided, { withDiagnosis: true });
    expect(model.voided?.stamp).toBe('ANULADO');
    expect(model.voided?.line).toMatch(
      /^ANULADO el 17\/11\/2026.*Motivo: Fecha equivocada$/,
    );
    expect(certificateFileName('ATTENDANCE', 12, true)).toBe(
      'justificante-000012-anulado.pdf',
    );
    expect(certificateFileName('REST', 3, false)).toBe(
      'certificado-reposo-000003.pdf',
    );
  });

  it('el renderer da un PDF determinista, también con otro alfabeto y anulado', async () => {
    const renderer = new PdfkitCertificatePdfRenderer({ compress: false });
    const cert = {
      ...base,
      snapshot: {
        ...snapshot,
        patient: { name: 'Алексей 李明', document: null },
      },
      voidedAt: new Date('2026-11-17T14:00:00Z'),
      voidReason: 'Duplicado',
    };
    const a = await renderer.render(
      buildCertificatePdfModel(cert, { withDiagnosis: true }),
    );
    const b = await renderer.render(
      buildCertificatePdfModel(cert, { withDiagnosis: true }),
    );
    expect(a.subarray(0, 5).toString()).toBe('%PDF-');
    expect(a.equals(b)).toBe(true);
    expect(a.toString('latin1')).toContain('NotoSans');
  });
});
