import { renderLayout } from './layout';

const base = {
  subject: 'Asunto',
  heading: 'Hola',
  blocks: [{ kind: 'paragraph' as const, text: 'Primera línea del email.' }],
  action: { label: 'Abrir', url: 'https://demo.dentalix.app/x' },
};

describe('renderLayout · diseño', () => {
  it('con un color de marca oscuro, el botón lleva texto blanco y los enlaces ese color', () => {
    const { html } = renderLayout({
      ...base,
      brand: { clinicName: 'Sonrisas', logoUrl: null, primaryColor: '#0E7490' },
      links: {
        lead: 'Más:',
        items: [{ label: 'Uno', url: 'https://a.dentalix.app' }],
      },
    });
    expect(html).toMatch(/background:#0E7490;color:#FFFFFF/);
    expect(html).toContain('style="color:#0E7490;font-weight:600');
  });

  it('con un color de marca claro, el botón y los enlaces usan tinta para que se lean', () => {
    const { html } = renderLayout({
      ...base,
      brand: { clinicName: 'Sonrisas', logoUrl: null, primaryColor: '#F5C542' },
      links: {
        lead: 'Más:',
        items: [{ label: 'Uno', url: 'https://a.dentalix.app' }],
      },
    });
    expect(html).toMatch(/background:#F5C542;color:#151C26/);
    expect(html).not.toContain('style="color:#F5C542');
  });

  it('sin logo, monograma con la inicial del remitente', () => {
    const { html } = renderLayout({
      ...base,
      brand: { clinicName: 'ñandú Dental', logoUrl: null, primaryColor: null },
    });
    expect(html).toMatch(/>Ñ<\/td>/);
  });

  it('texto de vista previa oculto con el primer párrafo, escapado y recortado', () => {
    const long = `<b>x</b> ${'a'.repeat(300)}`;
    const { html, text } = renderLayout({
      ...base,
      brand: null,
      blocks: [{ kind: 'paragraph', text: long }],
    });
    const preheader =
      /<div style="display:none[^>]*>([^<]*)/.exec(html)?.[1] ?? '';
    expect(preheader.startsWith('&lt;b&gt;x&lt;/b&gt; aaa')).toBe(true);
    expect(preheader).toContain('…');
    expect(text).not.toContain('…');
  });

  it('declara solo modo claro para que el cliente no invierta la marca', () => {
    const { html } = renderLayout({ ...base, brand: null });
    expect(html).toContain('<meta name="color-scheme" content="light only" />');
  });
});
