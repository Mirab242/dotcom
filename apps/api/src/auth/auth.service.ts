import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { Role } from '@dot-trader/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { TwoFactorService } from './two-factor.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { isBlockedByPersonalMode, isPersonalMode } from '../common/personal-mode.util';

const BCRYPT_ROUNDS = 12;

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
    private twoFactor: TwoFactorService,
    private walletService: WalletService,
  ) {}

  async register(dto: RegisterDto) {
    if (isPersonalMode(this.config)) {
      throw new ForbiddenException('Inscriptions fermées : plateforme à usage personnel');
    }
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException('Un compte existe déjà avec cet email');
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const referralCode = crypto.randomBytes(4).toString('hex').toUpperCase();
    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash,
        role: Role.USER,
        referralCode,
        referredByCode: dto.referralCode ?? null,
      },
    });
    // Le crédit de départ fictif (1000 USDT) n'a de sens qu'en testnet — en mode live, un
    // nouveau compte doit obligatoirement partir à zéro et passer par un vrai dépôt
    // (validé par un admin, §4.6bis), sinon n'importe qui pourrait trader avec le capital
    // réel de la plateforme sans jamais avoir rien déposé.
    if (this.config.get<string>('LIVE_TRADING_ENABLED') !== 'true') {
      await this.walletService.seedInitialBalance(user.id);
    }

    return this.issueTokens(user.id, user.email, user.role);
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!user) throw new UnauthorizedException('Identifiants invalides');

    const passwordOk = await bcrypt.compare(dto.password, user.passwordHash);
    if (!passwordOk) throw new UnauthorizedException('Identifiants invalides');

    if (user.status !== 'active') {
      throw new UnauthorizedException('Compte suspendu');
    }
    if (await isBlockedByPersonalMode(this.config, this.prisma, user.role)) {
      throw new UnauthorizedException('Accès réservé au propriétaire de la plateforme');
    }

    if (user.twoFaEnabled) {
      if (!dto.twoFaCode) {
        // Le front doit alors afficher le champ code 2FA et renvoyer la requête.
        throw new UnauthorizedException('Code 2FA requis');
      }
      const valid = this.twoFactor.verifyCode(user.twoFaSecret!, dto.twoFaCode);
      if (!valid) throw new UnauthorizedException('Code 2FA invalide');
    }

    return this.issueTokens(user.id, user.email, user.role);
  }

  async setup2fa(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const { secret, otpauthUrl } = this.twoFactor.generateSecret(user.email);
    // Le secret n'est PAS encore activé (twoFaEnabled reste false) tant que l'utilisateur
    // n'a pas confirmé avec un code valide via confirm2fa() — évite de se verrouiller
    // hors de son compte avec un secret mal scanné.
    await this.prisma.user.update({ where: { id: userId }, data: { twoFaSecret: secret } });
    const qrCodeDataUrl = await this.twoFactor.generateQrCodeDataUrl(otpauthUrl);
    return { qrCodeDataUrl, secret };
  }

  async confirm2fa(userId: string, code: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.twoFaSecret) {
      throw new BadRequestException('Aucune procédure 2FA en cours — appelez setup2fa d\'abord');
    }
    const valid = this.twoFactor.verifyCode(user.twoFaSecret, code);
    if (!valid) throw new UnauthorizedException('Code 2FA invalide');

    await this.prisma.user.update({ where: { id: userId }, data: { twoFaEnabled: true } });
    return { enabled: true };
  }

  async refresh(refreshToken: string) {
    let payload: { sub: string };
    try {
      payload = this.jwt.verify(refreshToken, {
        secret: this.config.get<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Refresh token invalide ou expiré');
    }

    const tokenHash = this.hashToken(refreshToken);
    const stored = await this.prisma.refreshToken.findFirst({
      where: { userId: payload.sub, tokenHash, revokedAt: null },
    });
    if (!stored || stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token révoqué ou expiré');
    }

    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: payload.sub } });
    if (await isBlockedByPersonalMode(this.config, this.prisma, user.role)) {
      throw new UnauthorizedException('Accès réservé au propriétaire de la plateforme');
    }

    // Rotation : on révoque l'ancien refresh token et on en émet un nouveau.
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    return this.issueTokens(user.id, user.email, user.role);
  }

  async logout(userId: string, refreshToken: string) {
    const tokenHash = this.hashToken(refreshToken);
    await this.prisma.refreshToken.updateMany({
      where: { userId, tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { loggedOut: true };
  }

  private async issueTokens(userId: string, email: string, role: string) {
    const payload = { sub: userId, email, role };

    const accessToken = this.jwt.sign(payload, {
      secret: this.config.get<string>('JWT_ACCESS_SECRET'),
      expiresIn: this.config.get<string>('JWT_ACCESS_EXPIRES_IN', '15m'),
    });
    const refreshToken = this.jwt.sign(payload, {
      secret: this.config.get<string>('JWT_REFRESH_SECRET'),
      expiresIn: this.config.get<string>('JWT_REFRESH_EXPIRES_IN', '7d'),
    });

    const expiresInDays = 7;
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: this.hashToken(refreshToken),
        expiresAt: new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000),
      },
    });

    return { accessToken, refreshToken, user: { id: userId, email, role } };
  }

  // On ne stocke jamais le refresh token en clair en base — seulement son hash.
  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  async bootstrapAdmin(userId: string) {
    const adminCount = await this.prisma.user.count({ where: { role: Role.ADMIN } });
    if (adminCount > 0) {
      throw new ForbiddenException('Un admin existe déjà — ce endpoint ne sert qu\'à amorcer le tout premier compte.');
    }
    const user = await this.prisma.user.update({ where: { id: userId }, data: { role: Role.ADMIN } });
    await this.prisma.auditLog.create({
      data: { actorId: userId, action: 'user.role.admin', target: userId, metadata: JSON.stringify({ via: 'bootstrap' }) },
    });
    const { passwordHash, twoFaSecret, ...safe } = user;
    return safe;
  }
}
