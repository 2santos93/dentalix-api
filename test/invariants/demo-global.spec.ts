import { DEMO_PRIVACY_POLICY } from '../../prisma/demo/data';

// DX-335 (G6.1): la demo es una clínica de varios países y nada de ella
// presupone uno. Este fichero reúne los invariantes de esos datos; cada tarea
// de DX-335 añade aquí los suyos. Corre en `npm test` (`test/invariants` está
// en `roots` de jest) y no necesita base de datos.

describe('demo global (DX-335)', () => {
  it('the demo privacy policy is the DX-325 neutral template', () => {
    const texts = [
      DEMO_PRIVACY_POLICY.policyText,
      DEMO_PRIVACY_POLICY.generalText,
      DEMO_PRIVACY_POLICY.sensitiveHealthText,
      DEMO_PRIVACY_POLICY.marketingText,
    ];
    for (const text of texts) {
      expect(text).not.toContain('[');
      expect(text).not.toContain(']');
      expect(text).not.toMatch(/titular|autoridad|normativa|seg[uú]n la ley/i);
    }
    expect(
      DEMO_PRIVACY_POLICY.policyText.startsWith('Responsable del tratamiento'),
    ).toBe(true);
  });
});
