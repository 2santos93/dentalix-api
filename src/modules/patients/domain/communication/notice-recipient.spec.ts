import { civilDateIn } from '../../../../shared/time/civil-day';
import {
  noticeRecipient,
  type NoticeRecipientInput,
  type NoticeResponsible,
} from './notice-recipient';

const TODAY = '2026-10-17';
const CHILD = new Date('2015-03-10T00:00:00.000Z');
const ADULT = new Date('1990-05-01T00:00:00.000Z');
/** 17 años en TODAY: menor con 18, adulto con 16. */
const SEVENTEEN = new Date('2009-03-01T00:00:00.000Z');

const mother: NoticeResponsible = {
  id: 'mother',
  name: '  María José Pérez ',
  email: 'maria@example.com',
  isPayer: false,
  receivesNotices: true,
  optedOut: false,
};
const father: NoticeResponsible = {
  id: 'father',
  name: 'Luis Pérez',
  email: 'luis@example.com',
  isPayer: true,
  receivesNotices: true,
  optedOut: false,
};

function input(over: Partial<NoticeRecipientInput> = {}): NoticeRecipientInput {
  return {
    patient: {
      firstName: 'Sofía Andrea',
      birthDate: CHILD,
      email: null,
      emergencyContactName: null,
    },
    responsibles: [mother],
    majorityAge: 18,
    today: TODAY,
    ...over,
  };
}

describe('noticeRecipient (DX-203: menores y pacientes sin email, al responsable)', () => {
  it('un menor sin email recibe sus avisos en el email del responsable', () => {
    expect(noticeRecipient(input())).toEqual({
      kind: 'RESPONSIBLE',
      name: 'María',
      email: 'maria@example.com',
      minor: true,
      responsiblePartyId: 'mother',
    });
  });

  it('un menor CON email también: van al responsable', () => {
    const r = noticeRecipient(
      input({
        patient: { ...input().patient, email: 'sofi@example.com' },
      }),
    );
    expect(r).toMatchObject({
      kind: 'RESPONSIBLE',
      email: 'maria@example.com',
    });
  });

  it('primero el pagador principal; quien no recibe avisos no cuenta', () => {
    expect(
      noticeRecipient(input({ responsibles: [mother, father] }))
        .responsiblePartyId,
    ).toBe('father');
    expect(
      noticeRecipient(
        input({
          responsibles: [mother, { ...father, receivesNotices: false }],
        }),
      ).responsiblePartyId,
    ).toBe('mother');
  });

  it('un adulto sin email: al responsable; con email, a él mismo', () => {
    const adult = { ...input().patient, birthDate: ADULT };
    expect(noticeRecipient(input({ patient: adult })).kind).toBe('RESPONSIBLE');
    expect(
      noticeRecipient(
        input({ patient: { ...adult, email: ' yo@example.com ' } }),
      ),
    ).toEqual({
      kind: 'PATIENT',
      name: 'Sofía',
      email: 'yo@example.com',
      minor: false,
      responsiblePartyId: null,
    });
  });

  it('noticeRecipient routes a 17-year-old to the responsible with 18 and to the patient with 16', () => {
    const teen = {
      ...input().patient,
      birthDate: SEVENTEEN,
      email: 'teen@example.com',
    };
    expect(
      noticeRecipient(input({ patient: teen, majorityAge: 18 })).kind,
    ).toBe('RESPONSIBLE');
    expect(
      noticeRecipient(input({ patient: teen, majorityAge: 16 })),
    ).toMatchObject({
      kind: 'PATIENT',
      email: 'teen@example.com',
      minor: false,
    });
  });

  it('a 19-year-old is a minor with 20', () => {
    const nineteen = {
      ...input().patient,
      birthDate: new Date('2007-03-01T00:00:00.000Z'),
      email: 'nineteen@example.com',
    };
    expect(
      noticeRecipient(input({ patient: nineteen, majorityAge: 20 })),
    ).toMatchObject({ kind: 'RESPONSIBLE', minor: true });
  });

  it('birthday boundary uses the location civil day: adult in Pacific/Auckland, minor in America/New_York at the same instant', () => {
    // 2026-10-17T03:00Z: ya es 17 de octubre en Auckland (UTC+13) y aún 16
    // en Nueva York (UTC-4). Cumple 18 el 17 de octubre.
    const now = new Date('2026-10-17T03:00:00.000Z');
    const birthday = {
      ...input().patient,
      birthDate: new Date('2008-10-17T00:00:00.000Z'),
      email: 'birthday@example.com',
    };
    const at = (zone: string) =>
      noticeRecipient(
        input({
          patient: birthday,
          majorityAge: 18,
          today: civilDateIn(now, zone),
        }),
      );
    expect(at('Pacific/Auckland')).toMatchObject({
      kind: 'PATIENT',
      minor: false,
    });
    expect(at('America/New_York')).toMatchObject({
      kind: 'RESPONSIBLE',
      minor: true,
    });
  });

  it('el responsable sin email: un menor va al email de la ficha saludándolo (DX-128)', () => {
    const r = noticeRecipient(
      input({
        patient: { ...input().patient, email: 'familia@example.com' },
        responsibles: [{ ...mother, email: null }],
      }),
    );
    expect(r).toEqual({
      kind: 'GUARDIAN',
      name: 'María',
      email: 'familia@example.com',
      minor: true,
      responsiblePartyId: 'mother',
    });
  });

  it('un menor sin responsables: al contacto principal o a su nombre', () => {
    expect(
      noticeRecipient(
        input({
          responsibles: [],
          patient: { ...input().patient, emergencyContactName: 'Luis Gómez' },
        }),
      ),
    ).toMatchObject({ kind: 'CONTACT', name: 'Luis', email: null });
    expect(noticeRecipient(input({ responsibles: [] }))).toMatchObject({
      kind: 'PATIENT',
      email: null,
      minor: true,
    });
  });

  it('automático: se respeta la baja del paciente responsable (DX-128)', () => {
    const optedOut = { ...father, optedOut: true };
    expect(
      noticeRecipient(
        input({ responsibles: [optedOut, mother], automatic: true }),
      ).responsiblePartyId,
    ).toBe('mother');
    // Un envío pedido por recepción (recibo) sí le llega.
    expect(
      noticeRecipient(input({ responsibles: [optedOut, mother] }))
        .responsiblePartyId,
    ).toBe('father');
  });

  it('sin fecha de nacimiento y con email: adulto, a él mismo', () => {
    expect(
      noticeRecipient(
        input({
          patient: {
            ...input().patient,
            birthDate: null,
            email: 'x@example.com',
          },
        }),
      ).kind,
    ).toBe('PATIENT');
  });
});
