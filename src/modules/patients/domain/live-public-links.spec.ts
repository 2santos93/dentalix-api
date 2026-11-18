import {
  LIVE_PUBLIC_LINK_KINDS,
  NO_LIVE_PUBLIC_LINKS,
  totalLivePublicLinks,
} from './live-public-links';

describe('enlaces públicos vivos de un paciente (DX-461)', () => {
  it('cubre la oferta de hueco, las dos firmas a distancia, la copia del PDF, la anamnesis y las copias de la receta (DX-468) y del certificado (DX-306) el enlace de pago (DX-569) y la copia de la orden externa (DX-572)', () => {
    expect([...LIVE_PUBLIC_LINK_KINDS]).toEqual([
      'slotOffers',
      'consentSignatures',
      'budgetSignatures',
      'signedPdfCopies',
      'anamnesis',
      'prescriptionCopies',
      'certificateCopies',
      'paymentLinks',
      'externalOrderCopies',
      'patientAccessLinks',
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
        prescriptionCopies: 6,
        certificateCopies: 7,
        paymentLinks: 8,
        externalOrderCopies: 9,
        patientAccessLinks: 10,
      }),
    ).toBe(55);
  });
});
