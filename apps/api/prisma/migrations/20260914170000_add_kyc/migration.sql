-- AlterTable
ALTER TABLE "users" ADD COLUMN     "kycStatus" TEXT NOT NULL DEFAULT 'none';

-- CreateTable
CREATE TABLE "kyc_submissions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "dateOfBirth" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "idDocumentType" TEXT NOT NULL,
    "idDocumentNumber" TEXT NOT NULL,
    "documentImageB64" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "rejectionReason" TEXT,
    "reviewedByAdminId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kyc_submissions_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "kyc_submissions" ADD CONSTRAINT "kyc_submissions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

