import {
  checkExternalOrderTemplate,
  externalOrderTemplateSnapshot,
  templateNameKey,
} from './external-order-template';

describe('plantillas de órdenes externas (DX-572)', () => {
  const ok = {
    name: '  Radiografía   panorámica ',
    kind: 'IMAGING',
    recipient: '   ',
    items: ['Radiografía panorámica'],
    active: true,
  };

  it('normaliza el nombre y deja el destinatario vacío en null', () => {
    expect(checkExternalOrderTemplate(ok)).toEqual({
      ok: true,
      value: {
        name: 'Radiografía panorámica',
        kind: 'IMAGING',
        recipient: null,
        items: ['Radiografía panorámica'],
        active: true,
      },
    });
  });

  it('dice todo lo que falla', () => {
    const check = checkExternalOrderTemplate({
      name: 'x'.repeat(81),
      kind: 'RX',
      recipient: 'y'.repeat(121),
      items: [],
      active: 'sí',
    });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.errors).toHaveLength(5);
  });

  it('nombre único sin mayúsculas ni espacios repetidos', () => {
    expect(templateNameKey(' Tomografía  de haz CÓNICO')).toBe(
      templateNameKey('tomografía de haz cónico'),
    );
  });

  it('la auditoría guarda nombre, tipo, activa y cuántos estudios; destinatario y estudios solo como campos ocultos', () => {
    expect(
      externalOrderTemplateSnapshot({
        name: 'Panorámica',
        kind: 'IMAGING',
        recipient: 'Centro de Imagen del Este',
        items: ['Radiografía panorámica', 'Periapical'],
        active: true,
      }),
    ).toMatchObject({
      name: 'Panorámica',
      kind: 'IMAGING',
      active: true,
      itemCount: 2,
    });
  });
});
