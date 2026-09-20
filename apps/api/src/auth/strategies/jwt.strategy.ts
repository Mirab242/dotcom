import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../prisma/prisma.service';
import { isBlockedByPersonalMode } from '../../common/personal-mode.util';

export interface JwtPayload {
  sub: string; // userId
  email: string;
  role: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_ACCESS_SECRET'),
    });
  }

  /**
   * Le retour de validate() devient `request.user` (voir CurrentUser decorator). On revérifie
   * le statut/rôle en base à chaque requête plutôt que de faire confiance au JWT émis à la
   * connexion : sinon un compte suspendu ou un admin rétrogradé garde l'accès jusqu'à
   * l'expiration du token (15 min par défaut) — trop long pour un compte gérant des fonds réels.
   */
  async validate(payload: JwtPayload) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { status: true, role: true },
    });
    if (!user || user.status !== 'active') {
      throw new UnauthorizedException('Compte suspendu ou introuvable');
    }
    // Mode personnel : un jeton encore valide d'un compte non-admin ne doit plus rien ouvrir.
    if (await isBlockedByPersonalMode(this.config, this.prisma, user.role)) {
      throw new UnauthorizedException('Accès réservé au propriétaire de la plateforme');
    }
    return { userId: payload.sub, email: payload.email, role: user.role };
  }
}
