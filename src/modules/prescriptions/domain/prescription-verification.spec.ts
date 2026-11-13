import {
  patientInitials,
  verifyPrescription,
  type VerifiablePrescription,
} from './prescription-verification';

const RX: VerifiablePrescription = {
  status: 'ISSUED',
  // 00:30 del 15 en UTC = 20:30 del 14 en Caracas (UTC-4).
  issuedAt: new Date('2026-11-15T00:30:00.000Z'),
  voidedAt: null,
  professionalName: 'Dra. Andreína Salazar',
  professionalLicense: 'MPPS 45678',
  clinicName: 'Clínica Dental Los Palos Grandes',
  patientName: 'María José Pérez de la Rosa',
  locationFormat: { timeZone: 'America/Caracas', locale: 'es-VE' },
};

describe('iniciales del paciente (DX-467)', () => {
  it.each([
    ['María José Pérez de la Rosa', 'M. J. P. R.'],
    ['luis   díaz', 'L. D.'],
    ['Ángel Úcar', 'Á. Ú.'],
    ['Ana', 'A.'],
    ['Juan Carlos Pedro Pablo Gómez', 'J. C. P. P.'],
    ["O'Neill Smith", 'O. S.'],
    ['  ', ''],
  ])('%s → %s', (name, expected) => {
    expect(patientInitials(name)).toBe(expected);
  });
});

describe('verificación pública de la receta (DX-467)', () => {
  it('válida: día de emisión en la zona de la sede, profesional, registro, clínica e iniciales; nada más', () => {
    expect(verifyPrescription(RX, true)).toEqual({
      status: 'VALID',
      issuedOn: '2026-11-14',
      professionalName: 'Dra. Andreína Salazar',
      professionalLicense: 'MPPS 45678',
      clinicName: 'Clínica Dental Los Palos Grandes',
      patientInitials: 'M. J. P. R.',
      locale: 'es-VE',
    });
  });

  it('anulada: solo el día de la anulación (sin motivo ni datos de la receta)', () => {
    expect(
      verifyPrescription(
        {
          ...RX,
          status: 'VOIDED',
          voidedAt: new Date('2026-11-20T03:00:00.000Z'),
        },
        true,
      ),
    ).toEqual({ status: 'VOIDED', voidedOn: '2026-11-19', locale: 'es-VE' });
  });

  it('hash que no casa: no se puede verificar, aunque esté anulada', () => {
    expect(verifyPrescription(RX, false)).toEqual({ status: 'UNVERIFIABLE' });
    expect(
      verifyPrescription(
        { ...RX, status: 'VOIDED', voidedAt: new Date() },
        false,
      ),
    ).toEqual({ status: 'UNVERIFIABLE' });
  });

  it('sede sin zona válida: el día queda null, nunca una zona de reserva', () => {
    const noZone = { ...RX, locationFormat: { timeZone: null, locale: null } };
    expect(verifyPrescription(noZone, true)).toMatchObject({
      issuedOn: null,
      locale: null,
    });
    const badZone = {
      ...RX,
      locationFormat: { timeZone: 'Mars/Olympus', locale: 'es-VE' },
    };
    expect(verifyPrescription(badZone, true)).toMatchObject({ issuedOn: null });
  });
});
