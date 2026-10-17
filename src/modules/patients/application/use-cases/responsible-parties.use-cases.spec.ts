import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { FakeResponsiblePartyRepository } from '../__fixtures__/fake-responsible-party.repository';
import {
  CreateResponsiblePartyUseCase,
  ListResponsiblePartiesUseCase,
  RemoveResponsiblePartyUseCase,
  UpdateResponsiblePartyUseCase,
} from './responsible-parties.use-cases';
import { ResponsiblePartyConflictError } from '../../domain/ports/responsible-party-repository.port';

const NOW = new Date('2026-10-17T15:00:00.000Z');
const MOTHER = 'mother';
const SON = 'son';
const DAUGHTER = 'daughter';
const USER = 'user-1';

describe('responsables de pago y avisos (DX-203)', () => {
  let repo: FakeResponsiblePartyRepository;
  let list: ListResponsiblePartiesUseCase;
  let create: CreateResponsiblePartyUseCase;
  let update: UpdateResponsiblePartyUseCase;
  let remove: RemoveResponsiblePartyUseCase;

  beforeEach(() => {
    repo = new FakeResponsiblePartyRepository();
    repo.addPatient(MOTHER, {
      firstName: 'Claudia',
      lastName: 'Navarro',
      email: 'claudia@example.com',
      birthDate: new Date('1985-01-01'),
    });
    repo.addPatient(SON, {
      firstName: 'Tomás',
      lastName: 'Ortiz',
      birthDate: new Date('2016-04-01'),
    });
    repo.addPatient(DAUGHTER, {
      firstName: 'Sofía',
      lastName: 'Ortiz',
      birthDate: new Date('2015-02-11'),
    });
    list = new ListResponsiblePartiesUseCase(repo, () => NOW);
    create = new CreateResponsiblePartyUseCase(repo);
    update = new UpdateResponsiblePartyUseCase(repo);
    remove = new RemoveResponsiblePartyUseCase(repo);
  });

  it('vincula a un paciente existente y sale en la ficha de ambos («Responsable de»)', async () => {
    await create.execute(
      SON,
      { responsiblePatientId: MOTHER, relationship: 'MOTHER', isPayer: true },
      USER,
    );
    const son = await list.execute(SON);
    expect(son).toMatchObject({
      minor: true,
      majorityAge: 18,
      country: 'CO',
      parties: [
        {
          kind: 'PATIENT',
          fullName: 'Claudia Navarro',
          email: 'claudia@example.com',
          isPayer: true,
          receivesNotices: true,
        },
      ],
      noticeRecipient: { kind: 'RESPONSIBLE', email: 'claudia@example.com' },
    });
    const mother = await list.execute(MOTHER);
    expect(mother.responsibleFor).toEqual([
      expect.objectContaining({
        patient: { id: SON, firstName: 'Tomás', lastName: 'Ortiz' },
        isPayer: true,
      }),
    ]);
  });

  it('crea un contacto nuevo (sin ficha) con los datos normalizados', async () => {
    const party = await create.execute(
      DAUGHTER,
      {
        fullName: '  Óscar Cifuentes ',
        docType: 'CC',
        docNumber: ' 79345678 ',
        email: ' Oscar@Example.com ',
        phone: '',
        relationship: 'FATHER',
      },
      USER,
    );
    expect(party).toMatchObject({
      kind: 'CONTACT',
      fullName: 'Óscar Cifuentes',
      docNumber: '79345678',
      email: 'oscar@example.com',
      phone: null,
      isPayer: false,
      receivesNotices: true,
    });
  });

  it('un paciente de otra clínica (o inexistente) como responsable: 404', async () => {
    await expect(
      create.execute(
        SON,
        { responsiblePatientId: 'otra-clinica', relationship: 'MOTHER' },
        USER,
      ),
    ).rejects.toThrow(
      new NotFoundException('Paciente responsable no encontrado'),
    );
    await expect(
      create.execute('nadie', { fullName: 'X', relationship: 'OTHER' }, USER),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('un segundo pagador principal: 422 en español con el nombre del actual', async () => {
    await create.execute(
      SON,
      { responsiblePatientId: MOTHER, relationship: 'MOTHER', isPayer: true },
      USER,
    );
    await expect(
      create.execute(
        SON,
        { fullName: 'Luis Ortiz', relationship: 'FATHER', isPayer: true },
        USER,
      ),
    ).rejects.toThrow(
      new UnprocessableEntityException(
        'Claudia Navarro ya es el pagador principal de este paciente. Quítale esa marca antes de elegir a otro.',
      ),
    );
    const father = await create.execute(
      SON,
      { fullName: 'Luis Ortiz', relationship: 'FATHER' },
      USER,
    );
    await expect(
      update.execute(SON, father.id, { isPayer: true }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('dos altas a la vez: el índice único de la BD también da 422', async () => {
    jest
      .spyOn(repo, 'create')
      .mockRejectedValue(new ResponsiblePartyConflictError('PAYER'));
    await expect(
      create.execute(
        SON,
        { fullName: 'Luis', relationship: 'FATHER', isPayer: true },
        USER,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('validaciones: una sola forma, nadie es su propio responsable, el mismo paciente una vez', async () => {
    await expect(
      create.execute(
        SON,
        {
          responsiblePatientId: MOTHER,
          fullName: 'Claudia',
          relationship: 'MOTHER',
        },
        USER,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      create.execute(SON, { fullName: '   ', relationship: 'MOTHER' }, USER),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      create.execute(
        SON,
        { responsiblePatientId: SON, relationship: 'OTHER' },
        USER,
      ),
    ).rejects.toThrow('Un paciente no puede ser su propio responsable.');
    await create.execute(
      SON,
      { responsiblePatientId: MOTHER, relationship: 'MOTHER' },
      USER,
    );
    await expect(
      create.execute(
        SON,
        { responsiblePatientId: MOTHER, relationship: 'MOTHER' },
        USER,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('como mucho 5 responsables', async () => {
    for (let i = 0; i < 5; i += 1) {
      await create.execute(
        SON,
        { fullName: `Contacto ${i}`, relationship: 'OTHER' },
        USER,
      );
    }
    await expect(
      create.execute(SON, { fullName: 'Sexto', relationship: 'OTHER' }, USER),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('edita un contacto; los datos de un paciente responsable se cambian en su ficha', async () => {
    const contact = await create.execute(
      SON,
      { fullName: 'Luis', relationship: 'FATHER' },
      USER,
    );
    await expect(
      update.execute(SON, contact.id, {
        email: 'luis@example.com',
        receivesNotices: false,
      }),
    ).resolves.toMatchObject({
      email: 'luis@example.com',
      receivesNotices: false,
    });
    const linked = await create.execute(
      SON,
      { responsiblePatientId: MOTHER, relationship: 'MOTHER' },
      USER,
    );
    await expect(
      update.execute(SON, linked.id, { email: 'otra@example.com' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      update.execute(SON, linked.id, { isPayer: true }),
    ).resolves.toMatchObject({ isPayer: true });
    await expect(
      update.execute(SON, 'no-existe', { isPayer: false }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('quitar: sale de la ficha; quitarlo dos veces es 404', async () => {
    const party = await create.execute(
      SON,
      { fullName: 'Luis', relationship: 'FATHER' },
      USER,
    );
    await remove.execute(SON, party.id);
    expect((await list.execute(SON)).parties).toEqual([]);
    await expect(remove.execute(SON, party.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('la edad cuenta con el país de la sede: 16 años en España ya no es menor', async () => {
    repo.addPatient('teen', { birthDate: new Date('2010-01-01') });
    expect((await list.execute('teen')).minor).toBe(true);
    repo.country = 'ES';
    expect(await list.execute('teen')).toMatchObject({
      minor: false,
      majorityAge: 16,
      country: 'ES',
    });
  });
});
