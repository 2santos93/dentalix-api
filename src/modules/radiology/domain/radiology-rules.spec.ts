import { BadRequestException } from '@nestjs/common';
import {
  RADIOLOGY_DUE_SOON_DAYS,
  defaultExpiresOn,
  radiologyStatus,
  validateRadiologyFields,
} from './radiology-rules';

const TODAY = '2026-11-06';

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return (error as BadRequestException).message;
  }
  throw new Error('no lanzó');
}

describe('DX-544 · vencimiento por defecto', () => {
  it('licencia Cat. I: 5 años; Cat. II: 4 años; control de calidad: 2 años', () => {
    expect(defaultExpiresOn('LICENSE', 'I', '2026-03-15')).toBe('2031-03-15');
    expect(defaultExpiresOn('LICENSE', 'II', '2026-03-15')).toBe('2030-03-15');
    expect(defaultExpiresOn('QUALITY_CONTROL', null, '2026-03-15')).toBe(
      '2028-03-15',
    );
  });

  it('el 29 de febrero recorta a fin de mes', () => {
    expect(defaultExpiresOn('LICENSE', 'I', '2028-02-29')).toBe('2033-02-28');
    expect(defaultExpiresOn('QUALITY_CONTROL', null, '2028-02-29')).toBe(
      '2030-02-28',
    );
  });
});

describe('DX-544 · validateRadiologyFields', () => {
  const license = {
    kind: 'LICENSE' as const,
    category: 'II' as const,
    reference: '  Res. 0123  de 2026 ',
    issuer: 'Autoridad sanitaria regional',
    issuedOn: '2026-01-10',
  };

  it('normaliza los textos y calcula el vencimiento si no se indica', () => {
    expect(validateRadiologyFields(license, TODAY)).toEqual({
      kind: 'LICENSE',
      category: 'II',
      reference: 'Res. 0123 de 2026',
      issuer: 'Autoridad sanitaria regional',
      issuedOn: '2026-01-10',
      expiresOn: '2030-01-10',
      officerName: null,
      notes: null,
    });
    expect(
      validateRadiologyFields({ ...license, expiresOn: '' }, TODAY).expiresOn,
    ).toBe('2030-01-10');
  });

  it('respeta el vencimiento explícito del papel', () => {
    expect(
      validateRadiologyFields({ ...license, expiresOn: '2029-12-31' }, TODAY)
        .expiresOn,
    ).toBe('2029-12-31');
  });

  it('la licencia exige categoría, número y autoridad (todo en un 400)', () => {
    const message = messageOf(() =>
      validateRadiologyFields(
        {
          kind: 'LICENSE',
          category: null,
          reference: ' ',
          issuer: '',
          issuedOn: '2026-01-10',
        },
        TODAY,
      ),
    );
    expect(message).toContain('Indica la categoría de la licencia (I o II).');
    expect(message).toContain('Escribe el número o la resolución');
    expect(message).toContain('Escribe la autoridad que expidió la licencia');
  });

  it('el control de calidad no lleva categoría; el número es opcional', () => {
    expect(
      messageOf(() =>
        validateRadiologyFields(
          {
            kind: 'QUALITY_CONTROL',
            category: 'I',
            issuer: 'Física Médica SAS',
            issuedOn: '2026-01-10',
          },
          TODAY,
        ),
      ),
    ).toBe('La categoría solo va en una licencia.');
    expect(
      validateRadiologyFields(
        {
          kind: 'QUALITY_CONTROL',
          issuer: 'Física Médica SAS',
          issuedOn: '2026-01-10',
        },
        TODAY,
      ),
    ).toMatchObject({
      category: null,
      reference: null,
      expiresOn: '2028-01-10',
    });
  });

  it('la expedición es obligatoria, válida y no futura en la sede', () => {
    expect(
      messageOf(() =>
        validateRadiologyFields({ ...license, issuedOn: null }, TODAY),
      ),
    ).toBe('La fecha de expedición no es válida (AAAA-MM-DD).');
    expect(
      messageOf(() =>
        validateRadiologyFields({ ...license, issuedOn: '2026-11-07' }, TODAY),
      ),
    ).toBe('La fecha de expedición no puede ser futura.');
    expect(
      validateRadiologyFields({ ...license, issuedOn: TODAY }, TODAY).issuedOn,
    ).toBe(TODAY);
  });

  it('el vencimiento es posterior a la expedición y a 10 años como mucho', () => {
    expect(
      messageOf(() =>
        validateRadiologyFields({ ...license, expiresOn: '2026-01-10' }, TODAY),
      ),
    ).toBe('El vencimiento tiene que ser posterior a la expedición.');
    expect(
      messageOf(() =>
        validateRadiologyFields({ ...license, expiresOn: '2036-01-11' }, TODAY),
      ),
    ).toBe('El vencimiento no puede ser a más de 10 años de la expedición.');
    expect(
      validateRadiologyFields({ ...license, expiresOn: '2036-01-10' }, TODAY)
        .expiresOn,
    ).toBe('2036-01-10');
    expect(
      messageOf(() =>
        validateRadiologyFields({ ...license, expiresOn: '2030-02-30' }, TODAY),
      ),
    ).toBe('La fecha de vencimiento no es válida (AAAA-MM-DD).');
  });

  it('topes de longitud y caracteres de control', () => {
    const message = messageOf(() =>
      validateRadiologyFields(
        {
          ...license,
          issuer: 'x'.repeat(121),
          officerName: 'Ana\u0007',
          notes: 'n'.repeat(2001),
        },
        TODAY,
      ),
    );
    expect(message).toContain('Escribe la autoridad que expidió la licencia');
    expect(message).toContain(
      'El nombre del encargado tiene caracteres no permitidos.',
    );
    expect(message).toContain(
      'El campo de notas no puede tener más de 2000 caracteres.',
    );
  });
});

describe('DX-544 · radiologyStatus', () => {
  it('vencido antes de hoy; vence pronto de hoy a +90 días; al día después', () => {
    expect(radiologyStatus('2026-11-05', TODAY, false)).toBe('OVERDUE');
    expect(radiologyStatus(TODAY, TODAY, false)).toBe('DUE_SOON');
    expect(RADIOLOGY_DUE_SOON_DAYS).toBe(90);
    expect(radiologyStatus('2027-02-04', TODAY, false)).toBe('DUE_SOON');
    expect(radiologyStatus('2027-02-05', TODAY, false)).toBe('UP_TO_DATE');
  });

  it('uno renovado no avisa aunque haya vencido', () => {
    expect(radiologyStatus('2020-01-01', TODAY, true)).toBe('RENEWED');
  });
});
