import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { InMemoryConsentTemplateRepository } from '../__fixtures__/in-memory-consent-templates';
import { InMemoryPatientConsentRepository } from '../__fixtures__/in-memory-patient-consents';
import { patientsInClinic } from '../../../patients/application/__fixtures__/patients-in-clinic.fake';
import { computeConsentHash } from '../../domain/consent-hash';
import {
  GetPatientConsentUseCase,
  ListPatientConsentsUseCase,
  PreviewPatientConsentUseCase,
  SignPatientConsentUseCase,
  type SignPatientConsentInput,
} from './patient-consents.use-cases';
import { UpdateConsentTemplateUseCase } from './consent-templates.use-cases';

const PNG_A =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_B =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
// 17:30 UTC del 16 de octubre = 12:30 en Bogotá.
const NOW = new Date('2026-10-16T17:30:00.000Z');
const META = {
  recordedById: 'dentist-1',
  ipAddress: '10.0.0.1',
  userAgent: 'jest',
};

function setup() {
  const templates = new InMemoryConsentTemplateRepository();
  const consents = new InMemoryPatientConsentRepository(undefined, {
    'plan-1': {
      patientId: 'p1',
      items: [
        { label: 'Exodoncia simple', toothNumber: '48' },
        { label: 'Resina', toothNumber: '36' },
      ],
    },
    'plan-otro': { patientId: 'p2', items: [] },
  });
  const template = templates.seed({
    title: 'Consentimiento de exodoncia',
    body:
      'Yo, {{paciente}} ({{documento}}), autorizo a {{profesional}} de ' +
      '{{clinica}} a realizar: {{tratamiento}}. Fecha: {{fecha}}.',
  });
  const now = () => NOW;
  return {
    templates,
    consents,
    template,
    preview: new PreviewPatientConsentUseCase(templates, consents, now),
    sign: new SignPatientConsentUseCase(templates, consents, now),
    list: new ListPatientConsentsUseCase(consents, patientsInClinic('p1')),
    get: new GetPatientConsentUseCase(consents),
  };
}

function signInput(
  templateId: string,
  extra: Partial<SignPatientConsentInput> = {},
): SignPatientConsentInput {
  return {
    templateId,
    templateVersion: 1,
    signerType: 'PATIENT',
    patientSignature: `data:image/png;base64,${PNG_A}`,
    professionalSignature: PNG_B,
    ...extra,
  };
}

describe('PreviewPatientConsentUseCase', () => {
  it('resuelve todas las variables con datos del paciente, la clínica y el plan', async () => {
    const { preview, template } = setup();

    const result = await preview.execute(
      'p1',
      { templateId: template.id, treatmentPlanId: 'plan-1' },
      'dentist-1',
    );

    expect(result).toEqual({
      templateId: template.id,
      templateVersion: 1,
      title: 'Consentimiento de exodoncia',
      body:
        'Yo, Ana Pérez (CC 1020304050), autorizo a Dra. Laura Gómez de ' +
        'Clínica Demo a realizar: Exodoncia simple (diente 48); Resina ' +
        '(diente 36). Fecha: 16 de octubre de 2026.',
      professionalName: 'Dra. Laura Gómez',
    });
  });

  it('consent date uses the location zone', async () => {
    // 17:30 UTC del 16 ya es el 17 en Tokio: la fecha es la de la sede.
    const { preview, template, consents } = setup();
    consents.timeZone = 'Asia/Tokyo';

    const result = await preview.execute(
      'p1',
      { templateId: template.id },
      'dentist-1',
    );

    expect(result.body).toContain('Fecha: 17 de octubre de 2026.');
  });

  it('sin plan, {{tratamiento}} dice que no se especificó', async () => {
    const { preview, template } = setup();
    const result = await preview.execute(
      'p1',
      { templateId: template.id },
      'dentist-1',
    );
    expect(result.body).toContain('a realizar: No especificado.');
  });

  it('404 si el paciente no es de esta clínica', async () => {
    const { preview, template } = setup();
    await expect(
      preview.execute('p-otra', { templateId: template.id }, 'dentist-1'),
    ).rejects.toThrow(NotFoundException);
  });

  it('404 si el plan es de otro paciente', async () => {
    const { preview, template } = setup();
    await expect(
      preview.execute(
        'p1',
        { templateId: template.id, treatmentPlanId: 'plan-otro' },
        'dentist-1',
      ),
    ).rejects.toThrow(/Plan de tratamiento no encontrado/);
  });

  it('404 si la plantilla no existe y 400 si está desactivada', async () => {
    const { preview, templates } = setup();
    await expect(
      preview.execute('p1', { templateId: 'nope' }, 'dentist-1'),
    ).rejects.toThrow(NotFoundException);
    const inactive = templates.seed({ title: 'Vieja', active: false });
    await expect(
      preview.execute('p1', { templateId: inactive.id }, 'dentist-1'),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('SignPatientConsentUseCase', () => {
  it('guarda la foto renderizada, las firmas sin prefijo, la hora del servidor, el autor y el hash', async () => {
    const { sign, consents, template } = setup();

    const signed = await sign.execute(
      'p1',
      signInput(template.id, { treatmentPlanId: 'plan-1' }),
      META,
    );

    expect(consents.rows).toHaveLength(1);
    expect(signed).toMatchObject({
      patientId: 'p1',
      templateId: template.id,
      templateVersion: 1,
      treatmentPlanId: 'plan-1',
      title: 'Consentimiento de exodoncia',
      signerType: 'PATIENT',
      signerName: 'Ana Pérez',
      signerDocument: 'CC 1020304050',
      professionalName: 'Dra. Laura Gómez',
      patientSignature: PNG_A,
      professionalSignature: PNG_B,
      signedAt: NOW,
      recordedById: 'dentist-1',
      ipAddress: '10.0.0.1',
      userAgent: 'jest',
    });
    expect(signed.body).toContain('Ana Pérez (CC 1020304050)');
    expect(signed.contentHash).toBe(
      computeConsentHash({
        title: signed.title,
        body: signed.body,
        signerType: 'PATIENT',
        signerName: 'Ana Pérez',
        signerDocument: 'CC 1020304050',
        professionalName: 'Dra. Laura Gómez',
        patientSignature: PNG_A,
        professionalSignature: PNG_B,
        signedAt: NOW,
      }),
    );
  });

  it('firma un tutor con su nombre y documento', async () => {
    const { sign, template } = setup();
    const signed = await sign.execute(
      'p1',
      signInput(template.id, {
        signerType: 'GUARDIAN',
        guardianName: '  Marta Pérez ',
        guardianDocument: ' CC 999 ',
      }),
      META,
    );
    expect(signed.signerName).toBe('Marta Pérez');
    expect(signed.signerDocument).toBe('CC 999');
  });

  it('400 si firma un tutor sin nombre o sin documento', async () => {
    const { sign, template } = setup();
    await expect(
      sign.execute(
        'p1',
        signInput(template.id, { signerType: 'GUARDIAN', guardianName: 'M' }),
        META,
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      sign.execute(
        'p1',
        signInput(template.id, {
          signerType: 'GUARDIAN',
          guardianDocument: 'CC 1',
        }),
        META,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('400 sin firma del paciente o con una firma que no es PNG; no guarda nada', async () => {
    const { sign, consents, template } = setup();
    await expect(
      sign.execute(
        'p1',
        signInput(template.id, { patientSignature: '' }),
        META,
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      sign.execute(
        'p1',
        signInput(template.id, {
          professionalSignature:
            Buffer.from('GIF89a-no-png').toString('base64'),
        }),
        META,
      ),
    ).rejects.toThrow(/firma del profesional.*PNG/);
    expect(consents.rows).toHaveLength(0);
  });

  it('valida las firmas DESPUÉS de comprobar el paciente y el plan: ajeno con firma inválida da 404 (SEC-026)', async () => {
    const { sign, consents, template } = setup();
    const bad = Buffer.from('GIF89a-no-png').toString('base64');
    await expect(
      sign.execute(
        'p-otra',
        signInput(template.id, { patientSignature: bad }),
        META,
      ),
    ).rejects.toThrow(NotFoundException);
    await expect(
      sign.execute(
        'p1',
        signInput(template.id, {
          treatmentPlanId: 'plan-otro',
          professionalSignature: bad,
        }),
        META,
      ),
    ).rejects.toThrow(NotFoundException);
    expect(consents.rows).toHaveLength(0);
  });

  it('409 si la plantilla cambió desde la vista previa', async () => {
    const { sign, templates, template } = setup();
    await new UpdateConsentTemplateUseCase(templates).execute(template.id, {
      body: 'Texto nuevo {{paciente}}',
    });
    await expect(
      sign.execute('p1', signInput(template.id), META),
    ).rejects.toThrow(ConflictException);
  });

  it('editar la plantilla después NO cambia el consentimiento firmado (snapshot)', async () => {
    const { sign, get, templates, template } = setup();
    const signed = await sign.execute('p1', signInput(template.id), META);

    await new UpdateConsentTemplateUseCase(templates).execute(template.id, {
      title: 'Otro título',
      body: 'Texto totalmente distinto',
    });

    const reread = await get.execute('p1', signed.id);
    expect(reread.title).toBe('Consentimiento de exodoncia');
    expect(reread.body).toBe(signed.body);
    expect(reread.templateVersion).toBe(1);
    expect(reread.integrityOk).toBe(true);
  });

  it('404 si el paciente o el plan no son de esta clínica; no guarda nada', async () => {
    const { sign, consents, template } = setup();
    await expect(
      sign.execute('p-otra', signInput(template.id), META),
    ).rejects.toThrow(NotFoundException);
    await expect(
      sign.execute(
        'p1',
        signInput(template.id, { treatmentPlanId: 'plan-otro' }),
        META,
      ),
    ).rejects.toThrow(NotFoundException);
    expect(consents.rows).toHaveLength(0);
  });
});

describe('ListPatientConsentsUseCase / GetPatientConsentUseCase', () => {
  it('lista los del paciente y 404 si el paciente no es de la clínica', async () => {
    const { sign, list, template } = setup();
    await sign.execute('p1', signInput(template.id), META);

    expect(await list.execute('p1')).toHaveLength(1);
    await expect(list.execute('p-otra')).rejects.toThrow(NotFoundException);
  });

  it('el detalle marca integrityOk=false si el contenido no casa con el hash', async () => {
    const { sign, get, consents, template } = setup();
    const signed = await sign.execute('p1', signInput(template.id), META);
    consents.rows[0] = { ...consents.rows[0], body: 'alterado' };

    expect((await get.execute('p1', signed.id)).integrityOk).toBe(false);
  });

  it('404 si el consentimiento no es de ese paciente', async () => {
    const { get } = setup();
    await expect(get.execute('p1', 'pc-999')).rejects.toThrow(
      NotFoundException,
    );
  });
});
