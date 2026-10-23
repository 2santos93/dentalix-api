import {
  IMMUTABLE_CACHE_CONTROL,
  REVALIDATE_CACHE_CONTROL,
  avatarCacheControl,
} from './public-file-cache';

describe('avatarCacheControl (DX-259, OPS-039)', () => {
  it('un avatar con versión se cachea un año como immutable', () => {
    expect(avatarCacheControl('u1-0123456789abcdef.png')).toBe(
      IMMUTABLE_CACHE_CONTROL,
    );
    expect(IMMUTABLE_CACHE_CONTROL).toBe('public, max-age=31536000, immutable');
  });

  it('uno de antes (sin versión) solo 5 minutos y luego revalida', () => {
    for (const name of ['u1.png', 'u1-0123.png', 'u1-0123456789ABCDEF.png']) {
      expect(avatarCacheControl(name)).toBe(REVALIDATE_CACHE_CONTROL);
    }
  });
});
