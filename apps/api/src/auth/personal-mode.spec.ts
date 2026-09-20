/**
 * Mode personnel (PERSONAL_MODE=true) : la plateforme n'est utilisée que par son propriétaire.
 * Tests unitaires purs (prisma / jwt simulés) — ils tournent sans base de données.
 */
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';

type Users = { id: string; email: string; role: string; status: string; passwordHash?: string; twoFaEnabled?: boolean }[];

function makeEnv(personal: boolean, users: Users) {
  const config = { get: (k: string, d?: string) => ({ PERSONAL_MODE: personal ? 'true' : 'false', JWT_ACCESS_SECRET: 'a', JWT_REFRESH_SECRET: 'r' } as Record<string, string>)[k] ?? d };
  const prisma: any = {
    user: {
      findUnique: async ({ where }: any) => users.find((u) => u.id === where.id || u.email === where.email) ?? null,
      findUniqueOrThrow: async ({ where }: any) => users.find((u) => u.id === where.id)!,
      count: async ({ where }: any = {}) =>
        users.filter((u) => (!where?.role || u.role === where.role) && (!where?.status || u.status === where.status)).length,
      create: jest.fn(async ({ data }: any) => ({ id: 'new', ...data })),
    },
    refreshToken: { create: async () => ({}), findFirst: async () => ({ id: 'rt', expiresAt: new Date(Date.now() + 1e9) }), update: async () => ({}) },
  };
  const jwt: any = { sign: () => 'tok', verify: () => ({ sub: 'u-user' }) };
  const wallet: any = { seedInitialBalance: jest.fn() };
  const auth = new AuthService(prisma, jwt, config as any, {} as any, wallet);
  const strategy = new JwtStrategy(config as any, prisma);
  return { auth, strategy, prisma, wallet };
}

describe('mode personnel', () => {
  let hash: string;
  beforeAll(async () => { hash = await bcrypt.hash('MotDePasse-Test-123', 4); });
  const mk = (): Users => [
    { id: 'u-admin', email: 'moi@test.io', role: 'admin', status: 'active', passwordHash: hash },
    { id: 'u-user', email: 'autre@test.io', role: 'user', status: 'active', passwordHash: hash },
  ];

  describe('inscription', () => {
    it('est FERMÉE quand PERSONAL_MODE=true', async () => {
      const { auth, prisma } = makeEnv(true, mk());
      await expect(auth.register({ email: 'intrus@test.io', password: 'MotDePasse-Test-123' })).rejects.toThrow(ForbiddenException);
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('reste OUVERTE sans PERSONAL_MODE (comportement multi-utilisateurs inchangé)', async () => {
      const { auth, prisma } = makeEnv(false, mk());
      const r = await auth.register({ email: 'nouveau@test.io', password: 'MotDePasse-Test-123' });
      expect(prisma.user.create).toHaveBeenCalled();
      expect(r.user.email).toBe('nouveau@test.io');
    });
  });

  describe('connexion', () => {
    it('le propriétaire (admin) peut se connecter', async () => {
      const { auth } = makeEnv(true, mk());
      const r = await auth.login({ email: 'moi@test.io', password: 'MotDePasse-Test-123' } as any);
      expect(r.user.role).toBe('admin');
    });

    it('un compte non-admin est REFUSÉ dès qu\'un admin existe', async () => {
      const { auth } = makeEnv(true, mk());
      await expect(auth.login({ email: 'autre@test.io', password: 'MotDePasse-Test-123' } as any)).rejects.toThrow(/propriétaire/);
    });

    it('sans PERSONAL_MODE, un compte normal se connecte toujours', async () => {
      const { auth } = makeEnv(false, mk());
      const r = await auth.login({ email: 'autre@test.io', password: 'MotDePasse-Test-123' } as any);
      expect(r.user.role).toBe('user');
    });

    it('ANTI-VERROUILLAGE : tant qu\'aucun admin n\'existe, un compte normal peut se connecter (pour s\'auto-promouvoir)', async () => {
      const { auth } = makeEnv(true, [{ id: 'u-user', email: 'autre@test.io', role: 'user', status: 'active', passwordHash: hash }]);
      const r = await auth.login({ email: 'autre@test.io', password: 'MotDePasse-Test-123' } as any);
      expect(r.user.role).toBe('user');
    });

    it('un admin SUSPENDU ne compte pas comme admin actif (pas de verrouillage si le seul admin est suspendu)', async () => {
      const users = mk();
      users[0].status = 'suspended';
      const { auth } = makeEnv(true, users);
      const r = await auth.login({ email: 'autre@test.io', password: 'MotDePasse-Test-123' } as any);
      expect(r.user.role).toBe('user');
    });

    it('mauvais mot de passe : message générique inchangé', async () => {
      const { auth } = makeEnv(true, mk());
      await expect(auth.login({ email: 'moi@test.io', password: 'faux' } as any)).rejects.toThrow('Identifiants invalides');
    });
  });

  describe('refresh du jeton', () => {
    it('refusé pour un non-admin en mode personnel', async () => {
      const { auth } = makeEnv(true, mk());
      await expect(auth.refresh('any')).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('chaque appel API (jeton déjà émis)', () => {
    it('un jeton valide d\'un non-admin est refusé en mode personnel', async () => {
      const { strategy } = makeEnv(true, mk());
      await expect(strategy.validate({ sub: 'u-user', email: 'autre@test.io', role: 'user' })).rejects.toThrow(/propriétaire/);
    });

    it('le propriétaire passe', async () => {
      const { strategy } = makeEnv(true, mk());
      await expect(strategy.validate({ sub: 'u-admin', email: 'moi@test.io', role: 'admin' })).resolves.toMatchObject({ role: 'admin' });
    });

    it('sans PERSONAL_MODE, un non-admin passe comme avant', async () => {
      const { strategy } = makeEnv(false, mk());
      await expect(strategy.validate({ sub: 'u-user', email: 'autre@test.io', role: 'user' })).resolves.toMatchObject({ role: 'user' });
    });

    it('le rôle est relu en base : un ex-admin rétrogradé est refusé même avec un vieux jeton "admin"', async () => {
      const users = mk();
      users[0].role = 'user'; // rétrogradé — plus aucun admin → anti-verrouillage : autorisé
      users.push({ id: 'u-admin2', email: 'a2@test.io', role: 'admin', status: 'active' });
      const { strategy } = makeEnv(true, users);
      await expect(strategy.validate({ sub: 'u-admin', email: 'moi@test.io', role: 'admin' })).rejects.toThrow(/propriétaire/);
    });
  });
});
