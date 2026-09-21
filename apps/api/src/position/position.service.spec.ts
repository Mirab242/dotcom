/**
 * Sécurité en argent réel : une position VENDUE chez l'exchange ne doit jamais rester "open" à cause
 * d'une erreur comptable interne, sinon le job la revendrait à la minute suivante. Tout est simulé.
 */
jest.mock('../exchange/exchange.service', () => ({ ExchangeService: class {} }));

import { PositionService } from './position.service';

function makeEnv(opts: { placeOrder: jest.Mock; debit?: jest.Mock; auditCreate?: jest.Mock }) {
  const position: any = {
    id: 'p1', userId: 'u1', symbol: 'DOT/USDT', qty: 100, entryPrice: 5, stopLoss: 4.8, initialStopLoss: 4.8,
    takeProfit: null, breakEvenActivated: false, status: 'open',
  };
  const prisma: any = {
    position: {
      findMany: jest.fn(async ({ where }: any) => (position.status === where.status ? [position] : [])),
      update: jest.fn(async ({ data }: any) => Object.assign(position, data)),
    },
    order: { create: jest.fn(async () => ({ id: 'close-order' })) },
    user: { findUnique: async () => ({ subscriptionTier: 'pro' }) },
    auditLog: { create: opts.auditCreate ?? jest.fn(async () => ({})) },
  };
  const exchange: any = { getConnector: () => ({ getCandles: async () => [{ close: 4.7 }], placeOrder: opts.placeOrder }) };
  const wallet: any = { debit: opts.debit ?? jest.fn(async () => ({})), credit: jest.fn(async () => ({})) };
  const risk: any = { computeCurrentEquity: async () => 10000 };
  const service = new PositionService(prisma, exchange, wallet, risk);
  return { service, position, prisma };
}

const sold = (qty = 100) => ({ exchangeOrderId: 'x1', status: 'closed', filledAmount: qty, averagePrice: 4.7 });

describe('PositionService — fermeture en argent réel', () => {
  it('cas normal : SL touché → vendue, fermée, P&L enregistré', async () => {
    const { service, position } = makeEnv({ placeOrder: jest.fn(async () => sold()) });
    await service.monitorPositions();
    expect(position.status).toBe('closed');
    expect(position.exitReason).toBe('sl');
    expect(position.realizedPnl).toBeCloseTo((4.7 - 5) * 100, 8);
    expect(position.exitOrderId).toBe('close-order');
  });

  it('CRITIQUE : vendue mais comptabilité en échec → position FERMÉE, jamais revendue au passage suivant', async () => {
    const placeOrder = jest.fn(async () => sold());
    const auditCreate = jest.fn(async (_arg?: any) => ({}));
    const { service, position } = makeEnv({
      placeOrder,
      debit: jest.fn(async () => { throw new Error('Solde DOT insuffisant'); }),
      auditCreate,
    });

    await service.monitorPositions(); // ne doit pas lever
    expect(position.status).toBe('closed'); // fermée malgré l'échec comptable
    expect(placeOrder).toHaveBeenCalledTimes(1);

    await service.monitorPositions(); // passage suivant (1 min plus tard)
    await service.monitorPositions();
    expect(placeOrder).toHaveBeenCalledTimes(1); // UNE seule vente réelle, jamais de doublon
  });

  it('l\'échec comptable après vente est tracé dans le journal d\'audit', async () => {
    const auditCreate = jest.fn(async (_arg?: any) => ({}));
    const { service } = makeEnv({
      placeOrder: jest.fn(async () => sold()),
      debit: jest.fn(async () => { throw new Error('boom'); }),
      auditCreate,
    });
    await service.monitorPositions();
    expect(auditCreate).toHaveBeenCalledTimes(1);
    const arg = auditCreate.mock.calls[0][0] as any;
    expect(arg.data.action).toBe('position.settlement_failed');
    expect(JSON.parse(arg.data.metadata)).toMatchObject({ exchangeOrderId: 'x1', reason: 'sl', error: 'boom' });
  });

  it('la vente est REFUSÉE par l\'exchange : rien n\'est vendu, la position reste "open" pour réessayer', async () => {
    const placeOrder = jest.fn(async () => { throw new Error('réseau indisponible'); });
    const { service, position } = makeEnv({ placeOrder });
    await service.monitorPositions();
    expect(position.status).toBe('open');
    await service.monitorPositions();
    expect(placeOrder).toHaveBeenCalledTimes(2); // retente à chaque passage tant que rien n'est vendu
  });

  it('deux passages simultanés du job ne vendent qu\'UNE fois', async () => {
    const placeOrder = jest.fn(async () => { await new Promise((r) => setTimeout(r, 40)); return sold(); });
    const { service, position } = makeEnv({ placeOrder });
    await Promise.all([service.monitorPositions(), service.monitorPositions()]);
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(position.status).toBe('closed');
  });
});
