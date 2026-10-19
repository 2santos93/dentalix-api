import { InMemoryFileStorage } from '../../../shared/storage/__fixtures__/in-memory-file-storage';
import { avatarPublicUrl } from './avatar-url.util';

describe('avatarPublicUrl (DX-084)', () => {
  it('calcula la URL con la base vigente a partir de la clave guardada', () => {
    const storage = new InMemoryFileStorage('https://api.a.app/api/v1/files');
    expect(avatarPublicUrl(storage, 'avatars/u1.png')).toBe(
      'https://api.a.app/api/v1/files/avatars/u1.png',
    );
  });

  it('una URL absoluta de antes de DX-084 sale con la base vigente, no con la guardada', () => {
    const storage = new InMemoryFileStorage('https://api.b.app/files');
    expect(
      avatarPublicUrl(
        storage,
        'http://localhost:3000/api/v1/files/avatars/u1.jpg',
      ),
    ).toBe('https://api.b.app/files/avatars/u1.jpg');
  });

  it('null sin avatar o con un valor irreconocible', () => {
    const storage = new InMemoryFileStorage();
    expect(avatarPublicUrl(storage, null)).toBeNull();
    expect(avatarPublicUrl(storage, 'basura')).toBeNull();
  });
});
