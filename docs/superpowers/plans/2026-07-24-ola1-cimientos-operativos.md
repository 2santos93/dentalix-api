# Ola 1 — Cimientos operativos: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar operatividad real a la clínica: gestión de personal (CRUD), un dashboard del doctor materializado sobre el `GET /dashboard` ya existente, y una vista semanal de la agenda.

**Architecture:** API en NestJS hexagonal (domain port → application use-case → infrastructure Prisma repo → presentation controller), multi-tenant con RLS vía `runWithTenant`/`set_config`. Web en Next.js (componentes cliente, clientes API en `src/lib/<dominio>`, UI kit propio, tests co-locados). TDD en ambos lados.

**Tech Stack:** NestJS, Prisma (PostgreSQL, RLS), argon2 (`PasswordService`), Jest + Supertest (API e2e); Next.js 16, React, Zustand, Jest + Testing Library (Web).

## Global Constraints

- **Sin cambios de esquema Prisma.** `email` ya existe en `User`; se reutiliza. No migraciones.
- **Multi-tenant/RLS:** todo acceso a datos tenant-scoped pasa por `runWithTenant`; inserts en tablas con RLS (`clinic_memberships`) requieren `SELECT set_config('app.current_tenant', <tenantId>, true)` dentro de la MISMA transacción (ver `PrismaAuthRepository.createClinicWithOwner`).
- **Permisos:** sets en `src/modules/auth/presentation/guards/clinic-role-sets.ts`. Escritura de personal = nuevo `STAFF_WRITE_ROLES = [OWNER, ADMIN]`. `GET /staff` intacto (`PATIENT_ROLES`).
- **Password service:** reutilizar `PasswordService.hash(plain): Promise<string>` de `src/shared/crypto/password.service.ts`. Mínimo 8 chars validado en el use-case.
- **`req.user`:** el JWT lleva `sub = userId` (ver `login.use-case.ts`). `requestingUserId = req.user.sub`.
- **Copy Web:** constantes `es` (i18n-ready) por componente, patrón de `AgendaView`.
- **AGENTS.md:** leer `node_modules/next/dist/docs` de `dentalix-web` antes de escribir código del Web (breaking changes de Next).
- **Rutas:** los paths con prefijo `dentalix-api/` son del repo API; `dentalix-web/` del repo Web. Rama de trabajo API: `feat/ola1-cimientos-operativos` (ya creada). Crear rama equivalente en Web.
- **Moneda dashboard:** selector COP/USD en la UI, COP por defecto.

---

# PARTE A — CRUD de personal (API)

### Task A1: `email` en la entidad y el listado de staff

**Files:**
- Modify: `dentalix-api/src/modules/staff/domain/entities/staff-member.entity.ts`
- Modify: `dentalix-api/src/modules/staff/presentation/dto/staff-member.dto.ts`
- Modify: `dentalix-api/src/modules/staff/infrastructure/repositories/prisma-staff.repository.ts` (mapping de `listActive`)
- Test: `dentalix-api/src/modules/staff/application/use-cases/list-staff.use-case.spec.ts`

**Interfaces:**
- Produces: `StaffMember { userId: string; fullName: string; email: string; role: ClinicRole }`

- [ ] **Step 1: Actualizar el spec de list para exigir `email`.** En `list-staff.use-case.spec.ts`, en el/los objeto(s) `StaffMember` del fake repo y en las aserciones, añadir `email` (p. ej. `email: 'ana@clinic.com'`) y `expect(result[0].email).toBe('ana@clinic.com')`.
- [ ] **Step 2: Correr y ver fallar.** Run: `cd dentalix-api && npx jest staff/application/use-cases/list-staff` → FAIL (type error / assertion).
- [ ] **Step 3: Implementar.** Añadir `email: string;` a `StaffMember`. En `staff-member.dto.ts` añadir `@ApiProperty() email!: string;`. En `prisma-staff.repository.ts` `listActive`, incluir `email: membership.user.email` en el `map`.
- [ ] **Step 4: Correr y ver pasar.** Run: `npx jest staff/application/use-cases/list-staff` → PASS.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(staff): expose email in StaffMember + GET /staff"`

---

### Task A2: Ampliar el puerto y el repo Prisma de staff

**Files:**
- Modify: `dentalix-api/src/modules/staff/domain/ports/staff-repository.port.ts`
- Modify: `dentalix-api/src/modules/staff/infrastructure/repositories/prisma-staff.repository.ts`

**Interfaces:**
- Produces (añadidos a `StaffRepository`):
  - `findUserByEmailGlobal(email: string): Promise<{ id: string } | null>`
  - `create(input: { fullName: string; email: string; role: ClinicRole; passwordHash: string }): Promise<StaffMember>`
  - `findById(userId: string): Promise<StaffMember | null>`
  - `updateById(userId: string, patch: { fullName?: string; role?: ClinicRole }): Promise<StaffMember | null>`
  - `deactivateById(userId: string): Promise<boolean>`
  - `countActiveOwners(): Promise<number>`

Nota de test: los métodos del repo Prisma se cubren por el **e2e (Task A7)**; aquí no hay unit test (no hay DB en unit). Las firmas se validan por TypeScript al compilar los use-cases (A3–A5).

- [ ] **Step 1: Declarar los métodos en el puerto** con las firmas de arriba (JSDoc breve como el existente `listActive`).
- [ ] **Step 2: Implementarlos en `PrismaStaffRepository`.** Todos dentro de `runWithTenant`. Código:

```ts
async findUserByEmailGlobal(email: string) {
  // User no tiene RLS (global, como en auth); consulta directa.
  return this.prisma.user.findFirst({ where: { email, deletedAt: null }, select: { id: true } });
}

async create(input: { fullName: string; email: string; role: ClinicRole; passwordHash: string }): Promise<StaffMember> {
  return this.prisma.runWithTenant(async (tx) => {
    const tenantId = this.prisma.currentTenantId(); // helper existente; si no, obtener del contexto igual que otros repos
    const user = await tx.user.create({
      data: { email: input.email, passwordHash: input.passwordHash, fullName: input.fullName },
      select: { id: true, fullName: true, email: true },
    });
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    const membership = await tx.clinicMembership.create({
      data: { tenantId, userId: user.id, role: input.role },
      select: { role: true },
    });
    return { userId: user.id, fullName: user.fullName, email: user.email, role: membership.role };
  });
}

async findById(userId: string): Promise<StaffMember | null> {
  return this.prisma.runWithTenant(async (tx) => {
    const m = await tx.clinicMembership.findFirst({
      where: { userId, deletedAt: null, user: { deletedAt: null } },
      include: { user: true },
    });
    return m ? { userId: m.userId, fullName: m.user.fullName, email: m.user.email, role: m.role } : null;
  });
}

async updateById(userId, patch): Promise<StaffMember | null> {
  return this.prisma.runWithTenant(async (tx) => {
    const m = await tx.clinicMembership.findFirst({ where: { userId, deletedAt: null }, select: { id: true } });
    if (!m) return null;
    if (patch.role) await tx.clinicMembership.update({ where: { id: m.id }, data: { role: patch.role } });
    if (patch.fullName) await tx.user.update({ where: { id: userId }, data: { fullName: patch.fullName } });
    const updated = await tx.clinicMembership.findFirst({ where: { id: m.id }, include: { user: true } });
    return updated ? { userId: updated.userId, fullName: updated.user.fullName, email: updated.user.email, role: updated.role } : null;
  });
}

async deactivateById(userId: string): Promise<boolean> {
  return this.prisma.runWithTenant(async (tx) => {
    const res = await tx.clinicMembership.updateMany({ where: { userId, deletedAt: null }, data: { deletedAt: new Date() } });
    return res.count > 0;
  });
}

async countActiveOwners(): Promise<number> {
  return this.prisma.runWithTenant(async (tx) =>
    tx.clinicMembership.count({ where: { deletedAt: null, role: ClinicRole.OWNER, user: { deletedAt: null } } }),
  );
}
```

> **Verificación en implementación:** confirmar cómo obtiene el `tenantId` el repo (buscar `set_config`/`currentTenant` en repos existentes; `PrismaAuthRepository.createClinicWithOwner` usa el `tenant.id` recién creado — aquí el tenant ya existe, así que hay que leer el tenant activo del contexto ALS, igual que hace `runWithTenant`). Ajustar `this.prisma.currentTenantId()` al helper real.

- [ ] **Step 3: Compilar.** Run: `cd dentalix-api && npx tsc --noEmit` → sin errores.
- [ ] **Step 4: Commit.** `git commit -am "feat(staff): repository create/update/deactivate/find/countOwners"`

---

### Task A3: `CreateStaffUseCase` + `STAFF_WRITE_ROLES`

**Files:**
- Modify: `dentalix-api/src/modules/auth/presentation/guards/clinic-role-sets.ts`
- Create: `dentalix-api/src/modules/staff/application/use-cases/create-staff.use-case.ts`
- Test: `dentalix-api/src/modules/staff/application/use-cases/create-staff.use-case.spec.ts`

**Interfaces:**
- Consumes: `StaffRepository.findUserByEmailGlobal`, `.create`; `PasswordService.hash`.
- Produces: `CreateStaffUseCase.execute(input: { fullName: string; email: string; role: ClinicRole; password: string }): Promise<StaffMember>`

- [ ] **Step 1: Test (fake repo + fake password service).**

```ts
import { CreateStaffUseCase } from './create-staff.use-case';
import { ClinicRole } from '@prisma/client';
import { ConflictException, BadRequestException } from '@nestjs/common';

const makeRepo = (over = {}) => ({
  findUserByEmailGlobal: jest.fn().mockResolvedValue(null),
  create: jest.fn().mockImplementation(async (i) => ({ userId: 'u1', fullName: i.fullName, email: i.email, role: i.role })),
  ...over,
});
const pwd = { hash: jest.fn().mockResolvedValue('HASH'), verify: jest.fn() };

it('crea usuario+membership con password hasheada y email normalizado', async () => {
  const repo = makeRepo();
  const uc = new CreateStaffUseCase(repo as any, pwd as any);
  const r = await uc.execute({ fullName: 'Ana Ruiz', email: '  Ana@Clinic.com ', role: ClinicRole.DENTIST, password: 'secret12' });
  expect(pwd.hash).toHaveBeenCalledWith('secret12');
  expect(repo.create).toHaveBeenCalledWith({ fullName: 'Ana Ruiz', email: 'ana@clinic.com', role: ClinicRole.DENTIST, passwordHash: 'HASH' });
  expect(r.userId).toBe('u1');
});

it('409 si el email ya existe', async () => {
  const repo = makeRepo({ findUserByEmailGlobal: jest.fn().mockResolvedValue({ id: 'x' }) });
  const uc = new CreateStaffUseCase(repo as any, pwd as any);
  await expect(uc.execute({ fullName: 'Ana', email: 'a@a.com', role: ClinicRole.DENTIST, password: 'secret12' })).rejects.toBeInstanceOf(ConflictException);
});

it('400 si password < 8', async () => {
  const uc = new CreateStaffUseCase(makeRepo() as any, pwd as any);
  await expect(uc.execute({ fullName: 'Ana', email: 'a@a.com', role: ClinicRole.DENTIST, password: 'short' })).rejects.toBeInstanceOf(BadRequestException);
});

it('400 si fullName < 2', async () => {
  const uc = new CreateStaffUseCase(makeRepo() as any, pwd as any);
  await expect(uc.execute({ fullName: 'A', email: 'a@a.com', role: ClinicRole.DENTIST, password: 'secret12' })).rejects.toBeInstanceOf(BadRequestException);
});
```

- [ ] **Step 2: Correr y ver fallar.** Run: `npx jest staff/application/use-cases/create-staff` → FAIL (module not found).
- [ ] **Step 3: Implementar el use-case.**

```ts
import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { STAFF_REPOSITORY } from '../../domain/ports/staff-repository.port';
import type { StaffRepository } from '../../domain/ports/staff-repository.port';
import { StaffMember } from '../../domain/entities/staff-member.entity';
import { PasswordService } from '../../../../shared/crypto/password.service';

export interface CreateStaffInput { fullName: string; email: string; role: ClinicRole; password: string; }

@Injectable()
export class CreateStaffUseCase {
  constructor(
    @Inject(STAFF_REPOSITORY) private readonly repo: StaffRepository,
    private readonly password: PasswordService,
  ) {}

  async execute(input: CreateStaffInput): Promise<StaffMember> {
    const email = input.email.trim().toLowerCase();
    const fullName = input.fullName.trim();
    if (fullName.length < 2) throw new BadRequestException('fullName must be at least 2 characters');
    if (!input.password || input.password.length < 8) throw new BadRequestException('password must be at least 8 characters');
    if (!Object.values(ClinicRole).includes(input.role)) throw new BadRequestException('invalid role');
    if (await this.repo.findUserByEmailGlobal(email)) throw new ConflictException('Email already registered');
    const passwordHash = await this.password.hash(input.password);
    return this.repo.create({ fullName, email, role: input.role, passwordHash });
  }
}
```

- [ ] **Step 4: Añadir `STAFF_WRITE_ROLES`** al final de `clinic-role-sets.ts`:

```ts
// Gestión de personal (crear/editar rol/desactivar): solo gestión.
export const STAFF_WRITE_ROLES: ClinicRole[] = [ClinicRole.OWNER, ClinicRole.ADMIN];
```

- [ ] **Step 5: Correr y ver pasar.** Run: `npx jest staff/application/use-cases/create-staff` → PASS.
- [ ] **Step 6: Commit.** `git commit -am "feat(staff): CreateStaffUseCase + STAFF_WRITE_ROLES"`

---

### Task A4: `UpdateStaffUseCase` (invariante último OWNER)

**Files:**
- Create: `dentalix-api/src/modules/staff/application/use-cases/update-staff.use-case.ts`
- Test: `dentalix-api/src/modules/staff/application/use-cases/update-staff.use-case.spec.ts`

**Interfaces:**
- Consumes: `StaffRepository.findById`, `.updateById`, `.countActiveOwners`.
- Produces: `UpdateStaffUseCase.execute(input: { userId: string; fullName?: string; role?: ClinicRole }): Promise<StaffMember>`

- [ ] **Step 1: Test.**

```ts
import { UpdateStaffUseCase } from './update-staff.use-case';
import { ClinicRole } from '@prisma/client';
import { NotFoundException, ConflictException } from '@nestjs/common';

const member = (role: ClinicRole) => ({ userId: 'u1', fullName: 'Ana', email: 'a@a.com', role });
const makeRepo = (over = {}) => ({
  findById: jest.fn().mockResolvedValue(member(ClinicRole.DENTIST)),
  updateById: jest.fn().mockImplementation(async (_id, p) => ({ ...member(p.role ?? ClinicRole.DENTIST), fullName: p.fullName ?? 'Ana' })),
  countActiveOwners: jest.fn().mockResolvedValue(2),
  ...over,
});

it('actualiza rol y nombre', async () => {
  const repo = makeRepo();
  const uc = new UpdateStaffUseCase(repo as any);
  const r = await uc.execute({ userId: 'u1', role: ClinicRole.ADMIN, fullName: 'Ana R' });
  expect(repo.updateById).toHaveBeenCalledWith('u1', { role: ClinicRole.ADMIN, fullName: 'Ana R' });
  expect(r.role).toBe(ClinicRole.ADMIN);
});

it('404 si no es miembro', async () => {
  const repo = makeRepo({ findById: jest.fn().mockResolvedValue(null) });
  const uc = new UpdateStaffUseCase(repo as any);
  await expect(uc.execute({ userId: 'x', role: ClinicRole.ADMIN })).rejects.toBeInstanceOf(NotFoundException);
});

it('409 al degradar al último OWNER', async () => {
  const repo = makeRepo({ findById: jest.fn().mockResolvedValue(member(ClinicRole.OWNER)), countActiveOwners: jest.fn().mockResolvedValue(1) });
  const uc = new UpdateStaffUseCase(repo as any);
  await expect(uc.execute({ userId: 'u1', role: ClinicRole.ADMIN })).rejects.toBeInstanceOf(ConflictException);
});
```

- [ ] **Step 2: Ver fallar.** Run: `npx jest staff/application/use-cases/update-staff` → FAIL.
- [ ] **Step 3: Implementar.**

```ts
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { STAFF_REPOSITORY } from '../../domain/ports/staff-repository.port';
import type { StaffRepository } from '../../domain/ports/staff-repository.port';
import { StaffMember } from '../../domain/entities/staff-member.entity';

export interface UpdateStaffInput { userId: string; fullName?: string; role?: ClinicRole; }

@Injectable()
export class UpdateStaffUseCase {
  constructor(@Inject(STAFF_REPOSITORY) private readonly repo: StaffRepository) {}
  async execute(input: UpdateStaffInput): Promise<StaffMember> {
    const current = await this.repo.findById(input.userId);
    if (!current) throw new NotFoundException('Staff member not found');
    if (input.role && current.role === ClinicRole.OWNER && input.role !== ClinicRole.OWNER) {
      if ((await this.repo.countActiveOwners()) <= 1) throw new ConflictException('Cannot demote the last owner');
    }
    const patch: { fullName?: string; role?: ClinicRole } = {};
    if (input.role) patch.role = input.role;
    if (input.fullName) patch.fullName = input.fullName.trim();
    const updated = await this.repo.updateById(input.userId, patch);
    if (!updated) throw new NotFoundException('Staff member not found');
    return updated;
  }
}
```

- [ ] **Step 4: Ver pasar.** Run: `npx jest staff/application/use-cases/update-staff` → PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat(staff): UpdateStaffUseCase (last-owner invariant)"`

---

### Task A5: `DeactivateStaffUseCase` (invariantes último OWNER + auto)

**Files:**
- Create: `dentalix-api/src/modules/staff/application/use-cases/deactivate-staff.use-case.ts`
- Test: `dentalix-api/src/modules/staff/application/use-cases/deactivate-staff.use-case.spec.ts`

**Interfaces:**
- Consumes: `StaffRepository.findById`, `.countActiveOwners`, `.deactivateById`.
- Produces: `DeactivateStaffUseCase.execute(input: { userId: string; requestingUserId: string }): Promise<void>`

- [ ] **Step 1: Test.**

```ts
import { DeactivateStaffUseCase } from './deactivate-staff.use-case';
import { ClinicRole } from '@prisma/client';
import { NotFoundException, ConflictException } from '@nestjs/common';

const member = (role: ClinicRole) => ({ userId: 'u1', fullName: 'Ana', email: 'a@a.com', role });
const makeRepo = (over = {}) => ({
  findById: jest.fn().mockResolvedValue(member(ClinicRole.DENTIST)),
  countActiveOwners: jest.fn().mockResolvedValue(2),
  deactivateById: jest.fn().mockResolvedValue(true),
  ...over,
});

it('desactiva un miembro', async () => {
  const repo = makeRepo();
  await new DeactivateStaffUseCase(repo as any).execute({ userId: 'u1', requestingUserId: 'admin' });
  expect(repo.deactivateById).toHaveBeenCalledWith('u1');
});
it('404 si no existe', async () => {
  const repo = makeRepo({ findById: jest.fn().mockResolvedValue(null) });
  await expect(new DeactivateStaffUseCase(repo as any).execute({ userId: 'x', requestingUserId: 'a' })).rejects.toBeInstanceOf(NotFoundException);
});
it('409 al desactivarte a ti mismo', async () => {
  const repo = makeRepo();
  await expect(new DeactivateStaffUseCase(repo as any).execute({ userId: 'u1', requestingUserId: 'u1' })).rejects.toBeInstanceOf(ConflictException);
});
it('409 al desactivar al último OWNER', async () => {
  const repo = makeRepo({ findById: jest.fn().mockResolvedValue(member(ClinicRole.OWNER)), countActiveOwners: jest.fn().mockResolvedValue(1) });
  await expect(new DeactivateStaffUseCase(repo as any).execute({ userId: 'u1', requestingUserId: 'admin' })).rejects.toBeInstanceOf(ConflictException);
});
```

- [ ] **Step 2: Ver fallar.** Run: `npx jest staff/application/use-cases/deactivate-staff` → FAIL.
- [ ] **Step 3: Implementar.**

```ts
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { STAFF_REPOSITORY } from '../../domain/ports/staff-repository.port';
import type { StaffRepository } from '../../domain/ports/staff-repository.port';

export interface DeactivateStaffInput { userId: string; requestingUserId: string; }

@Injectable()
export class DeactivateStaffUseCase {
  constructor(@Inject(STAFF_REPOSITORY) private readonly repo: StaffRepository) {}
  async execute(input: DeactivateStaffInput): Promise<void> {
    if (input.userId === input.requestingUserId) throw new ConflictException('You cannot deactivate yourself');
    const current = await this.repo.findById(input.userId);
    if (!current) throw new NotFoundException('Staff member not found');
    if (current.role === ClinicRole.OWNER && (await this.repo.countActiveOwners()) <= 1) {
      throw new ConflictException('Cannot deactivate the last owner');
    }
    const ok = await this.repo.deactivateById(input.userId);
    if (!ok) throw new NotFoundException('Staff member not found');
  }
}
```

- [ ] **Step 4: Ver pasar.** Run: `npx jest staff/application/use-cases/deactivate-staff` → PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat(staff): DeactivateStaffUseCase (last-owner + self invariants)"`

---

### Task A6: DTOs, controller y wiring del módulo

**Files:**
- Create: `dentalix-api/src/modules/staff/presentation/dto/create-staff.dto.ts`
- Create: `dentalix-api/src/modules/staff/presentation/dto/update-staff.dto.ts`
- Modify: `dentalix-api/src/modules/staff/presentation/staff.controller.ts`
- Modify: `dentalix-api/src/modules/staff/staff.module.ts`

**Interfaces:**
- Consumes: los tres use-cases (A3–A5).
- Produces: `POST /staff`, `PATCH /staff/:userId`, `DELETE /staff/:userId`.

- [ ] **Step 1: `CreateStaffDto`.**

```ts
import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsString, MinLength } from 'class-validator';
import { ClinicRole } from '@prisma/client';

export class CreateStaffDto {
  @ApiProperty() @IsString() @MinLength(2) fullName!: string;
  @ApiProperty() @IsEmail() email!: string;
  @ApiProperty({ enum: ClinicRole }) @IsEnum(ClinicRole) role!: ClinicRole;
  @ApiProperty({ minLength: 8 }) @IsString() @MinLength(8) password!: string;
}
```

- [ ] **Step 2: `UpdateStaffDto`.**

```ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { ClinicRole } from '@prisma/client';

export class UpdateStaffDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) fullName?: string;
  @ApiPropertyOptional({ enum: ClinicRole }) @IsOptional() @IsEnum(ClinicRole) role?: ClinicRole;
}
```

- [ ] **Step 3: Ampliar el controller** (mantener `GET` intacto). Añadir imports y rutas:

```ts
@Post()
@Roles(...STAFF_WRITE_ROLES)
@ApiCreatedResponse({ type: StaffMemberDto })
create(@Body() dto: CreateStaffDto): Promise<StaffMember> {
  return this.createStaff.execute(dto);
}

@Patch(':userId')
@Roles(...STAFF_WRITE_ROLES)
@ApiOkResponse({ type: StaffMemberDto })
update(@Param('userId', ParseUUIDPipe) userId: string, @Body() dto: UpdateStaffDto): Promise<StaffMember> {
  return this.updateStaff.execute({ userId, ...dto });
}

@Delete(':userId')
@Roles(...STAFF_WRITE_ROLES)
@HttpCode(204)
async remove(@Param('userId', ParseUUIDPipe) userId: string, @Req() req: { user: { sub: string } }): Promise<void> {
  await this.deactivateStaff.execute({ userId, requestingUserId: req.user.sub });
}
```

Notas: el `@Roles(...PATIENT_ROLES)` a nivel de clase se mantiene para `GET`; se sobreescribe por método con `@Roles(...STAFF_WRITE_ROLES)` (el `RolesGuard` lee el metadata más específico del handler — verificar en `roles.guard.ts` que usa `getAllAndOverride([handler, class])`; si usa solo class, mover el `@Roles` de clase a cada método). Inyectar `CreateStaffUseCase`, `UpdateStaffUseCase`, `DeactivateStaffUseCase` en el constructor.

- [ ] **Step 4: Registrar en el módulo.** En `staff.module.ts` añadir a `providers`: `CreateStaffUseCase`, `UpdateStaffUseCase`, `DeactivateStaffUseCase`, `PasswordService`.
- [ ] **Step 5: Compilar + arrancar.** Run: `npx tsc --noEmit` → OK.
- [ ] **Step 6: Commit.** `git commit -am "feat(staff): POST/PATCH/DELETE endpoints + DTOs + wiring"`

---

### Task A7: e2e de staff

**Files:**
- Create: `dentalix-api/test/staff.e2e-spec.ts` (mirror del e2e existente más cercano, p. ej. `test/appointments.e2e-spec.ts` — mismo bootstrap, `X-Tenant-Host`, helpers de registro/login).

**Interfaces:** consume la app completa vía Supertest.

- [ ] **Step 1: Escribir el e2e.** Casos:
  1. OWNER registra clínica → `POST /staff` crea un DENTIST → `GET /staff` lo incluye (con `email`) → el DENTIST puede `POST /auth/login` (host de la clínica) y recibe tokens.
  2. `PATCH /staff/:id` cambia el rol del DENTIST a ASSISTANT (como OWNER) → 200, rol actualizado en `GET /staff`.
  3. Un DENTIST (sin permiso) hace `POST /staff` → 403.
  4. `DELETE /staff/:id` del último OWNER → 409; `DELETE` de un miembro normal → 204 y desaparece de `GET /staff`.
  5. `POST /staff` con email ya usado → 409.
- [ ] **Step 2: Correr.** Run: `cd dentalix-api && npm run test:e2e -- staff` → PASS (usa la BD de test como el resto de e2e).
- [ ] **Step 3: Commit.** `git commit -am "test(staff): e2e create/list/login/update/deactivate/permissions"`

---

# PARTE A — CRUD de personal (Web)

> Antes de esta parte: crear rama en Web (`cd dentalix-web && git checkout -b feat/ola1-cimientos-operativos`) y **leer `node_modules/next/dist/docs`** lo relevante a rutas/route groups/client components.

### Task A8: Cliente API de staff (create/update/deactivate)

**Files:**
- Modify: `dentalix-web/src/lib/appointments/staff-api.ts` (añadir `email` al tipo `StaffMember`)
- Create: `dentalix-web/src/lib/staff/staff-api.ts`
- Test: `dentalix-web/src/lib/staff/staff-api.test.ts`

**Interfaces:**
- Produces:
  - `createStaff(token, input: { fullName; email; role; password }): Promise<StaffMember>` → `POST /staff`
  - `updateStaff(token, userId, patch: { fullName?; role? }): Promise<StaffMember>` → `PATCH /staff/:userId`
  - `deactivateStaff(token, userId): Promise<void>` → `DELETE /staff/:userId`
  - Reexporta `listStaff`, `StaffMember`, `ClinicRole` type.

- [ ] **Step 1: Test del cliente** (mockear `doFetch`/`fetch` igual que `src/lib/api/client.test.ts` y otros `*-api.test.ts`): verifica método, path y payload de `createStaff`/`updateStaff`/`deactivateStaff`.
- [ ] **Step 2: Ver fallar.** Run: `cd dentalix-web && npx jest src/lib/staff/staff-api` → FAIL.
- [ ] **Step 3: Implementar** siguiendo el patrón exacto de `src/lib/appointments/appointments-api.ts` (usa el `doFetch`/cliente base con `Authorization` + `X-Tenant-Host`). Añadir `email: string` a `StaffMember` en `appointments/staff-api.ts` y `ClinicRole` union type (`'OWNER'|'DENTIST'|'ASSISTANT'|'RECEPTION'|'ADMIN'`) si no existe.
- [ ] **Step 4: Ver pasar.** Run: `npx jest src/lib/staff/staff-api` → PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat(web/staff): API client create/update/deactivate + email in StaffMember"`

---

### Task A9: Componente `StaffView`

**Files:**
- Create: `dentalix-web/src/components/staff/staff-view.tsx`
- Test: `dentalix-web/src/components/staff/staff-view.test.tsx`

**Interfaces:**
- Consumes: `listStaff`, `createStaff`, `updateStaff`, `deactivateStaff`.
- Produces: `<StaffView token={string} currentUserId={string} />`

- [ ] **Step 1: Test de componente** (Testing Library, mock del cliente):
  - Renderiza filas desde `listStaff` (nombre, email, rol).
  - El formulario de alta llama `createStaff` con el payload y refresca la lista.
  - "Desactivar" pide confirmación (botón confirmar visible) y llama `deactivateStaff`.
  - Un error de `createStaff` (p. ej. 409) muestra `role="alert"`.
- [ ] **Step 2: Ver fallar.** Run: `npx jest src/components/staff/staff-view` → FAIL.
- [ ] **Step 3: Implementar** el componente cliente, calcando la orquestación de `AgendaView` (estados loading/error/refresh, copy `es` en constantes, UI kit `Card`/`Button`/`Input`/`FormField`, `<select>` nativo para el rol como en `AgendaView`). Alta inline (sección revelada con `aria-expanded`, sin modal). Confirmación de desactivar: botón que revela "¿Confirmar?" inline. No permitir desactivarse a sí mismo (ocultar/deshabilitar acción si `member.userId === currentUserId`).
- [ ] **Step 4: Ver pasar.** Run: `npx jest src/components/staff/staff-view` → PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat(web/staff): StaffView (list + create + edit role + deactivate)"`

---

### Task A10: Página `/staff` + navegación

**Files:**
- Create: `dentalix-web/src/app/(app)/staff/page.tsx`
- Modify: `dentalix-web/src/components/app-shell.tsx` (ítem "Personal")

**Interfaces:** consume `StaffView`.

- [ ] **Step 1:** Crear `page.tsx` como shell delgado de hidratación que obtiene `token` y `currentUserId` del auth store (mirar `agenda/page.tsx`) y renderiza `<StaffView token={token} currentUserId={...} />`.
- [ ] **Step 2:** Añadir ítem "Personal" al nav en `app-shell.tsx` (mismo patrón que "Pacientes"/"Agenda"), visible para OWNER/ADMIN (leer rol del auth store; si no está disponible el rol en el store, mostrarlo siempre por ahora y anotar TODO — no bloquea).
- [ ] **Step 3: Verificar en la app** (con la API y el web levantados): navegar a `demo.localhost:3001/staff`, crear un DENTIST, verlo en la lista, cambiar rol, desactivar.
- [ ] **Step 4: Commit.** `git commit -am "feat(web/staff): /staff page + nav item"`

---

# PARTE C — Vista semanal de la agenda (Web)

### Task C1: Helper `weekRange`

**Files:**
- Modify: `dentalix-web/src/lib/appointments/day-range.ts`
- Test: `dentalix-web/src/lib/appointments/day-range.test.ts`

**Interfaces:**
- Produces: `weekRange(dateStr: string): { from: string; to: string }` — lunes 00:00:00 a domingo 23:59:59.999 local, en ISO, para la semana que contiene `dateStr`. (Mirar la firma exacta de `localDayRange` para devolver el mismo formato.)

- [ ] **Step 1: Test.** Casos: una fecha entre semana devuelve el lunes y domingo correctos; un domingo devuelve su propia semana (lunes anterior→ese domingo); borde de fin de mes (p. ej. `2026-07-01` miércoles → lunes `2026-06-29`). Comparar contra lo que produce `localDayRange` para consistencia de formato.
- [ ] **Step 2: Ver fallar.** Run: `npx jest src/lib/appointments/day-range` → FAIL.
- [ ] **Step 3: Implementar** `weekRange` reutilizando `localDayRange` para los extremos: `from = localDayRange(monday).from`, `to = localDayRange(sunday).to`. Calcular el lunes con aritmética de `Date` local (`getDay()`, domingo=0 → tratar como 7).
- [ ] **Step 4: Ver pasar.** Run: `npx jest src/lib/appointments/day-range` → PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat(web/agenda): weekRange helper (Mon–Sun local)"`

---

### Task C2: Componente `WeekAgenda`

**Files:**
- Create: `dentalix-web/src/components/appointments/week-agenda.tsx`
- Test: `dentalix-web/src/components/appointments/week-agenda.test.tsx`

**Interfaces:**
- Produces: `<WeekAgenda appointments={Appointment[]} weekStart={string} patientNames={Record<string,string>} loading={boolean} error={string|null} onSelectDay={(dateStr: string) => void} />`

- [ ] **Step 1: Test.** Con citas repartidas en varios días: renderiza 7 columnas (lunes–domingo) con encabezado de fecha; cada cita aparece en su día con hora + nombre de paciente + estado; click en el encabezado de un día invoca `onSelectDay('YYYY-MM-DD')`; estados loading/error/empty.
- [ ] **Step 2: Ver fallar.** Run: `npx jest src/components/appointments/week-agenda` → FAIL.
- [ ] **Step 3: Implementar.** Grilla de 7 columnas (CSS grid). Agrupar `appointments` por día local. Reutilizar el formateo de hora/estado de `day-agenda.tsx` (extraer un helper compartido si es trivial, si no duplicar el badge de estado). Sin edición de estado ni drag (fuera de alcance).
- [ ] **Step 4: Ver pasar.** Run: `npx jest src/components/appointments/week-agenda` → PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat(web/agenda): WeekAgenda 7-day grid"`

---

### Task C3: Interruptor Día | Semana en `AgendaView`

**Files:**
- Modify: `dentalix-web/src/components/appointments/agenda-view.tsx`
- Modify: `dentalix-web/src/components/appointments/agenda-view.test.tsx`

**Interfaces:** consume `weekRange`, `WeekAgenda`.

- [ ] **Step 1: Test (extender el existente).** Un control `Día | Semana` (radio/segmented). Al pasar a "Semana": se consulta `listAppointments` con el rango de `weekRange(selectedDate)` y se renderiza `WeekAgenda`; click en un día vuelve a "Día" con esa fecha (`selectedDate` cambia y se ve `DayAgenda`).
- [ ] **Step 2: Ver fallar.** Run: `npx jest src/components/appointments/agenda-view` → FAIL.
- [ ] **Step 3: Implementar.** Añadir estado `viewMode: 'day'|'week'`. En el efecto de carga y en `refreshAppointmentsInPlace`, elegir `localDayRange(selectedDate)` o `weekRange(selectedDate)` según `viewMode`. Render condicional `DayAgenda`/`WeekAgenda`. `onSelectDay` setea `selectedDate` y `viewMode='day'`. Mantener el selector de profesional (la semana también filtra por profesional).
- [ ] **Step 4: Ver pasar.** Run: `npx jest src/components/appointments/agenda-view` → PASS.
- [ ] **Step 5: Verificar en la app** y **Commit.** `git commit -am "feat(web/agenda): Día|Semana toggle + week view"`

---

# PARTE B — Dashboard del doctor (Web)

### Task B1: Clientes API `dashboard` y `sales`

**Files:**
- Create: `dentalix-web/src/lib/dashboard/dashboard-api.ts`
- Create: `dentalix-web/src/lib/sales/sales-api.ts`
- Test: `dentalix-web/src/lib/dashboard/dashboard-api.test.ts`, `dentalix-web/src/lib/sales/sales-api.test.ts`

**Interfaces:**
- Produces:
  - `getDashboard(token, { from, to, currency }): Promise<DashboardResult>` → `GET /dashboard?from&to&currency`
    - `DashboardResult` = `{ period; sales; lowStockItems: { count; items: {id;name;unit;stock;minStock}[] }; upcomingAppointments; patientCount: number }` (mirror del `GetDoctorDashboardResult` del API).
  - `getSalesTotals(token, { from, to, currency }): Promise<SalesTotals>` → `GET /sales/totals?from&to&currency`
    - `SalesTotals` = `{ from; to; currency; totalConverted: number; count: number; byCurrency: Record<string,number> }`.

- [ ] **Step 1: Tests** de ambos clientes (método GET, query params correctos, parseo de la respuesta) mockeando el fetch base.
- [ ] **Step 2: Ver fallar.** Run: `npx jest src/lib/dashboard src/lib/sales` → FAIL.
- [ ] **Step 3: Implementar** ambos, patrón de `appointments-api.ts` (querystring con `URLSearchParams`, `Authorization` + `X-Tenant-Host` vía cliente base).
- [ ] **Step 4: Ver pasar.** Run: `npx jest src/lib/dashboard src/lib/sales` → PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat(web/dashboard): dashboard + sales-totals API clients"`

---

### Task B2: Componente `DashboardView`

**Files:**
- Create: `dentalix-web/src/components/dashboard/dashboard-view.tsx`
- Test: `dentalix-web/src/components/dashboard/dashboard-view.test.tsx`

**Interfaces:**
- Consumes: `getSalesTotals`, `getDashboard`, `listAppointments`, `listPatients`, `listStaff`.
- Produces: `<DashboardView token={string} />`

- [ ] **Step 1: Test.**
  - Renderiza tres tarjetas de ingresos (día/semana/mes) con `totalConverted` formateado, desde `getSalesTotals` (3 rangos).
  - Cambiar el selector de moneda (COP→USD) reconsulta `getSalesTotals`/`getDashboard` con `currency: 'USD'`.
  - Lista "Citas de hoy" desde `listAppointments` del rango de hoy, resolviendo nombre de paciente y de profesional.
  - Muestra `patientCount` y la lista de stock bajo desde `getDashboard`.
  - Estados loading/error con `role="alert"`.
- [ ] **Step 2: Ver fallar.** Run: `npx jest src/components/dashboard/dashboard-view` → FAIL.
- [ ] **Step 3: Implementar.** Copy `es` en constantes. Calcular rangos día/semana/mes con `localDayRange`/`weekRange` + un `monthRange` local (inline). Selector de moneda `<select>` (COP/USD), estado `currency`. Cargar en paralelo (`Promise.all`) al montar y al cambiar moneda. "Citas de hoy": `listAppointments({ from, to })` (rango de hoy, sin `providerId`), mapear `patientNames` (de `listPatients`) y `providerNames` (de `listStaff`). Formateo de moneda con `Intl.NumberFormat`. Tarjetas con el UI kit (`Card`).
- [ ] **Step 4: Ver pasar.** Run: `npx jest src/components/dashboard/dashboard-view` → PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat(web/dashboard): DashboardView (revenue tiles + today + stock + count)"`

---

### Task B3: Página `/dashboard` + navegación

**Files:**
- Create: `dentalix-web/src/app/(app)/dashboard/page.tsx`
- Modify: `dentalix-web/src/components/app-shell.tsx` (ítem "Panel")

**Interfaces:** consume `DashboardView`.

- [ ] **Step 1:** `page.tsx` shell de hidratación (mirror `agenda/page.tsx`) que pasa `token` a `<DashboardView />`.
- [ ] **Step 2:** Ítem "Panel" en el nav (OWNER/ADMIN). Si un rol sin permiso navega directo, el `GET /dashboard` devuelve 403 → `DashboardView` muestra el error; aceptable en v1.
- [ ] **Step 3: Verificar en la app:** entrar como OWNER a `demo.localhost:3001/dashboard`, registrar una venta de prueba (vía API/curl si no hay UI de ventas) y una cita para hoy, ver que las tarjetas y "Citas de hoy" reflejan los datos; cambiar la moneda.
- [ ] **Step 4: Commit.** `git commit -am "feat(web/dashboard): /dashboard page + nav item"`

---

## Cierre

- [ ] **Correr toda la suite API:** `cd dentalix-api && npx jest && npm run test:e2e`.
- [ ] **Correr toda la suite Web:** `cd dentalix-web && npx jest`.
- [ ] **Lint ambos:** `npm run lint` en cada repo.
- [ ] **Verificación manual** de los tres flujos con API+Web levantados en `demo.localhost:3001`.
- [ ] **Abrir PRs** (uno por repo) contra `main` desde `feat/ola1-cimientos-operativos`.

## Self-Review (cobertura del spec)

- **Parte A (staff API):** A1 (email) · A2 (repo) · A3 (create) · A4 (update+invariante) · A5 (deactivate+invariantes) · A6 (endpoints/permisos) · A7 (e2e). ✔
- **Parte A (staff web):** A8 (cliente) · A9 (componente) · A10 (página/nav). ✔
- **Parte B (dashboard web):** B1 (clientes) · B2 (componente: ingresos día/semana/mes + selector moneda + citas de hoy + # pacientes + stock) · B3 (página/nav). ✔ Acceso OWNER/ADMIN cubierto por el backend + ocultar ítem.
- **Parte C (semana web):** C1 (weekRange) · C2 (WeekAgenda) · C3 (toggle). ✔ Sin drag-and-drop/mes (no-goals respetados).
- **Sin cambios de esquema Prisma** ✔ (solo lecturas/escrituras sobre modelos existentes).
