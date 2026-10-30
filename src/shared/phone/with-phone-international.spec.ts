import { withPhoneInternational } from './with-phone-international';

describe('withPhoneInternational (DX-387)', () => {
  it('adds the international format read with the given region and keeps the rest', () => {
    const item = { id: 'p1', phone: '0412-1234567', email: null };
    expect(withPhoneInternational(item, 'VE')).toEqual({
      id: 'p1',
      phone: '0412-1234567',
      email: null,
      phoneInternational: '+58 412 1234567',
    });
  });

  it('a number with + keeps its own code whatever the region', () => {
    expect(
      withPhoneInternational({ phone: '+573105550101' }, 'VE')
        .phoneInternational,
    ).toBe('+57 310 5550101');
  });

  it('no phone, an unreadable one or no region give null and the stored phone stays as is', () => {
    expect(withPhoneInternational({ phone: null }, 'VE')).toEqual({
      phone: null,
      phoneInternational: null,
    });
    expect(withPhoneInternational({ phone: 'llamar a casa' }, 'VE')).toEqual({
      phone: 'llamar a casa',
      phoneInternational: null,
    });
    expect(
      withPhoneInternational({ phone: '0412-1234567' }, null)
        .phoneInternational,
    ).toBeNull();
  });

  it('does not mutate the item', () => {
    const item = { phone: '0412-1234567' };
    withPhoneInternational(item, 'VE');
    expect(item).toEqual({ phone: '0412-1234567' });
  });
});
