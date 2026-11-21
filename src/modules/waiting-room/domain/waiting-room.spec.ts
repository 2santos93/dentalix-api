import { WaitingRoomNameMode } from '@prisma/client';
import {
  boardKey,
  displayLabel,
  nameInitialLabel,
  normalizeScreenMessages,
  normalizeScreenName,
  screenMessagesError,
  screenNameError,
  turnLabel,
} from './waiting-room';

describe('pantalla de sala de espera: reglas (DX-588)', () => {
  describe('modo de nombre «Nombre e inicial»', () => {
    it.each([
      ['Ana', 'Rodríguez', 'Ana R.'],
      ['Ana María', 'Rodríguez Pérez', 'Ana R.'],
      ['  José  ', '  pérez ', 'José P.'],
      ['Ñángara', 'Ñúñez', 'Ñángara Ñ.'],
      ['Luis', 'Álvarez', 'Luis Á.'],
      ['Carmen', null, 'Carmen'],
      ['Carmen', '   ', 'Carmen'],
      [null, 'Blanco', 'B.'],
      [null, null, 'Paciente'],
      ['', '', 'Paciente'],
    ])('%p %p → %p', (first, last, expected) => {
      expect(nameInitialLabel(first, last)).toBe(expected);
    });

    it('nunca devuelve el apellido entero ni el segundo nombre', () => {
      const label = nameInitialLabel('María José', 'González Hernández');
      expect(label).toBe('María G.');
      expect(label).not.toContain('José');
      expect(label).not.toContain('González');
    });
  });

  describe('modo «Número de turno»', () => {
    it('«Turno N», y «Turno —» sin número', () => {
      expect(turnLabel(7)).toBe('Turno 7');
      expect(turnLabel(null)).toBe('Turno —');
    });

    it('displayLabel en modo turno no usa el nombre', () => {
      const person = { firstName: 'Ana', lastName: 'Rodríguez', turnNumber: 3 };
      expect(displayLabel(WaitingRoomNameMode.TURN_NUMBER, person)).toBe(
        'Turno 3',
      );
      expect(
        displayLabel(WaitingRoomNameMode.TURN_NUMBER, {
          ...person,
          turnNumber: null,
        }),
      ).not.toMatch(/Ana|Rodr/);
      expect(displayLabel(WaitingRoomNameMode.NAME_INITIAL, person)).toBe(
        'Ana R.',
      );
    });
  });

  describe('clave del tablero', () => {
    const screen = '0b9a3c0e-6a3e-4c2a-9a0b-2f6d1f1a9e11';
    const appointment = '6a1f5c7e-3b2d-4f0a-8e9c-1d2b3a4c5d6e';

    it('es estable, opaca y de 16 hex', () => {
      const key = boardKey(screen, appointment);
      expect(key).toMatch(/^[0-9a-f]{16}$/);
      expect(boardKey(screen, appointment)).toBe(key);
      expect(key).not.toContain(appointment.slice(0, 8));
    });

    it('otra pantalla da otra clave para la misma cita', () => {
      expect(boardKey(screen, appointment)).not.toBe(
        boardKey('1c2d3e4f-0000-4000-8000-000000000000', appointment),
      );
    });
  });

  describe('nombre y mensajes', () => {
    it('el nombre se recorta y colapsa espacios', () => {
      expect(normalizeScreenName('  Televisor   de la sala ')).toBe(
        'Televisor de la sala',
      );
    });

    it.each([
      ['', 'Escribe un nombre para la pantalla.'],
      ['   ', 'Escribe un nombre para la pantalla.'],
      ['x'.repeat(61), 'El nombre de la pantalla admite hasta 60 caracteres.'],
      [
        'TV\u0007',
        'El nombre de la pantalla no puede tener caracteres de control.',
      ],
    ])('nombre %p → %p', (name, message) => {
      expect(screenNameError(name)).toBe(message);
    });

    it('acepta 60 caracteres (por punto de código)', () => {
      expect(screenNameError('ñ'.repeat(60))).toBeNull();
    });

    it('los mensajes vacíos se descartan y se valida el tope', () => {
      expect(normalizeScreenMessages(['  Hola  ', '', '   '])).toEqual([
        'Hola',
      ]);
      expect(screenMessagesError(['a', 'b', 'c', 'd', 'e'])).toBeNull();
      expect(screenMessagesError(['a', 'b', 'c', 'd', 'e', 'f'])).toBe(
        'Puedes poner hasta 5 mensajes.',
      );
      expect(screenMessagesError(['x'.repeat(141)])).toBe(
        'Cada mensaje admite hasta 140 caracteres.',
      );
      expect(screenMessagesError(['línea\notra'])).toBe(
        'Los mensajes no pueden tener saltos de línea ni caracteres de control.',
      );
    });
  });
});
