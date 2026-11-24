import { changedFields } from './changed-fields';

describe('changedFields (DX-095)', () => {
  const before = {
    firstName: 'Ana',
    phone: '4121234567',
    birthDate: new Date('1990-05-01T00:00:00.000Z'),
    allergies: [{ alergeno: 'Penicilina' }],
    notes: null as string | null,
  };

  it('solo los campos pedidos cuyo valor guardado cambió', () => {
    const after = { ...before, phone: '4149876543', firstName: 'Ana' };
    expect(changedFields(before, after, ['firstName', 'phone'])).toEqual([
      'phone',
    ]);
  });

  it('fechas por instante y listas/objetos por contenido, no por referencia', () => {
    const after = {
      ...before,
      birthDate: new Date('1990-05-01T00:00:00.000Z'),
      allergies: [{ alergeno: 'Penicilina' }],
    };
    expect(changedFields(before, after, ['birthDate', 'allergies'])).toEqual(
      [],
    );
    expect(
      changedFields(before, { ...after, allergies: [{ alergeno: 'Látex' }] }, [
        'allergies',
      ]),
    ).toEqual(['allergies']);
  });

  it('un objeto con las mismas claves en otro orden (jsonb) no cambió', () => {
    expect(
      changedFields(
        { habits: { alcohol: 'NO', bruxismo: 'SI' } },
        { habits: { bruxismo: 'SI', alcohol: 'NO' } },
        ['habits'],
      ),
    ).toEqual([]);
  });

  it('null, undefined y ausente valen lo mismo (vaciar lo vacío no es un cambio)', () => {
    expect(
      changedFields(before, { ...before, notes: undefined }, ['notes']),
    ).toEqual([]);
    expect(changedFields(before, { ...before, notes: 'x' }, ['notes'])).toEqual(
      ['notes'],
    );
  });

  it('un campo que la entidad no tiene se da por cambiado (no se puede comprobar)', () => {
    expect(changedFields(before, before, ['countryCodeInput'])).toEqual([
      'countryCodeInput',
    ]);
  });

  it('ordenados y sin repetir', () => {
    const after = { ...before, phone: 'x', firstName: 'B' };
    expect(
      changedFields(before, after, ['phone', 'firstName', 'phone']),
    ).toEqual(['firstName', 'phone']);
  });
});
