import { NotFoundException } from '@nestjs/common';
import { AppointmentStatus, WaitingRoomNameMode } from '@prisma/client';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { hashPublicLinkToken } from '../../../shared/public-links/public-link-token';
import type {
  BoardRow,
  ScreenForBoard,
  WaitingRoomRepository,
} from '../domain/ports/waiting-room-repository.port';
import { PublicWaitingRoomUseCases } from './public-waiting-room.use-cases';

const TENANT = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'a'.repeat(43);
const NOW = new Date('2026-11-21T15:00:00.000Z'); // 11:00 en Caracas
const MIN = 60_000;

function screen(overrides: Partial<ScreenForBoard> = {}): ScreenForBoard {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    locationId: '33333333-3333-4333-8333-333333333333',
    name: 'Televisor de la sala',
    nameMode: WaitingRoomNameMode.NAME_INITIAL,
    messages: ['Horario: lunes a viernes de 8:00 a 17:00'],
    soundEnabled: false,
    revokedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    location: {
      id: '33333333-3333-4333-8333-333333333333',
      name: 'Sede Chacao',
      timeZone: 'America/Caracas',
      locale: 'es-VE',
      hourCycle: 'h23',
      live: true,
    },
    ...overrides,
  };
}

function row(overrides: Partial<BoardRow>): BoardRow {
  return {
    appointmentId: '44444444-4444-4444-8444-444444444444',
    status: AppointmentStatus.ARRIVED,
    firstName: 'Ana',
    lastName: 'Rodríguez',
    turnNumber: 1,
    start: new Date(NOW.getTime() - 60 * MIN),
    arrivedAt: new Date(NOW.getTime() - 20 * MIN),
    seatedAt: null,
    chairName: null,
    providerName: 'Dra. María González',
    ...overrides,
  };
}

function setup(found: ScreenForBoard | null, rows: BoardRow[] = []) {
  const findForBoardByTokenHash = jest.fn().mockResolvedValue(found);
  const boardRows = jest.fn().mockResolvedValue(rows);
  const repo = {
    findForBoardByTokenHash,
    boardRows,
  } as unknown as WaitingRoomRepository;
  const tenant = new TenantContextService();
  const useCases = new PublicWaitingRoomUseCases(repo, tenant, () => NOW);
  const run = (token = TOKEN, tenantId: string | null = TENANT) =>
    tenantId
      ? tenant.run(tenantId, () => useCases.board(token))
      : useCases.board(token);
  return { findForBoardByTokenHash, boardRows, run };
}

describe('PublicWaitingRoomUseCases (DX-588)', () => {
  it('busca por el HASH del token, nunca por el token', async () => {
    const { findForBoardByTokenHash, run } = setup(screen());
    await run();
    expect(findForBoardByTokenHash).toHaveBeenCalledWith(
      hashPublicLinkToken(TOKEN),
    );
  });

  it.each([
    ['token mal formado', 'corto', TENANT, screen()],
    ['host sin clínica', TOKEN, null, screen()],
    ['desconocido u otra clínica', TOKEN, TENANT, null],
    ['revocada', TOKEN, TENANT, screen({ revokedAt: NOW })],
    [
      'sede retirada',
      TOKEN,
      TENANT,
      screen({ location: { ...screen().location, live: false } }),
    ],
    [
      'sede sin zona',
      TOKEN,
      TENANT,
      screen({ location: { ...screen().location, timeZone: null } }),
    ],
  ])('%s → el mismo 404', async (_case, token, tenantId, found) => {
    const { run } = setup(found);
    const error = await run(token, tenantId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getResponse()).toEqual({
      statusCode: 404,
      error: 'Not Found',
      code: 'WAITING_ROOM_SCREEN_INACTIVE',
      message: 'Esta pantalla ya no está activa.',
    });
  });

  it('lee las citas del día de la sede y separa en espera / pasando', async () => {
    const { boardRows, run } = setup(screen(), [
      row({
        appointmentId: '55555555-5555-4555-8555-555555555555',
        firstName: 'José',
        lastName: 'Pérez',
        arrivedAt: new Date(NOW.getTime() - 5 * MIN),
      }),
      row({}),
      row({
        appointmentId: '66666666-6666-4666-8666-666666666666',
        status: AppointmentStatus.IN_CHAIR,
        firstName: 'Carmen',
        lastName: 'Blanco',
        seatedAt: new Date(NOW.getTime() - 2 * MIN),
        chairName: 'Sillón 2',
      }),
    ]);
    const board = await run();
    // Día civil de Caracas: 21 de noviembre, 04:00Z → 04:00Z del 22.
    expect(boardRows).toHaveBeenCalledWith({
      locationId: '33333333-3333-4333-8333-333333333333',
      from: new Date('2026-11-21T04:00:00.000Z'),
      to: new Date('2026-11-22T04:00:00.000Z'),
    });
    expect(board.waiting.map((w) => [w.label, w.minutesWaiting])).toEqual([
      ['Ana R.', 20],
      ['José P.', 5],
    ]);
    expect(board.called[0].key).toMatch(/^[0-9a-f]{16}$/);
    expect(board.called).toEqual([
      {
        key: board.called[0].key,
        label: 'Carmen B.',
        chairName: 'Sillón 2',
        providerName: 'Dra. María González',
        minutesSinceCalled: 2,
      },
    ]);
    expect(board).toMatchObject({
      waitingTotal: 2,
      calledTotal: 1,
      timeZone: 'America/Caracas',
      locale: 'es-VE',
      hourCycle: 'h23',
      refreshSeconds: 8,
    });
  });

  it('LISTA BLANCA: ni una clave de más (tablero y filas)', async () => {
    const { run } = setup(screen(), [
      row({}),
      row({
        appointmentId: '66666666-6666-4666-8666-666666666666',
        status: AppointmentStatus.IN_CHAIR,
        seatedAt: NOW,
      }),
    ]);
    const board = JSON.parse(JSON.stringify(await run())) as Record<
      string,
      unknown
    >;
    expect(Object.keys(board).sort()).toEqual([
      'called',
      'calledTotal',
      'hourCycle',
      'locale',
      'locationName',
      'messages',
      'nameMode',
      'now',
      'refreshSeconds',
      'screenName',
      'soundEnabled',
      'timeZone',
      'waiting',
      'waitingTotal',
    ]);
    expect(
      Object.keys((board.waiting as Record<string, unknown>[])[0]).sort(),
    ).toEqual(['key', 'label', 'minutesWaiting']);
    expect(
      Object.keys((board.called as Record<string, unknown>[])[0]).sort(),
    ).toEqual([
      'chairName',
      'key',
      'label',
      'minutesSinceCalled',
      'providerName',
    ]);
    const text = JSON.stringify(board);
    expect(text).not.toContain('44444444');
    expect(text).not.toContain('Rodríguez');
  });

  it('modo turno: «Turno N» y ningún nombre', async () => {
    const { run } = setup(
      screen({ nameMode: WaitingRoomNameMode.TURN_NUMBER }),
      [
        row({ turnNumber: 7 }),
        row({
          appointmentId: '66666666-6666-4666-8666-666666666666',
          status: AppointmentStatus.IN_CHAIR,
          firstName: 'Carmen',
          lastName: 'Blanco',
          turnNumber: null,
          seatedAt: NOW,
        }),
      ],
    );
    const board = await run();
    expect(board.waiting[0].label).toBe('Turno 7');
    expect(board.called[0].label).toBe('Turno —');
    expect(JSON.stringify(board)).not.toMatch(/Ana|Rodr|Carmen|Blanco/);
  });

  it('recorta cada columna a 40 pero informa del total', async () => {
    const many = Array.from({ length: 45 }, (_, i) =>
      row({
        appointmentId: `44444444-4444-4444-8444-${String(i).padStart(12, '0')}`,
        arrivedAt: new Date(NOW.getTime() - (50 - i) * MIN),
      }),
    );
    const board = await setup(screen(), many).run();
    expect(board.waiting).toHaveLength(40);
    expect(board.waitingTotal).toBe(45);
  });
});
