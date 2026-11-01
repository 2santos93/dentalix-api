import {
  CLINIC_SETTINGS_MESSAGES as M,
  isFiscalDataPending,
  parseClinicProfilePatch,
} from './clinic-settings';

describe('datos de la clínica (DX-019)', () => {
  it('un campo ausente no cambia; vacío o null lo borra; se recorta', () => {
    expect(parseClinicProfilePatch({})).toEqual({ ok: true, patch: {} });
    expect(
      parseClinicProfilePatch({
        legalName: '  Sonrisas S.A.  ',
        taxId: '',
        taxIdLabel: null,
      }),
    ).toEqual({
      ok: true,
      patch: { legalName: 'Sonrisas S.A.', taxId: null, taxIdLabel: null },
    });
  });

  it('el identificador fiscal es texto libre, sin formato de ningún país', () => {
    for (const taxId of [
      'J-12345678-9',
      '900.123.456-7',
      'B12345678',
      '12-3456789',
      'ÑANDÚ/ß 001',
      'x',
    ]) {
      expect(parseClinicProfilePatch({ taxId })).toEqual({
        ok: true,
        patch: { taxId },
      });
    }
    expect(parseClinicProfilePatch({ taxIdLabel: 'ID fiscal' })).toEqual({
      ok: true,
      patch: { taxIdLabel: 'ID fiscal' },
    });
  });

  it('topes y una sola línea', () => {
    expect(parseClinicProfilePatch({ taxId: 'x'.repeat(65) })).toEqual({
      ok: false,
      message: M.taxId,
    });
    expect(parseClinicProfilePatch({ taxIdLabel: 'x'.repeat(41) })).toEqual({
      ok: false,
      message: M.taxIdLabel,
    });
    expect(parseClinicProfilePatch({ legalName: 'a\nb' })).toEqual({
      ok: false,
      message: M.legalName,
    });
    expect(parseClinicProfilePatch({ fiscalAddress: 'x'.repeat(251) })).toEqual(
      {
        ok: false,
        message: M.fiscalAddress,
      },
    );
    expect(parseClinicProfilePatch({ fiscalAddress: 'x'.repeat(250) }).ok).toBe(
      true,
    );
    expect(
      parseClinicProfilePatch({ contactPhone: '+1 (555) 010-0000 ext. 12' }).ok,
    ).toBe(true);
    expect(parseClinicProfilePatch({ contactPhone: '1'.repeat(41) })).toEqual({
      ok: false,
      message: M.contactPhone,
    });
    // Los topes cuentan caracteres (como char_length), no unidades UTF-16.
    expect(parseClinicProfilePatch({ taxIdLabel: '😀'.repeat(40) }).ok).toBe(
      true,
    );
  });

  it('el nombre comercial es obligatorio', () => {
    expect(parseClinicProfilePatch({ name: '  ' })).toEqual({
      ok: false,
      message: M.name,
    });
    expect(parseClinicProfilePatch({ name: null })).toEqual({
      ok: false,
      message: M.name,
    });
    expect(parseClinicProfilePatch({ name: 'x'.repeat(121) })).toEqual({
      ok: false,
      message: M.name,
    });
    expect(parseClinicProfilePatch({ name: ' Clínica Sonrisas ' })).toEqual({
      ok: true,
      patch: { name: 'Clínica Sonrisas' },
    });
  });

  it('email: forma nombre@dominio sin espacios; vacío lo borra', () => {
    expect(
      parseClinicProfilePatch({ contactEmail: 'hola@clinica.example' }).ok,
    ).toBe(true);
    expect(
      parseClinicProfilePatch({ contactEmail: 'recepción@clínica.example' }).ok,
    ).toBe(true);
    expect(parseClinicProfilePatch({ contactEmail: '' })).toEqual({
      ok: true,
      patch: { contactEmail: null },
    });
    for (const bad of ['hola', 'a b@c.d', '@x', 'a@', 'a@@b']) {
      expect(parseClinicProfilePatch({ contactEmail: bad })).toEqual({
        ok: false,
        message: M.contactEmail,
      });
    }
  });

  it('color: hexadecimal de seis cifras, en mayúsculas; no se puede borrar', () => {
    expect(parseClinicProfilePatch({ primaryColor: '#0e7490' })).toEqual({
      ok: true,
      patch: { primaryColor: '#0E7490' },
    });
    for (const bad of ['#fff', '0E7490', 'red', '#0E7490;}body{', '', null]) {
      expect(parseClinicProfilePatch({ primaryColor: bad })).toEqual({
        ok: false,
        message: M.primaryColor,
      });
    }
  });

  it('pendientes: sin razón social o sin identificador', () => {
    expect(isFiscalDataPending({ legalName: null, taxId: null })).toBe(true);
    expect(isFiscalDataPending({ legalName: 'S.A.', taxId: null })).toBe(true);
    expect(isFiscalDataPending({ legalName: null, taxId: '1' })).toBe(true);
    expect(isFiscalDataPending({ legalName: 'S.A.', taxId: '1' })).toBe(false);
  });
});
