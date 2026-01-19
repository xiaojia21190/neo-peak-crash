-- AlterEnum
ALTER TYPE "TransactionType" ADD VALUE 'BET';
ALTER TYPE "TransactionType" ADD VALUE 'WIN';
ALTER TYPE "TransactionType" ADD VALUE 'REFUND';

-- AlterEnum
ALTER TYPE "BetStatus" ADD VALUE 'SETTLING';

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN "balanceBefore" DECIMAL(18,2) NOT NULL DEFAULT 0;
ALTER TABLE "transactions" ADD COLUMN "balanceAfter" DECIMAL(18,2) NOT NULL DEFAULT 0;
ALTER TABLE "transactions" ADD COLUMN "relatedBetId" TEXT;

-- CreateIndex
CREATE INDEX "transactions_userId_createdAt_idx" ON "transactions"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "transactions_type_idx" ON "transactions"("type");
