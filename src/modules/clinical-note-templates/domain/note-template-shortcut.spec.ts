import {
  findShortcutConflict,
  normalizeShortcut,
  NOTE_SHORTCUT_FORMAT_MESSAGE,
  shortcutConflictMessage,
  shortcutFormatError,
  shortcutKey,
  type ShortcutHolder,
} from './note-template-shortcut';

// DX-455: formato, normalización y regla de prefijos de los atajos.
describe('Atajos de plantillas (DX-455)', () => {
  describe('formato', () => {
    it.each([
      '#re',
      '#resina',
      '#Resina-Compuesta',
      '#endo_2',
      '#extracción',
      '#ÑANDÚ',
      '#코드',
      '#эндо',
      '#12',
      `#${'a'.repeat(30)}`,
    ])('acepta %s', (shortcut) => {
      expect(shortcutFormatError(normalizeShortcut(shortcut))).toBeNull();
    });

    it.each([
      ['sin #', 'resina'],
      ['solo #', '#'],
      ['un carácter', '#r'],
      ['31 caracteres', `#${'a'.repeat(31)}`],
      ['espacio dentro', '#resina compuesta'],
      ['dos #', '#re#sina'],
      ['signos', '#resina!'],
      ['punto', '#re.sina'],
      ['emoji', '#resina😀'],
    ])('rechaza %s', (_case, shortcut) => {
      expect(shortcutFormatError(normalizeShortcut(shortcut))).toBe(
        NOTE_SHORTCUT_FORMAT_MESSAGE,
      );
    });

    it('recorta los espacios de los bordes y lleva a NFC', () => {
      const decomposed = '#extracción';
      const normalized = normalizeShortcut(`  ${decomposed} `);
      expect(normalized).toBe('#extracción');
      expect(normalized).toHaveLength('#extracción'.length);
    });

    it('la clave no distingue mayúsculas (tampoco con tildes)', () => {
      expect(shortcutKey('#RESINA')).toBe(shortcutKey('#resina'));
      expect(shortcutKey('#ExtracCIÓN')).toBe('#extracción');
    });
  });

  describe('choques', () => {
    const holders: ShortcutHolder[] = [
      { id: 't1', name: 'Resina compuesta', shortcut: '#resina' },
      { id: 't2', name: 'Endodoncia', shortcut: '#Endo' },
    ];

    it('duplicado exacto sin distinguir mayúsculas', () => {
      const conflict = findShortcutConflict('#RESINA', holders);
      expect(conflict).toEqual({ kind: 'DUPLICATE', holder: holders[0] });
      expect(shortcutConflictMessage('#RESINA', conflict!)).toBe(
        'El atajo #RESINA ya lo usa la plantilla «Resina compuesta».',
      );
    });

    it('el nuevo es prefijo de otro (#re frente a #resina)', () => {
      const conflict = findShortcutConflict('#re', holders);
      expect(conflict).toEqual({ kind: 'PREFIX', holder: holders[0] });
      expect(shortcutConflictMessage('#re', conflict!)).toBe(
        'El atajo #re choca con #resina: uno no puede empezar por el otro.',
      );
    });

    it('otro es prefijo del nuevo (#endodoncia frente a #Endo)', () => {
      expect(findShortcutConflict('#endodoncia', holders)).toEqual({
        kind: 'PREFIX',
        holder: holders[1],
      });
    });

    it('el duplicado gana al prefijo', () => {
      const both: ShortcutHolder[] = [
        { id: 'a', name: 'Corta', shortcut: '#res' },
        { id: 'b', name: 'Larga', shortcut: '#resina' },
      ];
      expect(findShortcutConflict('#resina', both)?.kind).toBe('DUPLICATE');
    });

    it('sin choque: atajos que comparten comienzo pero ninguno empieza por el otro', () => {
      expect(findShortcutConflict('#resto', holders)).toBeNull();
      expect(findShortcutConflict('#end', [])).toBeNull();
    });
  });
});
