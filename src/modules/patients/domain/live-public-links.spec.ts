import {
  LIVE_PUBLIC_LINK_KINDS,
  NO_LIVE_PUBLIC_LINKS,
  totalLivePublicLinks,
} from './live-public-links';

describe('enlaces públicos vivos de un paciente (DX-461)', () => {
  it('cubre la oferta de hueco, las dos firmas a distancia, la copia del PDF, la anamnesis y el enlace de pago', () => {
    expect([...LIVE_PUBLIC_LINK_KINDS]).toEqual([
      'slotOffers',
      'consentSignatures',
      'budgetSignatures',
      'signedPdfCopies',
      'anamnesis',
      'paymentLinks',
    ]);
  });

  it('el total suma todos los tipos', () => {
    expect(totalLivePublicLinks(NO_LIVE_PUBLIC_LINKS)).toBe(0);
    expect(
      totalLivePublicLinks({
        slotOffers: 1,
        consentSignatures: 2,
        budgetSignatures: 3,
        signedPdfCopies: 4,
        anamnesis: 5,
        paymentLinks: 6,
      }),
    ).toBe(21);
  });
});
