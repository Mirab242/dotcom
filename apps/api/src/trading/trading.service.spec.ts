/**
 * Sécurité en argent réel : un ordre PARTI chez l'exchange ne doit jamais être marqué "failed"
 * parce que la comptabilité interne a échoué ensuite. Tests unitaires (tout est simulé, sans base).
 */
jest.mock('../exchange/exchange.service', () => ({ ExchangeService: class {} }));

import { TradingService } from './trading.service';

function makeService(opts: {
  placeOrder: jest.Mock;
  debit?: jest.Mock;
  auditCreate?: jest.Mock<any, any>;
}) {
  const prisma: any = {
    order: {
      create: jest.fn(async () => ({ id: 'o1' })),
      update: jest.fn(async ({ data }: any) => ({ id: 'o1', ...data })),
    },
    auditLog: { create: opts.auditCreate ?? jest.fn(async () => ({})) },
  };
  const exchange: any = { getConnector: () => ({ getCandles: async () => [{ close: 5 }], placeOrder: opts.placeOrder }) };
  const wallet: any = {
    getBalance: async () => 10000,
    debit: opts.debit ?? jest.fn(async () => ({})),
    credit: jest.fn(async () => ({})),
  };
  const risk: any = { assertTradingAllowed: async () => undefined, computeCurrentEquity: async () => 10000 };
  const service = new TradingService(prisma, exchange, wallet, risk, {} as any);
  return { service, prisma, wallet };
}

const buy = { symbol: 'DOT/USDT', side: 'buy' as const, type: 'market' as const, qty: 100 };
const filled = { exchangeOrderId: 'ex1', status: 'closed', filledAmount: 100, averagePrice: 5 };

describe('TradingService — ordres en argent réel', () => {
  it('cas normal : ordre exécuté et réglé', async () => {
    const { service, wallet } = makeService({ placeOrder: jest.fn(async () => filled) });
    const order = await service.createOrder('u1', buy);
    expect(order.status).toBe('filled');
    expect(order.errorMessage).toBeNull();
    expect(wallet.debit).toHaveBeenCalled();
  });

  it('l\'exchange REFUSE l\'ordre : "failed" (rien n\'a été exécuté), aucun mouvement de wallet', async () => {
    const { service, wallet } = makeService({ placeOrder: jest.fn(async () => { throw new Error('MIN_NOTIONAL'); }) });
    const order = await service.createOrder('u1', buy);
    expect(order.status).toBe('failed');
    expect(order.errorMessage).toMatch(/MIN_NOTIONAL/);
    expect(wallet.debit).not.toHaveBeenCalled();
  });

  it('CRITIQUE : exécuté chez l\'exchange mais règlement interne en échec → reste "filled", jamais "failed"', async () => {
    const auditCreate = jest.fn(async (_arg?: any) => ({}));
    const { service } = makeService({
      placeOrder: jest.fn(async () => filled),
      debit: jest.fn(async () => { throw new Error('Solde USDT insuffisant'); }),
      auditCreate,
    });
    const order = await service.createOrder('u1', buy); // ne doit PAS lever
    expect(order.status).toBe('filled');
    expect(order.exchangeOrderId).toBe('ex1');
    expect(order.filledQty).toBe(100);
    expect(order.errorMessage).toMatch(/EXÉCUTÉ chez l'exchange/);
    expect(order.errorMessage).toMatch(/Solde USDT insuffisant/);
  });

  it('l\'échec de règlement est tracé dans le journal d\'audit (visible dans l\'admin)', async () => {
    const auditCreate = jest.fn(async (_arg?: any) => ({}));
    const { service } = makeService({
      placeOrder: jest.fn(async () => filled),
      debit: jest.fn(async () => { throw new Error('boom'); }),
      auditCreate,
    });
    await service.createOrder('u1', buy);
    expect(auditCreate).toHaveBeenCalledTimes(1);
    const arg = auditCreate.mock.calls[0][0] as any;
    expect(arg.data.action).toBe('order.settlement_failed');
    expect(arg.data.target).toBe('o1');
    expect(JSON.parse(arg.data.metadata)).toMatchObject({ exchangeOrderId: 'ex1', filledQty: 100, error: 'boom' });
  });

  it('un journal d\'audit en panne ne masque pas l\'ordre', async () => {
    const { service } = makeService({
      placeOrder: jest.fn(async () => filled),
      debit: jest.fn(async () => { throw new Error('boom'); }),
      auditCreate: jest.fn(async () => { throw new Error('audit KO'); }),
    });
    const order = await service.createOrder('u1', buy);
    expect(order.status).toBe('filled');
  });

  it('ordre limite non exécuté : "open", aucun règlement', async () => {
    const { service, wallet } = makeService({
      placeOrder: jest.fn(async () => ({ exchangeOrderId: 'ex2', status: 'open', filledAmount: 0, averagePrice: null })),
    });
    const order = await service.createOrder('u1', { ...buy, type: 'limit', price: 4.9 });
    expect(order.status).toBe('open');
    expect(wallet.debit).not.toHaveBeenCalled();
  });
});
