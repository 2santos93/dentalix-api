import { splitFileUrl } from './avatar-url.util';

describe('splitFileUrl', () => {
  it('extracts namespace + filename from a files url', () => {
    expect(splitFileUrl('http://h/api/v1/files/avatars/u1.png')).toEqual({
      namespace: 'avatars',
      filename: 'u1.png',
    });
  });
  it('returns null for a malformed url', () => {
    expect(splitFileUrl('not a url')).toBeNull();
  });
});
