import { ConfigService } from '@nestjs/config';
import { Role } from '@dot-trader/shared-types';
import { PrismaService } from '../prisma/prisma.service';

/**
 * MODE PERSONNEL (PERSONAL_MODE=true) : la plateforme n'est utilisée que par son propriétaire.
 *  - les inscriptions sont fermées ;
 *  - seuls les comptes admin peuvent se connecter et appeler l'API (les autres sont refusés,
 *    y compris avec un jeton encore valide).
 * Désactivé par défaut : sans cette variable, le comportement multi-utilisateurs est inchangé.
 */
export function isPersonalMode(config: ConfigService): boolean {
  return config.get<string>('PERSONAL_MODE') === 'true';
}

/**
 * Vrai si ce compte doit être refusé en mode personnel : rôle non-admin ET au moins un admin actif
 * existe. La deuxième condition évite de s'enfermer dehors : tant qu'aucun admin n'existe, un compte
 * normal doit pouvoir se connecter pour s'auto-promouvoir via POST /auth/bootstrap-admin.
 */
export async function isBlockedByPersonalMode(
  config: ConfigService,
  prisma: PrismaService,
  role: string,
): Promise<boolean> {
  if (!isPersonalMode(config) || role === Role.ADMIN) return false;
  const activeAdmins = await prisma.user.count({ where: { role: Role.ADMIN, status: 'active' } });
  return activeAdmins > 0;
}
