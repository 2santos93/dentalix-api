import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const svc = new PasswordService();

  it('hashes and verifies a password', async () => {
    const hash = await svc.hash('S3cret!');
    expect(hash).not.toBe('S3cret!');
    expect(await svc.verify('S3cret!', hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await svc.hash('S3cret!');
    expect(await svc.verify('wrong', hash)).toBe(false);
  });
});
