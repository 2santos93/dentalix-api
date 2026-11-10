import {
  imagingExportFileName,
  imagingExportText,
  withoutDiacritics,
  type ImagingExportPatient,
} from './imaging-export';

const JOSE: ImagingExportPatient = {
  patientCode: '1042',
  firstName: 'José Ángel',
  lastName: 'Pérez Núñez',
  birthDate: new Date('1990-03-05T00:00:00.000Z'),
  sex: 'M',
};

const lines = (text: string): string[] => text.split('\r\n').slice(0, -1);

describe('DX-484: exportación para el software de imagen', () => {
  describe('withoutDiacritics', () => {
    it.each([
      ['Pérez Núñez', 'Perez Nunez'],
      ['José Ángel', 'Jose Angel'],
      ['NÚÑEZ', 'NUNEZ'],
      ['ñ Ñ', 'n N'],
      ['Müller Güell', 'Muller Guell'],
      ['Gonçalves Çelik', 'Goncalves Celik'],
      ['Strauß', 'Strauss'],
      ['Æsir æble', 'AEsir aeble'],
      ['Søren Øster', 'Soren Oster'],
      ['Œuvre cœur', 'OEuvre coeur'],
      ['Đorđe', 'Dorde'],
      ['Łukasz Wałęsa', 'Lukasz Walesa'],
      ['Dvořák', 'Dvorak'],
      ['María-José O’Brien', 'Maria-Jose O’Brien'],
    ])('%s → %s', (input, expected) => {
      expect(withoutDiacritics(input)).toBe(expected);
    });

    it('also strips combining marks written apart (already decomposed text)', () => {
      expect(withoutDiacritics('José Nũñez')).toBe('Jose Nunez');
    });

    it('leaves plain ASCII untouched', () => {
      expect(withoutDiacritics('Rodriguez Silva')).toBe('Rodriguez Silva');
    });
  });

  it('the file name carries the code', () => {
    expect(imagingExportFileName('1042')).toBe('paciente-1042.txt');
  });

  it('a full patient: labelled lines, CRLF, both name forms and both date formats', () => {
    expect(imagingExportText(JOSE)).toBe(
      'Código del paciente: 1042\r\n' +
        'Apellidos: Pérez Núñez\r\n' +
        'Nombre: José Ángel\r\n' +
        'Apellidos (sin tildes): Perez Nunez\r\n' +
        'Nombre (sin tildes): Jose Angel\r\n' +
        'Fecha de nacimiento: 05.03.1990\r\n' +
        'Fecha de nacimiento (aaaa-mm-dd): 1990-03-05\r\n' +
        'Sexo: M\r\n',
    );
  });

  it('every line ends in CRLF, with no bare LF or CR', () => {
    const text = imagingExportText(JOSE);
    expect(text.endsWith('\r\n')).toBe(true);
    expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });

  it('only the eight identification fields, nothing else', () => {
    expect(lines(imagingExportText(JOSE)).map((l) => l.split(':')[0])).toEqual([
      'Código del paciente',
      'Apellidos',
      'Nombre',
      'Apellidos (sin tildes)',
      'Nombre (sin tildes)',
      'Fecha de nacimiento',
      'Fecha de nacimiento (aaaa-mm-dd)',
      'Sexo',
    ]);
  });

  it('ignores any other field the caller passes (no document, contact or clinical data)', () => {
    const withExtras = {
      ...JOSE,
      docNumber: 'V-12345678',
      phone: '+584121234567',
      email: 'jose@example.com',
      notes: 'Alergia a la penicilina',
    };
    const text = imagingExportText(withExtras);
    expect(text).not.toMatch(/12345678|584121234567|example\.com|penicilina/);
  });

  it.each([
    ['M', 'M'],
    ['F', 'F'],
    ['OTHER', 'Otro'],
    ['UNSPECIFIED', 'Sin indicar'],
  ] as const)('sex %s → «%s»', (sex, label) => {
    expect(lines(imagingExportText({ ...JOSE, sex })).at(-1)).toBe(
      `Sexo: ${label}`,
    );
  });

  it('without a birth date both date lines say «Sin indicar»', () => {
    const out = lines(imagingExportText({ ...JOSE, birthDate: null }));
    expect(out[5]).toBe('Fecha de nacimiento: Sin indicar');
    expect(out[6]).toBe('Fecha de nacimiento (aaaa-mm-dd): Sin indicar');
  });

  it('the birth date is the civil date (UTC components), whatever the process zone', () => {
    // Medianoche UTC del 1 de enero: en una zona al oeste de UTC el día local
    // sería el 31 de diciembre; la fecha civil es el 1.
    const out = lines(
      imagingExportText({
        ...JOSE,
        birthDate: new Date('2001-01-01T00:00:00.000Z'),
      }),
    );
    expect(out[5]).toBe('Fecha de nacimiento: 01.01.2001');
    expect(out[6]).toBe('Fecha de nacimiento (aaaa-mm-dd): 2001-01-01');
  });

  it('a line break or control character inside a name cannot add a line', () => {
    const text = imagingExportText({
      ...JOSE,
      firstName: 'Ana\r\nSexo: F',
      lastName: '  Rivas\tMárquez  ',
    });
    expect(lines(text)).toHaveLength(8);
    expect(lines(text)[1]).toBe('Apellidos: Rivas Márquez');
    expect(lines(text)[2]).toBe('Nombre: Ana Sexo: F');
    expect(lines(text)[3]).toBe('Apellidos (sin tildes): Rivas Marquez');
  });

  it('an empty name after cleaning says «Sin indicar»', () => {
    const out = lines(imagingExportText({ ...JOSE, firstName: ' \n ' }));
    expect(out[2]).toBe('Nombre: Sin indicar');
    expect(out[4]).toBe('Nombre (sin tildes): Sin indicar');
  });
});
