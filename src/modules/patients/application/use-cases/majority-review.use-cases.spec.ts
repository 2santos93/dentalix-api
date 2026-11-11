import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type {
  ComingOfAgeCandidate,
  ComingOfAgeQuery,
  MajorityReviewRepository,
  MajorityReviewSnapshot,
  NewMajorityReview,
} from '../../domain/ports/majority-review-repository.port';
import type { NoticeSettings } from '../../domain/communication/notice-recipient';
import {
  COMING_OF_AGE_INVALID_PERIOD_MESSAGE,
  COMING_OF_AGE_PERIOD_TOO_LONG_MESSAGE,
  GetMajorityReviewUseCase,
  ListComingOfAgeUseCase,
  MAJORITY_REVIEW_MINOR_MESSAGE,
  MAJORITY_REVIEW_NO_BIRTH_DATE_MESSAGE,
  MAJORITY_REVIEW_NO_RESPONSIBLES_MESSAGE,
  MAJORITY_REVIEW_NOT_APPLICABLE_MESSAGE,
  MAJORITY_REVIEW_NOTE_MESSAGE,
  ReviewMajorityUseCase,
} from './majority-review.use-cases';

// Hoy, 2026-11-11 en Caracas.
const NOW = new Date('2026-11-11T15:00:00.000Z');
const CHILDHOOD = new Date('2014-05-02T14:00:00.000Z');
const USER = 'user-1';

const mother = {
  id: 'r-1',
  name: 'Carmen Rondón',
  relationship: 'MOTHER' as const,
  receivesNotices: true,
  isPayer: true,
  createdAt: CHILDHOOD,
};

class FakeMajorityReviewRepository implements MajorityReviewRepository {
  readonly snapshots = new Map<string, MajorityReviewSnapshot>();
  readonly inserted: NewMajorityReview[] = [];
  readonly queries: ComingOfAgeQuery[] = [];
  candidates: ComingOfAgeCandidate[] = [];
  noticeSettings: NoticeSettings = {
    timeZone: 'America/Caracas',
    majorityAge: 18,
  };

  add(id: string, birthDate: string | null, responsibles = [mother]): void {
    this.snapshots.set(id, {
      patient: {
        id,
        birthDate: birthDate ? new Date(`${birthDate}T00:00:00.000Z`) : null,
      },
      responsibles,
      review: null,
      settings: this.noticeSettings,
    });
  }

  load(patientId: string): Promise<MajorityReviewSnapshot | null> {
    return Promise.resolve(this.snapshots.get(patientId) ?? null);
  }

  insert(review: NewMajorityReview): Promise<void> {
    this.inserted.push(review);
    const snapshot = this.snapshots.get(review.patientId);
    if (snapshot) {
      snapshot.review = {
        decision: review.decision,
        majorityDate: review.majorityDate,
        reviewedAt: NOW,
        reviewedById: review.reviewedById,
        reviewedByName: 'Yusmary Contreras',
      };
    }
    return Promise.resolve();
  }

  locations = new Set(['loc-1', 'loc-2']);
  locationExists(locationId: string): Promise<boolean> {
    return Promise.resolve(this.locations.has(locationId));
  }

  settings(): Promise<NoticeSettings> {
    return Promise.resolve(this.noticeSettings);
  }

  comingOfAge(query: ComingOfAgeQuery): Promise<ComingOfAgeCandidate[]> {
    this.queries.push(query);
    return Promise.resolve(this.candidates);
  }
}

const candidate = (
  id: string,
  birthDate: string,
  over: Partial<ComingOfAgeCandidate> = {},
): ComingOfAgeCandidate => ({
  patientId: id,
  firstName: 'Paciente',
  lastName: id,
  patientCode: 1000,
  birthDate: new Date(`${birthDate}T00:00:00.000Z`),
  responsiblesCount: 1,
  firstResponsibleAt: CHILDHOOD,
  review: null,
  locationId: 'loc-1',
  locationName: 'Sede Chacao',
  ...over,
});

describe('paso a la mayoría de edad (DX-342)', () => {
  let repo: FakeMajorityReviewRepository;
  const clock = () => NOW;

  beforeEach(() => {
    repo = new FakeMajorityReviewRepository();
  });

  describe('GET view', () => {
    it('PENDING with its majority date and the live responsibles', async () => {
      repo.add('p', '2008-11-01');
      await expect(
        new GetMajorityReviewUseCase(repo, clock).execute('p'),
      ).resolves.toEqual({
        status: 'PENDING',
        majorityDate: '2026-11-01',
        decision: null,
        reviewedAt: null,
        reviewedByName: null,
        responsibles: [
          {
            id: 'r-1',
            name: 'Carmen Rondón',
            relationship: 'MOTHER',
            receivesNotices: true,
            isPayer: true,
          },
        ],
      });
    });

    it('a stale review (other majority date) shows PENDING without who/when', async () => {
      repo.add('p', '2008-11-01');
      repo.snapshots.get('p')!.review = {
        decision: 'KEEP_RESPONSIBLE',
        majorityDate: '2028-11-01',
        reviewedAt: NOW,
        reviewedById: USER,
        reviewedByName: 'Yusmary Contreras',
      };
      await expect(
        new GetMajorityReviewUseCase(repo, clock).execute('p'),
      ).resolves.toMatchObject({
        status: 'PENDING',
        decision: null,
        reviewedAt: null,
        reviewedByName: null,
      });
    });

    it('404 for a patient of another clinic', async () => {
      await expect(
        new GetMajorityReviewUseCase(repo, clock).execute('x'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('POST review', () => {
    const review = () => new ReviewMajorityUseCase(repo, clock);

    it('stores the decision for the current majority date and returns REVIEWED', async () => {
      repo.add('p', '2008-11-01');
      await expect(
        review().execute(
          'p',
          { decision: 'PATIENT_SELF', note: '  Lo pidió en recepción ' },
          USER,
        ),
      ).resolves.toMatchObject({
        status: 'REVIEWED',
        decision: 'PATIENT_SELF',
        majorityDate: '2026-11-01',
        reviewedAt: NOW.toISOString(),
        reviewedByName: 'Yusmary Contreras',
      });
      expect(repo.inserted).toEqual([
        {
          patientId: 'p',
          decision: 'PATIENT_SELF',
          note: 'Lo pidió en recepción',
          majorityDate: '2026-11-01',
          reviewedById: USER,
        },
      ]);
    });

    it('rejects in Spanish: minor 409, no birth date, no responsibles or responsibles added as adult 422, long note 400, unknown 404', async () => {
      repo.add('minor', '2008-11-12');
      repo.add('nobirth', null);
      repo.add('alone', '2008-11-01', []);
      repo.add('elderly', '1950-03-03', [
        { ...mother, createdAt: new Date('2026-10-01T12:00:00.000Z') },
      ]);
      repo.add('p', '2008-11-01');
      const cases: [string, unknown, string][] = [
        ['minor', ConflictException, MAJORITY_REVIEW_MINOR_MESSAGE],
        [
          'nobirth',
          UnprocessableEntityException,
          MAJORITY_REVIEW_NO_BIRTH_DATE_MESSAGE,
        ],
        [
          'alone',
          UnprocessableEntityException,
          MAJORITY_REVIEW_NO_RESPONSIBLES_MESSAGE,
        ],
        [
          'elderly',
          UnprocessableEntityException,
          MAJORITY_REVIEW_NOT_APPLICABLE_MESSAGE,
        ],
      ];
      for (const [id, type, message] of cases) {
        const run = review().execute(id, { decision: 'PATIENT_SELF' }, USER);
        await expect(run).rejects.toBeInstanceOf(type);
        await expect(run).rejects.toThrow(message);
      }
      const long = review().execute(
        'p',
        { decision: 'PATIENT_SELF', note: 'x'.repeat(501) },
        USER,
      );
      await expect(long).rejects.toBeInstanceOf(BadRequestException);
      await expect(long).rejects.toThrow(MAJORITY_REVIEW_NOTE_MESSAGE);
      await expect(
        review().execute('x', { decision: 'PATIENT_SELF' }, USER),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.inserted).toEqual([]);
    });
  });

  describe('coming-of-age list', () => {
    const tenantContext = new TenantContextService();
    const list = () => new ListComingOfAgeUseCase(repo, tenantContext, clock);
    const run = <T>(fn: () => Promise<T>, allowed?: readonly string[]) =>
      tenantContext.run('t-1', undefined, fn, allowed);

    it('range plus overdue PENDING, overdue first; reviewed or not applicable before `from` stay out', async () => {
      repo.candidates = [
        candidate('in-range', '2008-11-20'),
        candidate('overdue', '2008-03-15'),
        candidate('reviewed-before', '2008-01-10', {
          review: { decision: 'PATIENT_SELF', majorityDate: '2026-01-10' },
        }),
        candidate('added-as-adult', '2000-01-10', {
          firstResponsibleAt: new Date('2025-01-01T12:00:00.000Z'),
        }),
        candidate('after-range', '2008-12-05'),
        candidate('future-minor', '2008-11-28'),
      ];
      const out = await run(() =>
        list().execute({ from: '2026-11-01', to: '2026-11-30' }),
      );
      expect(out).toMatchObject({
        from: '2026-11-01',
        to: '2026-11-30',
        majorityAge: 18,
        restrictedToLocations: false,
      });
      expect(
        out.items.map((i) => [
          i.patientId,
          i.status,
          i.overdue,
          i.majorityDate,
        ]),
      ).toEqual([
        ['overdue', 'PENDING', true, '2026-03-15'],
        ['in-range', 'NOT_APPLICABLE', false, '2026-11-20'],
        ['future-minor', 'NOT_APPLICABLE', false, '2026-11-28'],
      ]);
      expect(out.items[1]).toMatchObject({
        fullName: 'Paciente in-range',
        patientCode: '1000',
        birthDate: '2008-11-20',
        majorityAge: 18,
        responsiblesCount: 1,
        locationName: 'Sede Chacao',
      });
      // Cotas de nacimiento: [from − 18 años − 1 día, to − 18 años].
      expect(repo.queries[0]).toEqual({
        minBirthDate: '2008-10-31',
        maxBirthDate: '2008-11-30',
        majorityAge: 18,
        locationIds: undefined,
      });
    });

    it('in-range adults that already came of age are PENDING (not overdue)', async () => {
      repo.candidates = [candidate('p', '2008-11-05')];
      const out = await run(() =>
        list().execute({ from: '2026-11-01', to: '2026-11-30' }),
      );
      expect(out.items[0]).toMatchObject({ status: 'PENDING', overdue: false });
    });

    it('29 February: comes of age on 1 March in a non-leap year', async () => {
      repo.candidates = [candidate('leap', '2008-02-29')];
      const march = await run(() =>
        list().execute({ from: '2026-03-01', to: '2026-03-31' }),
      );
      expect(march.items[0]).toMatchObject({
        majorityDate: '2026-03-01',
        overdue: false,
      });
      expect(repo.queries[0].minBirthDate).toBe('2008-02-29');
      const february = await run(() =>
        list().execute({ from: '2026-02-01', to: '2026-02-28' }),
      );
      expect(february.items).toEqual([]);
    });

    it('a restricted member asks only for their sedes; locationId outside them is 403', async () => {
      const out = await run(
        () => list().execute({ from: '2026-11-01', to: '2026-11-30' }),
        ['loc-1'],
      );
      expect(out.restrictedToLocations).toBe(true);
      expect(repo.queries[0].locationIds).toEqual(['loc-1']);
      await expect(
        run(
          () =>
            list().execute({
              from: '2026-11-01',
              to: '2026-11-30',
              locationId: 'loc-2',
            }),
          ['loc-1'],
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Una sede que no es de la clínica: 404.
      await expect(
        run(() =>
          list().execute({
            from: '2026-11-01',
            to: '2026-11-30',
            locationId: 'other-clinic',
          }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('400 in Spanish for a bad period or more than 366 days', async () => {
      const bad = run(() =>
        list().execute({ from: '2026-11-30', to: '2026-11-01' }),
      );
      await expect(bad).rejects.toBeInstanceOf(BadRequestException);
      await expect(bad).rejects.toThrow(COMING_OF_AGE_INVALID_PERIOD_MESSAGE);
      await expect(
        run(() => list().execute({ from: '2026-02-30', to: '2026-03-01' })),
      ).rejects.toThrow(COMING_OF_AGE_INVALID_PERIOD_MESSAGE);
      await expect(
        run(() => list().execute({ from: '2026-01-01', to: '2027-01-02' })),
      ).rejects.toThrow(COMING_OF_AGE_PERIOD_TOO_LONG_MESSAGE);
      // 366 días justos (2028 es bisiesto) valen.
      await expect(
        run(() => list().execute({ from: '2028-01-01', to: '2028-12-31' })),
      ).resolves.toMatchObject({ items: [] });
    });
  });
});
