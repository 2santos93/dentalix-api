import { TEST_AUDIT } from '../../../audit/application/__fixtures__/test-audit-context';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { FixedDocumentTypeNamesReader } from '../../../document-type-names/__fixtures__/fixed-document-type-names.reader';
import { InMemoryConsentTemplateRepository } from '../__fixtures__/in-memory-consent-templates';
import { InMemoryPatientConsentRepository } from '../__fixtures__/in-memory-patient-consents';
import { patientsInClinic } from '../../../patients/application/__fixtures__/patients-in-clinic.fake';
import {
  computeConsentHash,
  computeCountersignatureHash,
  computeRemoteConsentHash,
} from '../../domain/consent-hash';
import {
  CONSENT_PREVIEW_EXPIRED_MESSAGE,
  CONSENT_PREVIEW_MAX_AGE_MS,
  CONSENT_TEMPLATE_CHANGED_MESSAGE,
  CountersignPatientConsentUseCase,
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
// 17:30 UTC del 16 de octubre = 12:30 en la zona de la sede.
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
  const names = new FixedDocumentTypeNamesReader();
  return {
    names,
    templates,
    consents,
    template,
    preview: new PreviewPatientConsentUseCase(templates, consents, now, names),
    sign: new SignPatientConsentUseCase(templates, consents, now, names),
    list: new ListPatientConsentsUseCase(consents, patientsInClinic('p1')),
    get: new GetPatientConsentUseCase(consents, names),
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
        'Yo, Ana Pérez (Documento nacional 1020304050), autorizo a Dra. Laura Gómez de ' +
        'Clínica Demo a realizar: Exodoncia simple (diente 48); Resina ' +
        '(diente 36). Fecha: 16 de octubre de 2026.',
      professionalName: 'Dra. Laura Gómez',
      // DX-058: el instante con el que se pintó {{fecha}}; la firma lo reusa.
      previewedAt: NOW,
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

  it('consent date is Spanish words for any locale', async () => {
    const { preview, template, consents } = setup();
    consents.location = { id: 'loc-1', locale: 'ja-JP', hourCycle: 'h12' };
    const result = await preview.execute(
      'p1',
      { templateId: template.id },
      'dentist-1',
    );
    expect(result.body).toContain('Fecha: 16 de octubre de 2026.');
  });

  it('una sede sin reloj: 409 LOCATION_LOCALE_REQUIRED al pintar la fecha', async () => {
    const { preview, template, consents } = setup();
    consents.location = { id: 'loc-1', locale: 'es-ES', hourCycle: null };
    const error = await preview
      .execute('p1', { templateId: template.id }, 'dentist-1')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'LOCATION_LOCALE_REQUIRED',
      locationId: 'loc-1',
    });
  });

  it('una sede sin reloj firma una plantilla sin {{fecha}} sin pedir el formato', async () => {
    const { preview, templates, consents } = setup();
    consents.location = { id: 'loc-1', locale: null, hourCycle: null };
    const nodate = templates.seed({
      title: 'Sin fecha',
      body: 'Yo, {{paciente}}, autorizo.',
    });
    const result = await preview.execute(
      'p1',
      { templateId: nodate.id },
      'dentist-1',
    );
    expect(result.body).toBe('Yo, Ana Pérez, autorizo.');
  });

  it('DX-060: sin plan, {{tratamiento}} se lee con una frase natural, nunca «No especificado»', async () => {
    const { preview, template } = setup();
    const result = await preview.execute(
      'p1',
      { templateId: template.id },
      'dentist-1',
    );
    expect(result.body).not.toContain('No especificado');
    expect(result.body).toContain(
      'a realizar: el tratamiento indicado por el profesional en la consulta.',
    );
  });

  it('DX-060: sin plan, una línea que solo rotula {{tratamiento}} se omite', async () => {
    const { preview, templates } = setup();
    const labelled = templates.seed({
      title: 'Con rótulo',
      body: 'Yo, {{paciente}}, autorizo el procedimiento.\n\nTratamiento: {{tratamiento}}\n\nGracias.',
    });
    const result = await preview.execute(
      'p1',
      { templateId: labelled.id },
      'dentist-1',
    );
    expect(result.body).toBe(
      'Yo, Ana Pérez, autorizo el procedimiento.\n\nGracias.',
    );
    // Con plan, la línea sigue ahí con sus procedimientos.
    const withPlan = await preview.execute(
      'p1',
      { templateId: labelled.id, treatmentPlanId: 'plan-1' },
      'dentist-1',
    );
    expect(withPlan.body).toContain(
      'Tratamiento: Exodoncia simple (diente 48); Resina (diente 36)',
    );
  });

  it('DX-060: un plan sin procedimientos se trata como sin plan', async () => {
    const { preview, template, consents } = setup();
    consents.plans['plan-vacio'] = { patientId: 'p1', items: [] };
    const result = await preview.execute(
      'p1',
      { templateId: template.id, treatmentPlanId: 'plan-vacio' },
      'dentist-1',
    );
    expect(result.body).not.toContain('No especificado');
    expect(result.body).toContain('el tratamiento indicado por el profesional');
  });

  it('DX-060: con un tutor, la vista previa abre con la cláusula de representación', async () => {
    const { preview, template } = setup();
    const result = await preview.execute(
      'p1',
      {
        templateId: template.id,
        signerType: 'GUARDIAN',
        guardianName: ' Marta Pérez ',
        guardianDocument: ' V-12.345.678 ',
        guardianRelationship: 'MOTHER',
      },
      'dentist-1',
    );
    expect(result.body).toBe(
      'Firma en representación del paciente: Marta Pérez, identificado(a) con V-12.345.678, ' +
        'otorga este consentimiento en nombre de Ana Pérez, como su madre. Lo que este documento ' +
        'dice en primera persona lo declara Marta Pérez en representación de Ana Pérez.\n\n' +
        'Yo, Ana Pérez (Documento nacional 1020304050), autorizo a Dra. Laura Gómez de ' +
        'Clínica Demo a realizar: el tratamiento indicado por el profesional en la consulta. ' +
        'Fecha: 16 de octubre de 2026.',
    );
  });

  it('DX-060: la vista previa de un tutor sin nombre o sin documento da 400', async () => {
    const { preview, template } = setup();
    await expect(
      preview.execute(
        'p1',
        { templateId: template.id, signerType: 'GUARDIAN', guardianName: 'M' },
        'dentist-1',
      ),
    ).rejects.toThrow(BadRequestException);
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
      signerDocument: 'Documento nacional 1020304050',
      professionalName: 'Dra. Laura Gómez',
      patientSignature: PNG_A,
      professionalSignature: PNG_B,
      signedAt: NOW,
      recordedById: 'dentist-1',
      ipAddress: '10.0.0.1',
      userAgent: 'jest',
    });
    expect(signed.body).toContain('Ana Pérez (Documento nacional 1020304050)');
    expect(signed.contentHash).toBe(
      computeConsentHash({
        title: signed.title,
        body: signed.body,
        signerType: 'PATIENT',
        signerName: 'Ana Pérez',
        signerDocument: 'Documento nacional 1020304050',
        professionalName: 'Dra. Laura Gómez',
        patientSignature: PNG_A,
        professionalSignature: PNG_B,
        signedAt: NOW,
      }),
    );
  });

  it('the consent document and signer freeze the display name', async () => {
    const { sign, get, consents, names, template } = setup();
    consents.patients.p1 = {
      ...consents.patients.p1,
      docTypeLabel: 'ID local',
    };
    const labelled = await sign.execute('p1', signInput(template.id), META);
    expect(labelled.signerDocument).toBe('ID local 1020304050');
    expect(labelled.body).toContain('Ana Pérez (ID local 1020304050)');

    consents.patients.p1 = { ...consents.patients.p1, docTypeLabel: null };
    names.names.NATIONAL_ID = 'Documento A';
    const local = await sign.execute('p1', signInput(template.id), META);
    expect(local.signerDocument).toBe('Documento A 1020304050');
    expect(local.body).toContain('Ana Pérez (Documento A 1020304050)');

    // Cambiar el nombre local después: lo firmado no cambia y sigue íntegro;
    // la cabecera imprimible es en vivo.
    names.names.NATIONAL_ID = 'Documento B';
    const doc = await get.execute('p1', local.id);
    expect(doc.signerDocument).toBe('Documento A 1020304050');
    expect(doc.body).toContain('Ana Pérez (Documento A 1020304050)');
    expect(doc.integrityOk).toBe(true);
    expect(doc.patient).toMatchObject({
      docType: 'NATIONAL_ID',
      docTypeLabel: null,
      docTypeName: 'Documento B',
    });
  });

  it('DX-524: sella el nombre del documento de la sede donde se firma', async () => {
    const { sign, consents, names, template } = setup();
    names.names.NATIONAL_ID = 'Documento clínica';
    names.byLocation.set(consents.location.id, {
      NATIONAL_ID: 'Documento sede',
    });
    names.byLocation.set('otra-sede', { NATIONAL_ID: 'Documento otra' });
    names.activeLocationId = 'otra-sede';
    const signed = await sign.execute('p1', signInput(template.id), META);
    expect(signed.signerDocument).toBe('Documento sede 1020304050');
  });

  it('firma un tutor con su nombre y documento', async () => {
    const { sign, template } = setup();
    const signed = await sign.execute(
      'p1',
      signInput(template.id, {
        signerType: 'GUARDIAN',
        guardianName: '  Marta Pérez ',
        guardianDocument: ' DOC 999 ',
      }),
      META,
    );
    expect(signed.signerName).toBe('Marta Pérez');
    expect(signed.signerDocument).toBe('DOC 999');
  });

  it('DX-060: con un tutor, el texto firmado identifica al tutor y su relación, igual que la vista previa', async () => {
    const { sign, preview, get, template } = setup();
    const guardian = {
      signerType: 'GUARDIAN' as const,
      guardianName: 'Marta Pérez',
      guardianDocument: 'V-12.345.678',
      guardianRelationship: 'LEGAL_GUARDIAN' as const,
    };
    const seen = await preview.execute(
      'p1',
      { templateId: template.id, ...guardian },
      'dentist-1',
    );
    const signed = await sign.execute(
      'p1',
      signInput(template.id, guardian),
      META,
    );
    expect(signed.body).toBe(seen.body);
    expect(
      signed.body.startsWith(
        'Firma en representación del paciente: Marta Pérez, identificado(a) con V-12.345.678, ' +
          'otorga este consentimiento en nombre de Ana Pérez, como su tutor legal.',
      ),
    ).toBe(true);
    // La cláusula va en el cuerpo sellado: el hash la cubre.
    const doc = await get.execute('p1', signed.id);
    expect(doc.integrityOk).toBe(true);
  });

  it('DX-060: firma el paciente: sin cláusula de representación', async () => {
    const { sign, template } = setup();
    const signed = await sign.execute('p1', signInput(template.id), META);
    expect(signed.body).not.toContain('Firma en representación');
    expect(signed.body.startsWith('Yo, Ana Pérez')).toBe(true);
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
          guardianDocument: 'DOC 1',
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
    await new UpdateConsentTemplateUseCase(templates).execute(
      template.id,
      {
        body: 'Texto nuevo {{paciente}}',
      },
      TEST_AUDIT,
    );
    await expect(
      sign.execute('p1', signInput(template.id), META),
    ).rejects.toThrow(ConflictException);
  });

  // DX-058: lo firmado es EXACTAMENTE lo previsualizado, también {{fecha}}.
  describe('DX-058 · fecha de la vista previa', () => {
    // 23:58 del 16 de octubre en Madrid (UTC+2) y 00:03 del 17.
    const BEFORE_MIDNIGHT = new Date('2026-10-16T21:58:00.000Z');
    const AFTER_MIDNIGHT = new Date('2026-10-16T22:03:00.000Z');

    function withClock(start: Date) {
      const base = setup();
      let current = start;
      const clock = () => current;
      return {
        ...base,
        setNow: (at: Date) => {
          current = at;
        },
        preview: new PreviewPatientConsentUseCase(
          base.templates,
          base.consents,
          clock,
          base.names,
        ),
        sign: new SignPatientConsentUseCase(
          base.templates,
          base.consents,
          clock,
          base.names,
        ),
      };
    }

    it('firmado pasada la medianoche, el texto lleva la fecha que se vio en la vista previa', async () => {
      const { preview, sign, setNow, template } = withClock(BEFORE_MIDNIGHT);
      const shown = await preview.execute(
        'p1',
        { templateId: template.id },
        'dentist-1',
      );
      expect(shown.body).toContain('Fecha: 16 de octubre de 2026.');

      setNow(AFTER_MIDNIGHT);
      const signed = await sign.execute(
        'p1',
        signInput(template.id, {
          previewedAt: shown.previewedAt.toISOString(),
        }),
        META,
      );

      expect(signed.body).toBe(shown.body);
      // `signedAt` sigue siendo el reloj del servidor al firmar.
      expect(signed.signedAt).toEqual(AFTER_MIDNIGHT);
      expect(signed.contentHash).toBe(
        computeConsentHash({
          title: signed.title,
          body: shown.body,
          signerType: 'PATIENT',
          signerName: 'Ana Pérez',
          signerDocument: 'Documento nacional 1020304050',
          professionalName: 'Dra. Laura Gómez',
          patientSignature: PNG_A,
          professionalSignature: PNG_B,
          signedAt: AFTER_MIDNIGHT,
        }),
      );
    });

    it('sin previewedAt (cliente antiguo) la fecha es la de la firma', async () => {
      const { sign, template } = withClock(AFTER_MIDNIGHT);
      const signed = await sign.execute('p1', signInput(template.id), META);
      expect(signed.body).toContain('Fecha: 17 de octubre de 2026.');
    });

    it('409 CONSENT_PREVIEW_EXPIRED si la vista previa es muy antigua o del futuro; no guarda nada', async () => {
      const { sign, consents, template } = withClock(AFTER_MIDNIGHT);
      const stale = new Date(
        AFTER_MIDNIGHT.getTime() - CONSENT_PREVIEW_MAX_AGE_MS - 1,
      );
      const future = new Date(AFTER_MIDNIGHT.getTime() + 60_000);
      for (const previewedAt of [stale, future]) {
        const error = await sign
          .execute(
            'p1',
            signInput(template.id, { previewedAt: previewedAt.toISOString() }),
            META,
          )
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toMatchObject({
          code: 'CONSENT_PREVIEW_EXPIRED',
          message: CONSENT_PREVIEW_EXPIRED_MESSAGE,
        });
      }
      expect(consents.rows).toHaveLength(0);
    });

    it('409 si la plantilla cambia entre la comprobación y el INSERT (la repite la transacción)', async () => {
      const { sign, consents, template } = withClock(BEFORE_MIDNIGHT);
      // Otra petición sube la versión justo antes del INSERT: el repositorio
      // la vuelve a leer, bloqueada, dentro de la transacción que inserta.
      consents.templateVersionAtInsert = () => 2;
      const error = await sign
        .execute('p1', signInput(template.id), META)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).message).toBe(
        CONSENT_TEMPLATE_CHANGED_MESSAGE,
      );
      expect(consents.rows).toHaveLength(0);
    });
  });

  it('editar la plantilla después NO cambia el consentimiento firmado (snapshot)', async () => {
    const { sign, get, templates, template } = setup();
    const signed = await sign.execute('p1', signInput(template.id), META);

    await new UpdateConsentTemplateUseCase(templates).execute(
      template.id,
      {
        title: 'Otro título',
        body: 'Texto totalmente distinto',
      },
      TEST_AUDIT,
    );

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

  it('DX-354: el detalle lleva la región de la sede del documento', async () => {
    const { sign, get, template } = setup();
    const signed = await sign.execute('p1', signInput(template.id), META);

    expect((await get.execute('p1', signed.id)).regional).toEqual({
      timeZone: 'America/Caracas',
      locale: 'es-VE',
      hourCycle: 'h12',
    });
  });

  it('404 si el consentimiento no es de ese paciente', async () => {
    const { get } = setup();
    await expect(get.execute('p1', 'pc-999')).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('CountersignPatientConsentUseCase (DX-243)', () => {
  const REMOTE = {
    signatureRequestId: 'sr-1',
    channel: 'EMAIL' as const,
    destinationMasked: 'an***@example.com',
    sentAt: new Date('2026-10-16T12:00:00.000Z'),
    openedAt: new Date('2026-10-16T13:00:00.000Z'),
    verifiedAt: new Date('2026-10-16T13:01:00.000Z'),
    professionalUserId: 'dentist-1',
  };

  function remoteSetup() {
    const ctx = setup();
    const base = {
      tenantId: 't1',
      patientId: 'p1',
      templateId: ctx.template.id,
      templateVersion: 1,
      treatmentPlanId: null,
      title: 'Consentimiento de exodoncia',
      body: 'Yo, Ana Pérez, autorizo…',
      signerType: 'PATIENT' as const,
      signerName: 'Ana Pérez',
      signerDocument: null,
      professionalName: 'Dra. Laura Gómez',
      patientSignature: PNG_A,
      signedAt: new Date('2026-10-16T13:05:00.000Z'),
      recordedById: 'reception-1',
      ipAddress: '203.0.113.7',
      userAgent: 'Mobile',
    };
    const contentHash = computeRemoteConsentHash({
      ...base,
      channel: REMOTE.channel,
      destinationMasked: REMOTE.destinationMasked,
      sentAt: REMOTE.sentAt,
      openedAt: REMOTE.openedAt,
      verifiedAt: REMOTE.verifiedAt,
    });
    const consent = ctx.consents.seedRemote(
      { id: 'pc-remote', contentHash, ...base },
      REMOTE,
      'Dra. Laura Gómez',
    );
    const scheduled: string[] = [];
    const countersign = new CountersignPatientConsentUseCase(
      ctx.consents,
      () => NOW,
      {
        schedule: (_tx, consentId) => {
          scheduled.push(consentId);
          return Promise.resolve();
        },
      },
    );
    return { ...ctx, consent, countersign, scheduled };
  }

  it('el profesional que lo envió firma en la app: queda completo, con su hash encadenado e íntegro', async () => {
    const ctx = remoteSetup();
    expect((await ctx.list.execute('p1'))[0]).toMatchObject({
      complete: false,
      professionalSignedAt: null,
    });
    const summary = await ctx.countersign.execute(
      'p1',
      'pc-remote',
      { professionalSignature: `data:image/png;base64,${PNG_B}` },
      META,
    );
    expect(summary).toMatchObject({
      complete: true,
      professionalSignedAt: NOW,
    });
    const stored = ctx.consents.countersignatures.get('pc-remote');
    expect(stored?.contentHash).toBe(
      computeCountersignatureHash({
        consentHash: ctx.consent.contentHash,
        professionalName: 'Dra. Laura Gómez',
        professionalSignature: PNG_B,
        signedAt: NOW,
      }),
    );
    const doc = await ctx.get.execute('p1', 'pc-remote');
    expect(doc.integrityOk).toBe(true);
    expect(doc.professionalSignature).toBe(PNG_B);
    // DX-422: completo ⇒ se encola (en la misma transacción) el PDF firmado.
    expect(ctx.scheduled).toEqual(['pc-remote']);
  });

  it('el detalle detecta una firma del paciente alterada a distancia', async () => {
    const ctx = remoteSetup();
    ctx.consents.rows[0] = { ...ctx.consents.rows[0], body: 'alterado' };
    expect((await ctx.get.execute('p1', 'pc-remote')).integrityOk).toBe(false);
  });

  it('otro profesional: 403; uno firmado en pantalla o ya completo: 409; ajeno: 404', async () => {
    const ctx = remoteSetup();
    const input = { professionalSignature: PNG_B };
    await expect(
      ctx.countersign.execute('p1', 'pc-remote', input, {
        ...META,
        recordedById: 'dentist-2',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      ctx.countersign.execute('p2', 'pc-remote', input, META),
    ).rejects.toBeInstanceOf(NotFoundException);
    const onScreen = await ctx.sign.execute(
      'p1',
      signInput(ctx.template.id),
      META,
    );
    await expect(
      ctx.countersign.execute('p1', onScreen.id, input, META),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      ctx.countersign.execute(
        'p1',
        'pc-remote',
        { professionalSignature: 'x' },
        META,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(ctx.scheduled).toEqual([]);
    await ctx.countersign.execute('p1', 'pc-remote', input, META);
    await expect(
      ctx.countersign.execute('p1', 'pc-remote', input, META),
    ).rejects.toBeInstanceOf(ConflictException);
    // El segundo intento (409) no encola otro PDF.
    expect(ctx.scheduled).toEqual(['pc-remote']);
  });
});
