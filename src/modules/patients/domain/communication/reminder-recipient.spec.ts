import { reminderRecipient } from './reminder-recipient';

const NOW = new Date('2026-10-17T15:00:00.000Z');
const base = {
  firstName: 'Sofía Andrea',
  birthDate: null as Date | null,
  guardianName: null as string | null,
  emergencyContactName: null as string | null,
};

describe('reminderRecipient (DX-128: para menores, el tutor)', () => {
  it('un adulto recibe sus avisos', () => {
    expect(
      reminderRecipient(
        { ...base, birthDate: new Date('1990-05-01'), guardianName: 'Ana' },
        NOW,
      ),
    ).toEqual({ kind: 'PATIENT', name: 'Sofía', minor: false });
  });

  it('sin fecha de nacimiento se trata como adulto', () => {
    expect(reminderRecipient({ ...base, guardianName: 'Ana' }, NOW)).toEqual({
      kind: 'PATIENT',
      name: 'Sofía',
      minor: false,
    });
  });

  it('un menor con tutor: los avisos van al tutor (su nombre de pila)', () => {
    expect(
      reminderRecipient(
        {
          ...base,
          birthDate: new Date('2015-03-10'),
          guardianName: '  María José Pérez ',
          emergencyContactName: 'Luis',
        },
        NOW,
      ),
    ).toEqual({ kind: 'GUARDIAN', name: 'María', minor: true });
  });

  it('un menor sin tutor: al contacto principal si existe', () => {
    expect(
      reminderRecipient(
        {
          ...base,
          birthDate: new Date('2015-03-10'),
          emergencyContactName: 'Luis Gómez',
        },
        NOW,
      ),
    ).toEqual({ kind: 'CONTACT', name: 'Luis', minor: true });
  });

  it('un menor sin tutor ni contacto: al propio paciente', () => {
    expect(
      reminderRecipient(
        { ...base, birthDate: new Date('2015-03-10'), guardianName: '  ' },
        NOW,
      ),
    ).toEqual({ kind: 'PATIENT', name: 'Sofía', minor: true });
  });

  it('cumple 18 justo hoy: ya es adulto; mañana los cumple: aún menor', () => {
    expect(
      reminderRecipient(
        { ...base, birthDate: new Date('2008-10-17'), guardianName: 'Ana' },
        NOW,
      ).kind,
    ).toBe('PATIENT');
    expect(
      reminderRecipient(
        { ...base, birthDate: new Date('2008-10-18'), guardianName: 'Ana' },
        NOW,
      ).kind,
    ).toBe('GUARDIAN');
  });
});
