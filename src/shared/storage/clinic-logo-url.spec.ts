import {
  clinicLogoKeyToFreeze,
  clinicLogoPublicUrl,
  withClinicLogoUrl,
} from './clinic-logo-url';

describe('URL del logo de la clínica (DX-019, DX-084)', () => {
  const previous = process.env.FILES_PUBLIC_BASE_URL;
  beforeAll(() => {
    process.env.FILES_PUBLIC_BASE_URL = 'https://api.example/api/v1/files/';
  });
  afterAll(() => {
    process.env.FILES_PUBLIC_BASE_URL = previous;
  });

  it('la clave se resuelve con la base VIGENTE', () => {
    expect(clinicLogoPublicUrl('logos/a-0123456789abcdef.png')).toBe(
      'https://api.example/api/v1/files/logos/a-0123456789abcdef.png',
    );
    process.env.FILES_PUBLIC_BASE_URL = 'https://nuevo.example/files';
    expect(clinicLogoPublicUrl('logos/a-0123456789abcdef.png')).toBe(
      'https://nuevo.example/files/logos/a-0123456789abcdef.png',
    );
  });

  it('una URL anterior sale tal cual; otro espacio del almacén o basura, null', () => {
    expect(clinicLogoPublicUrl('https://cdn.example/l.png')).toBe(
      'https://cdn.example/l.png',
    );
    expect(clinicLogoPublicUrl('avatars/u1.png')).toBeNull();
    expect(clinicLogoPublicUrl('patients/p1/rx.png')).toBeNull();
    expect(clinicLogoPublicUrl('javascript:alert(1)')).toBeNull();
    expect(clinicLogoPublicUrl(null)).toBeNull();
  });

  it('cambia logoKey por logoUrl en la fila', () => {
    expect(withClinicLogoUrl({ name: 'A', logoKey: null })).toEqual({
      name: 'A',
      logoUrl: null,
    });
    expect(withClinicLogoUrl(null)).toBeNull();
  });

  it('DX-019-bis (B): un documento emitido congela la clave o la URL anterior; lo que no se pinta, null', () => {
    expect(clinicLogoKeyToFreeze('logos/a-0123456789abcdef.png')).toBe(
      'logos/a-0123456789abcdef.png',
    );
    expect(clinicLogoKeyToFreeze('HTTPS://cdn.example/l.png')).toBe(
      'HTTPS://cdn.example/l.png',
    );
    expect(clinicLogoKeyToFreeze('logos/../x.png')).toBeNull();
    expect(clinicLogoKeyToFreeze('logos/a/b.png')).toBeNull();
    expect(clinicLogoKeyToFreeze('avatars/u1.png')).toBeNull();
    expect(clinicLogoKeyToFreeze('ftp://cdn.example/l.png')).toBeNull();
    expect(clinicLogoKeyToFreeze('')).toBeNull();
    expect(clinicLogoKeyToFreeze(null)).toBeNull();
  });
});
