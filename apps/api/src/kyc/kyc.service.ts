import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SubmitKycDto } from './dto/submit-kyc.dto';

/**
 * Vérification d'identité — pas encore exigée pour trader tant que tout reste en testnet
 * (aucun fonds réel). Devient nécessaire dès l'acceptation de dépôts réels si le statut
 * PSAN/VASP l'impose (§8 ARCHITECTURE.md). Document stocké en base (base64) : acceptable pour
 * un volume restreint d'utilisateurs, à remplacer par un vrai stockage objet avant d'ouvrir
 * largement (voir commentaire schema.prisma).
 */
@Injectable()
export class KycService {
  constructor(private prisma: PrismaService) {}

  async submit(userId: string, dto: SubmitKycDto) {
    const existing = await this.prisma.kycSubmission.findFirst({
      where: { userId, status: 'pending' },
    });
    if (existing) {
      throw new BadRequestException('Une demande est déjà en cours de traitement');
    }

    const submission = await this.prisma.kycSubmission.create({
      data: {
        userId,
        fullName: dto.fullName,
        dateOfBirth: dto.dateOfBirth,
        country: dto.country,
        idDocumentType: dto.idDocumentType,
        idDocumentNumber: dto.idDocumentNumber,
        documentImageB64: dto.documentImageB64,
      },
    });
    await this.prisma.user.update({ where: { id: userId }, data: { kycStatus: 'pending' } });
    return { id: submission.id, status: submission.status, createdAt: submission.createdAt };
  }

  async getMine(userId: string) {
    const submission = await this.prisma.kycSubmission.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        rejectionReason: true,
        createdAt: true,
        reviewedAt: true,
        fullName: true,
        country: true,
        idDocumentType: true,
      },
    });
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { kycStatus: true } });
    return { kycStatus: user.kycStatus, submission };
  }

  // --- Admin ---

  async listPending() {
    // documentImageB64 volontairement exclu ici — potentiellement plusieurs Mo par soumission,
    // seul getSubmissionDocument() le renvoie, à la demande, pour une soumission précise.
    return this.prisma.kycSubmission.findMany({
      where: { status: 'pending' },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        fullName: true,
        dateOfBirth: true,
        country: true,
        idDocumentType: true,
        idDocumentNumber: true,
        status: true,
        createdAt: true,
        user: { select: { email: true } },
      },
    });
  }

  async getSubmissionDocument(submissionId: string) {
    const submission = await this.prisma.kycSubmission.findUnique({
      where: { id: submissionId },
      select: { documentImageB64: true },
    });
    if (!submission) throw new NotFoundException('Demande introuvable');
    return { documentImageB64: submission.documentImageB64 };
  }

  async approve(adminId: string, submissionId: string) {
    const submission = await this.prisma.kycSubmission.findUnique({ where: { id: submissionId } });
    if (!submission) throw new NotFoundException('Demande introuvable');

    const claim = await this.prisma.kycSubmission.updateMany({
      where: { id: submissionId, status: 'pending' },
      data: { status: 'approved', reviewedByAdminId: adminId, reviewedAt: new Date() },
    });
    if (claim.count === 0) throw new BadRequestException('Demande déjà traitée');

    await this.prisma.user.update({ where: { id: submission.userId }, data: { kycStatus: 'verified' } });
    await this.prisma.auditLog.create({
      data: { actorId: adminId, action: 'kyc.approved', target: submission.userId },
    });
    return this.prisma.kycSubmission.findUniqueOrThrow({ where: { id: submissionId } });
  }

  async reject(adminId: string, submissionId: string, reason: string) {
    const submission = await this.prisma.kycSubmission.findUnique({ where: { id: submissionId } });
    if (!submission) throw new NotFoundException('Demande introuvable');

    const claim = await this.prisma.kycSubmission.updateMany({
      where: { id: submissionId, status: 'pending' },
      data: { status: 'rejected', rejectionReason: reason, reviewedByAdminId: adminId, reviewedAt: new Date() },
    });
    if (claim.count === 0) throw new BadRequestException('Demande déjà traitée');

    await this.prisma.user.update({ where: { id: submission.userId }, data: { kycStatus: 'rejected' } });
    await this.prisma.auditLog.create({
      data: { actorId: adminId, action: 'kyc.rejected', target: submission.userId, metadata: JSON.stringify({ reason }) },
    });
    return this.prisma.kycSubmission.findUniqueOrThrow({ where: { id: submissionId } });
  }
}
