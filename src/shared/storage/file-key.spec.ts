import {
  assertFileKey,
  isFileKey,
  legacyUrlToKey,
  publicFileUrl,
} from './file-key';

describe('claves de fichero (DX-084)', () => {
  it('acepta <espacio>/<nombre> y rechaza rutas, absolutos y nombres raros', () => {
    expect(isFileKey('avatars/u1.png')).toBe(true);
    expect(isFileKey('clinical/t1/x-ray_01.webp')).toBe(true);
    for (const bad of [
      '',
      'u1.png',
      '/avatars/u1.png',
      'avatars/../secret',
      'avatars/./u1.png',
      'avatars//u1.png',
      'avatars/u1 png',
      'Avatars/u1.png',
      'https://h/api/v1/files/avatars/u1.png',
    ]) {
      expect(isFileKey(bad)).toBe(false);
    }
    expect(() => assertFileKey('avatars/../x')).toThrow('Clave de fichero');
  });

  it('la URL pública es la base actual + la clave (sin barras dobles)', () => {
    expect(
      publicFileUrl('https://api.a.app/api/v1/files/', 'avatars/u1.png'),
    ).toBe('https://api.a.app/api/v1/files/avatars/u1.png');
    expect(publicFileUrl('https://api.b.app/files', 'avatars/u1.png')).toBe(
      'https://api.b.app/files/avatars/u1.png',
    );
  });

  it('legacyUrlToKey: una URL absoluta de avatar antigua pasa a su clave', () => {
    expect(
      legacyUrlToKey('http://localhost:3000/api/v1/files/avatars/u1.jpg'),
    ).toBe('avatars/u1.jpg');
    expect(legacyUrlToKey('avatars/u1.jpg')).toBe('avatars/u1.jpg');
    expect(legacyUrlToKey('https://otro.cdn/foto.png')).toBeNull();
    expect(legacyUrlToKey('no es una url')).toBeNull();
  });
});
