import {
  MERGE_FIELD_GROUPS,
  mergeFieldPatch,
  type MergeFieldValues,
} from './merge-fields';

function values(over: Partial<MergeFieldValues> = {}): MergeFieldValues {
  const base = Object.fromEntries(
    Object.values(MERGE_FIELD_GROUPS)
      .flat()
      .map((c) => [c, null]),
  ) as MergeFieldValues;
  return { ...base, firstName: 'Ana', lastName: 'Pérez', ...over };
}

describe('mergeFieldPatch (DX-266)', () => {
  it('sin elecciones no cambia nada: gana el conservado', () => {
    const kept = values({ email: 'ana@example.com' });
    const absorbed = values({ email: 'otra@example.com' });
    expect(mergeFieldPatch(kept, absorbed, {})).toEqual({
      patch: {},
      groups: [],
    });
  });

  it('el grupo elegido del absorbido va entero (documento: tipo, etiqueta y número)', () => {
    const kept = values({ documentType: 'OTHER', docNumber: null });
    const absorbed = values({
      documentType: 'NATIONAL_ID',
      docTypeLabel: 'Cédula',
      docNumber: 'V-12.345.678',
      email: 'otra@example.com',
    });
    expect(
      mergeFieldPatch(kept, absorbed, { document: 'ABSORBED', email: 'KEPT' }),
    ).toEqual({
      patch: {
        documentType: 'NATIONAL_ID',
        docTypeLabel: 'Cédula',
        docNumber: 'V-12.345.678',
      },
      groups: ['document'],
    });
  });

  it('un grupo igual en los dos no se escribe ni se audita aunque se elija', () => {
    const kept = values({ birthDate: '1980-05-01', phone: '+58 412 555 1234' });
    const absorbed = values({
      birthDate: '1980-05-01',
      phone: '+58 412 555 1234',
    });
    expect(
      mergeFieldPatch(kept, absorbed, {
        birthDate: 'ABSORBED',
        phone: 'ABSORBED',
      }),
    ).toEqual({ patch: {}, groups: [] });
  });

  it('elegir un vacío del absorbido vacía el dato del conservado (null), y compara fechas por instante', () => {
    const date = (s: string) => new Date(s) as unknown as string;
    const kept = values({
      address: 'Av. Libertador',
      countryCode: 'VE',
      cityId: 7,
      birthDate: date('1980-05-01'),
    });
    const absorbed = values({ birthDate: date('1980-05-01') });
    expect(
      mergeFieldPatch(kept, absorbed, {
        address: 'ABSORBED',
        birthDate: 'ABSORBED',
      }),
    ).toEqual({
      patch: { address: null, countryCode: null, cityId: null },
      groups: ['address'],
    });
  });
});
