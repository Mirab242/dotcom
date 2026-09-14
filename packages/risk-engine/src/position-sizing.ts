export interface PositionSizeInput {
  /** Capital disponible (equity) dans la devise de cotation, ex: solde USDT */
  equity: number;
  /** % du capital risqué sur ce trade, ex: 1 pour 1% */
  riskPercent: number;
  entryPrice: number;
  stopLoss: number;
}

export interface PositionSizeResult {
  qty: number;
  riskAmount: number;
  stopDistance: number;
}

/** Le risque par trade ne peut jamais dépasser ce plafond, quelle que soit la demande client. */
export const MAX_RISK_PERCENT_PER_TRADE = 3;
export const DEFAULT_RISK_PERCENT = 1;

export function clampRiskPercent(riskPercent: number | undefined | null): number {
  const value = riskPercent ?? DEFAULT_RISK_PERCENT;
  if (!isFinite(value) || value <= 0) return DEFAULT_RISK_PERCENT;
  return Math.min(value, MAX_RISK_PERCENT_PER_TRADE);
}

/**
 * Taille de position = (capital × %risque) / distance(entrée, stop-loss).
 * Jamais une taille fixe (§4.5 ARCHITECTURE.md) — toujours dérivée du risque réellement encouru.
 */
export function computePositionSize(input: PositionSizeInput): PositionSizeResult {
  const riskPercent = clampRiskPercent(input.riskPercent);
  const stopDistance = Math.abs(input.entryPrice - input.stopLoss);
  if (stopDistance <= 0) {
    throw new Error('Distance entrée/stop-loss nulle — position sizing impossible');
  }
  const riskAmount = input.equity * (riskPercent / 100);
  const qty = riskAmount / stopDistance;
  return { qty, riskAmount, stopDistance };
}

/** Un stop-loss est obligatoire et doit être du bon côté du prix d'entrée. */
export function validateStopLoss(
  side: 'buy' | 'sell',
  entryPrice: number,
  stopLoss: number | undefined | null,
): { valid: boolean; reason?: string } {
  if (stopLoss === undefined || stopLoss === null || !isFinite(stopLoss) || stopLoss <= 0) {
    return { valid: false, reason: 'Stop-loss obligatoire manquant' };
  }
  if (side === 'buy' && stopLoss >= entryPrice) {
    return { valid: false, reason: 'Le stop-loss doit être sous le prix d\'entrée pour un achat' };
  }
  if (side === 'sell' && stopLoss <= entryPrice) {
    return { valid: false, reason: 'Le stop-loss doit être au-dessus du prix d\'entrée pour une vente' };
  }
  return { valid: true };
}
