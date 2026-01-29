export type UserRow = {
  id: string;
  username: string;
  name: string | null;
  avatar: string | null;
  trustLevel: number;
  active: boolean;
  silenced: boolean;
  balance: number;
  playBalance: number;
  totalWins: number;
  totalLosses: number;
  totalBets: number;
  totalProfit: number;
  lastLoginAt: Date | null;
};

export type TransactionRow = {
  orderNo: string;
  userId: string;
  type: string;
  status: string;
  amount: number;
  createdAt: Date;
  tradeNo?: string | null;
  balanceBefore?: number | null;
  balanceAfter?: number | null;
  completedAt?: Date | null;
};

export type BetRow = {
  id: string;
  userId: string;
  amount: number;
  multiplier: number;
  rowIndex: number;
  colIndex: number;
  asset: string;
  isPlayMode: boolean;
  payout: number;
  isWin: boolean;
  createdAt: Date;
  settledAt: Date | null;
};

export class FakePrisma {
  users = new Map<string, UserRow>();
  transactions = new Map<string, TransactionRow>();
  bets = new Map<string, BetRow>();
  private betSeq = 0;

  seedUser(partial: Partial<UserRow> & Pick<UserRow, 'id' | 'username'>) {
    const row: UserRow = {
      id: partial.id,
      username: partial.username,
      name: partial.name ?? null,
      avatar: partial.avatar ?? null,
      trustLevel: partial.trustLevel ?? 0,
      active: partial.active ?? true,
      silenced: partial.silenced ?? false,
      balance: partial.balance ?? 0,
      playBalance: partial.playBalance ?? 10000,
      totalWins: partial.totalWins ?? 0,
      totalLosses: partial.totalLosses ?? 0,
      totalBets: partial.totalBets ?? 0,
      totalProfit: partial.totalProfit ?? 0,
      lastLoginAt: partial.lastLoginAt ?? null,
    };

    this.users.set(row.id, row);
  }

  seedTransaction(partial: Partial<TransactionRow> & Pick<TransactionRow, 'orderNo' | 'userId' | 'amount'>) {
    const row: TransactionRow = {
      orderNo: partial.orderNo,
      userId: partial.userId,
      type: partial.type ?? 'RECHARGE',
      status: partial.status ?? 'PENDING',
      amount: partial.amount,
      createdAt: partial.createdAt ?? new Date(),
      tradeNo: partial.tradeNo ?? null,
      balanceBefore: partial.balanceBefore ?? null,
      balanceAfter: partial.balanceAfter ?? null,
      completedAt: partial.completedAt ?? null,
    };

    this.transactions.set(row.orderNo, row);
  }

  seedBet(partial: Partial<BetRow> & Pick<BetRow, 'userId' | 'amount' | 'multiplier' | 'rowIndex' | 'colIndex' | 'asset' | 'isPlayMode'>) {
    this.betSeq += 1;
    const id = partial.id ?? `bet-${this.betSeq}`;
    const row: BetRow = {
      id,
      userId: partial.userId,
      amount: partial.amount,
      multiplier: partial.multiplier,
      rowIndex: partial.rowIndex,
      colIndex: partial.colIndex,
      asset: partial.asset,
      isPlayMode: partial.isPlayMode,
      payout: partial.payout ?? 0,
      isWin: partial.isWin ?? false,
      createdAt: partial.createdAt ?? new Date(),
      settledAt: partial.settledAt ?? null,
    };

    this.bets.set(id, row);
    return row;
  }

  user: any;
  transaction: any;
  bet: any;

  constructor() {
    this.user = {};
    this.transaction = {};
    this.bet = {};

    this.user.upsert = async (args: any) => {
      const id = args?.where?.id as string | undefined;
      if (!id) throw new Error('Missing where.id');

      const existing = this.users.get(id);
      if (existing) {
        const update = args?.update ?? {};
        for (const [key, value] of Object.entries(update)) {
          if (value !== undefined) {
            (existing as any)[key] = value;
          }
        }
        return { ...existing };
      }

      const create = args?.create ?? {};
      const row: UserRow = {
        id: create.id,
        username: create.username,
        name: create.name ?? null,
        avatar: create.avatar ?? null,
        trustLevel: create.trustLevel ?? 0,
        active: create.active ?? true,
        silenced: create.silenced ?? false,
        balance: create.balance ?? 0,
        playBalance: create.playBalance ?? 0,
        totalWins: 0,
        totalLosses: 0,
        totalBets: 0,
        totalProfit: 0,
        lastLoginAt: create.lastLoginAt ?? null,
      };
      this.users.set(id, row);
      return { ...row };
    };

    this.user.update = async (args: any) => {
      const id = args?.where?.id as string | undefined;
      if (!id) throw new Error('Missing where.id');
      const user = this.users.get(id);
      if (!user) throw new Error('Missing user');

      const data = args?.data ?? {};
      if (data.balance?.increment) user.balance += data.balance.increment;
      if (data.playBalance?.increment) user.playBalance += data.playBalance.increment;
      if (data.totalWins?.increment) user.totalWins += data.totalWins.increment;
      if (data.totalLosses?.increment) user.totalLosses += data.totalLosses.increment;
      if (data.totalBets?.increment) user.totalBets += data.totalBets.increment;
      if (data.totalProfit?.increment) user.totalProfit += data.totalProfit.increment;

      const select = args?.select;
      if (select) {
        const selected: any = {};
        for (const key of Object.keys(select)) {
          selected[key] = (user as any)[key];
        }
        return selected;
      }

      return { ...user };
    };

    this.user.findUnique = async (args: any) => {
      const id = args?.where?.id as string | undefined;
      if (!id) throw new Error('Missing where.id');
      const user = this.users.get(id);
      if (!user) return null;

      const select = args?.select;
      if (select) {
        const selected: any = {};
        for (const key of Object.keys(select)) {
          selected[key] = (user as any)[key];
        }
        return selected;
      }

      return { ...user };
    };

    this.transaction.findFirst = async (args: any) => {
      const where = args?.where ?? {};
      const row = this.transactions.get(where.orderNo);
      if (!row) return null;

      if (where.status && row.status !== where.status) return null;
      if (where.type && row.type !== where.type) return null;

      const select = args?.select;
      if (select) {
        const selected: any = {};
        for (const key of Object.keys(select)) {
          selected[key] = (row as any)[key];
        }
        return selected;
      }

      return { ...row };
    };

    this.transaction.findUnique = async (args: any) => {
      const orderNo = args?.where?.orderNo as string | undefined;
      if (!orderNo) throw new Error('Missing where.orderNo');
      const row = this.transactions.get(orderNo);
      return row ? { ...row } : null;
    };

    this.transaction.updateMany = async (args: any) => {
      const where = args?.where ?? {};
      const orderNo = where.orderNo as string | undefined;
      if (!orderNo) throw new Error('Missing where.orderNo');
      const row = this.transactions.get(orderNo);
      if (!row) return { count: 0 };

      if (where.status && row.status !== where.status) return { count: 0 };

      Object.assign(row, args?.data ?? {});
      return { count: 1 };
    };

    this.transaction.create = async (args: any) => {
      const data = args?.data ?? {};
      const orderNo = data.orderNo as string | undefined;
      if (!orderNo) throw new Error('Missing data.orderNo');

      const row: TransactionRow = {
        orderNo,
        userId: data.userId,
        type: data.type,
        status: data.status,
        amount: data.amount,
        createdAt: data.createdAt ?? new Date(),
        tradeNo: data.tradeNo ?? null,
        balanceBefore: data.balanceBefore ?? null,
        balanceAfter: data.balanceAfter ?? null,
        completedAt: data.completedAt ?? null,
      };

      this.transactions.set(orderNo, row);
      return { ...row };
    };

    this.transaction.aggregate = async (args: any) => {
      const where = args?.where ?? {};
      const statusFilter = where.status;
      const createdAtGte = where.createdAt?.gte as Date | undefined;

      let sum = 0;
      for (const row of this.transactions.values()) {
        if (where.userId && row.userId !== where.userId) continue;
        if (where.type && row.type !== where.type) continue;
        if (statusFilter) {
          if (typeof statusFilter === 'string') {
            if (row.status !== statusFilter) continue;
          } else if (statusFilter.in) {
            const allowed = statusFilter.in as string[];
            if (!allowed.includes(row.status)) continue;
          }
        }
        if (createdAtGte && row.createdAt < createdAtGte) continue;
        sum += row.amount;
      }

      return { _sum: { amount: sum } };
    };

    this.bet.create = async (args: any) => {
      const data = args?.data ?? {};
      return this.seedBet({
        userId: data.userId,
        amount: data.amount,
        multiplier: data.multiplier,
        rowIndex: data.rowIndex,
        colIndex: data.colIndex,
        asset: data.asset,
        isPlayMode: data.isPlayMode,
      });
    };

    this.bet.findFirst = async (args: any) => {
      const where = args?.where ?? {};
      const select = args?.select;
      const found = Array.from(this.bets.values()).find((bet) => {
        if (where.id && bet.id !== where.id) return false;
        if (where.userId && bet.userId !== where.userId) return false;
        if (where.settledAt?.not === null && bet.settledAt === null) return false;
        return true;
      });

      if (!found) return null;
      if (select) {
        const selected: any = {};
        for (const key of Object.keys(select)) {
          selected[key] = (found as any)[key];
        }
        return selected;
      }

      return { ...found };
    };

    this.bet.update = async (args: any) => {
      const id = args?.where?.id as string | undefined;
      if (!id) throw new Error('Missing where.id');
      const bet = this.bets.get(id);
      if (!bet) throw new Error('Missing bet');

      Object.assign(bet, args?.data ?? {});
      return { ...bet };
    };

    this.bet.findMany = async (args: any) => {
      const where = args?.where ?? {};
      const orderBy = args?.orderBy ?? {};
      const take = args?.take ?? undefined;
      const select = args?.select;

      let results = Array.from(this.bets.values()).filter((bet) => {
        if (where.userId && bet.userId !== where.userId) return false;
        if (where.settledAt?.not === null && bet.settledAt === null) return false;
        return true;
      });

      if (orderBy.createdAt === 'desc') {
        results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      }

      if (typeof take === 'number') {
        results = results.slice(0, take);
      }

      if (select) {
        return results.map((bet) => {
          const selected: any = {};
          for (const key of Object.keys(select)) {
            selected[key] = (bet as any)[key];
          }
          return selected;
        });
      }

      return results.map((bet) => ({ ...bet }));
    };
  }

  async $transaction<T>(fn: (tx: FakePrisma) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

export const prismaMock = new FakePrisma();
