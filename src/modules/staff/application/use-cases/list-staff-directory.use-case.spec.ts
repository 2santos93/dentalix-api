import { ClinicRole } from '@prisma/client';
import { ListStaffDirectoryUseCase } from './list-staff-directory.use-case';
import { StaffMember } from '../../domain/entities/staff-member.entity';
import { StaffRepository } from '../../domain/ports/staff-repository.port';
import {
  StaffDirectoryPage,
  StaffDirectoryQuery,
} from '../../domain/entities/staff-directory-entry.entity';

function makeRepo(overrides: Partial<StaffRepository> = {}): StaffRepository {
  return {
    listActive: (): Promise<StaffMember[]> => Promise.resolve([]),
    listDirectory: (): Promise<StaffDirectoryPage> =>
      Promise.resolve({ items: [], total: 0, page: 1, pageSize: 20 }),
    findById: (): Promise<StaffMember | null> => Promise.resolve(null),
    findDetailById: (): Promise<
      (StaffMember & { status: 'ACTIVE' | 'INACTIVE' }) | null
    > => Promise.resolve(null),
    updateById: (): Promise<StaffMember | null> => Promise.resolve(null),
    deactivateById: (): Promise<boolean> => Promise.resolve(false),
    reactivateById: (): Promise<StaffMember | null> => Promise.resolve(null),
    countActiveAdmins: (): Promise<number> => Promise.resolve(0),
    ...overrides,
  };
}

describe('ListStaffDirectoryUseCase', () => {
  it('pasa los filtros al repositorio tal cual', async () => {
    let recibido: StaffDirectoryQuery | undefined;
    const repo = makeRepo({
      listDirectory: (q) => {
        recibido = q;
        return Promise.resolve({ items: [], total: 0, page: 2, pageSize: 10 });
      },
    });

    await new ListStaffDirectoryUseCase(repo).execute({
      page: 2,
      pageSize: 10,
      search: 'ana',
      role: ClinicRole.DENTIST,
      status: 'PENDING',
    });

    expect(recibido).toEqual({
      page: 2,
      pageSize: 10,
      search: 'ana',
      role: ClinicRole.DENTIST,
      status: 'PENDING',
    });
  });

  it('descarta una búsqueda que es solo espacios', async () => {
    let recibido: StaffDirectoryQuery | undefined;
    const repo = makeRepo({
      listDirectory: (q) => {
        recibido = q;
        return Promise.resolve({ items: [], total: 0, page: 1, pageSize: 20 });
      },
    });

    await new ListStaffDirectoryUseCase(repo).execute({
      page: 1,
      pageSize: 20,
      search: '   ',
    });

    // `undefined`, no cadena vacía: el repositorio distingue "sin búsqueda" de
    // "búsqueda vacía" y con '' montaría un contains que no filtra nada.
    expect(recibido?.search).toBeUndefined();
  });

  it('recorta los espacios de alrededor de la búsqueda', async () => {
    let recibido: StaffDirectoryQuery | undefined;
    const repo = makeRepo({
      listDirectory: (q) => {
        recibido = q;
        return Promise.resolve({ items: [], total: 0, page: 1, pageSize: 20 });
      },
    });

    await new ListStaffDirectoryUseCase(repo).execute({
      page: 1,
      pageSize: 20,
      search: '  ana  ',
    });

    expect(recibido?.search).toBe('ana');
  });

  it('devuelve la página del repositorio sin tocarla', async () => {
    const page: StaffDirectoryPage = {
      items: [
        {
          kind: 'MEMBER',
          id: 'u1',
          fullName: 'Ana Ríos',
          email: 'ana@clinic.com',
          role: ClinicRole.DENTIST,
          status: 'ACTIVE',
          expiresAt: null,
        },
        {
          kind: 'INVITATION',
          id: 'i1',
          fullName: 'Beto Sin Aceptar',
          email: 'beto@clinic.com',
          role: ClinicRole.ASSISTANT,
          status: 'PENDING',
          expiresAt: new Date('2026-08-08T00:00:00.000Z'),
        },
      ],
      total: 2,
      page: 1,
      pageSize: 20,
    };
    const repo = makeRepo({ listDirectory: () => Promise.resolve(page) });

    await expect(
      new ListStaffDirectoryUseCase(repo).execute({ page: 1, pageSize: 20 }),
    ).resolves.toBe(page);
  });
});
