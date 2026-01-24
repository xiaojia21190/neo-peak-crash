# P0/P1 修复计划

## 目标
- 兜底结算改用快照窗口判定，避免 tick 延迟/崩溃导致误判
- 风控资金池持久化，支持进程重启恢复并防止敞口放大
- 财务余额变更增加边界校验，阻止无效金额
- 注单锁改为 token 保护，避免锁过期后被错误释放

## P0-1 兜底结算判定不准确（仅用结束快照）
现状：`SettlementService.compensateUnsettledBets` / `retryPendingBets` 仅用结束快照计算命中，无法覆盖 tick 延迟或进程崩溃时的真实轨迹。

修复方案：
1. 新增快照窗口命中判定逻辑，基于 `price_snapshots` 在目标时间窗口内的行索引变化判断命中。
2. `SnapshotService` 提供按轮次+时间窗口拉取快照的方法，并在 `GameEngine.endRound` 里优先 flush buffer 后再补偿。
3. `SettlementService` 在补偿/重试时预拉取最小窗口（按未结注单的最早/最晚 targetTime），避免逐单查询。
4. 如果窗口内快照缺失，降级到结束快照并记录告警，防止大量拒绝结算。

代码示例（核心判定思路）：
```ts
// SettlementService.ts
async resolveHitBySnapshots(params: {
  roundId: string;
  roundStartTime: number;
  targetTime: number;
  targetRow: number;
  hitTolerance: number;
}) {
  const windowStart = new Date(params.roundStartTime + (params.targetTime - HIT_TIME_TOLERANCE) * 1000);
  const windowEnd = new Date(params.roundStartTime + (params.targetTime + HIT_TIME_TOLERANCE) * 1000);

  const snapshots = await this.prisma.priceSnapshot.findMany({
    where: { roundId: params.roundId, timestamp: { gte: windowStart, lte: windowEnd } },
    orderBy: { timestamp: 'asc' },
  });

  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1];
    const curr = snapshots[i];
    const minRow = Math.min(Number(prev.rowIndex), Number(curr.rowIndex)) - params.hitTolerance;
    const maxRow = Math.max(Number(prev.rowIndex), Number(curr.rowIndex)) + params.hitTolerance;
    if (params.targetRow >= minRow && params.targetRow <= maxRow) {
      const hitTime = (curr.timestamp.getTime() - params.roundStartTime) / 1000;
      return { isWin: true, hitDetails: { hitPrice: Number(curr.price), hitRow: Number(curr.rowIndex), hitTime } };
    }
  }

  return { isWin: false };
}
```

涉及文件：
- `lib/game-engine/GameEngine.ts`（确保 flush 快照后再兜底补偿）
- `lib/game-engine/SnapshotService.ts`（快照窗口查询/缓冲区读取）
- `lib/game-engine/SettlementService.ts`（兜底判定改为快照窗口）

## P0-2 风控依赖静态资金池（无重启恢复）
现状：`GameEngine.getPoolBalance` 仅从环境变量读取，重启后资金池不可恢复，风险评估偏离真实敞口。

修复方案：
1. 引入持久化资金池表（例如 `house_pools`），按资产维护余额和版本号。
2. 新增 `HousePoolService` 负责初始化、读取、增减与乐观锁控制，`GameEngine` 通过服务读取资金池。
3. 下注扣款、中奖赔付、退款等流程中，同步更新资金池（与 `FinancialService` 同事务）。
4. 提供后台或定时对账（按交易流水重算）能力，避免漂移累积。

代码示例（资金池更新）：
```ts
// HousePoolService.ts
async applyDelta(params: { asset: string; amount: number }, tx: Prisma.TransactionClient) {
  await tx.housePool.update({
    where: { asset: params.asset },
    data: { balance: { increment: params.amount }, version: { increment: 1 } },
  });
}

// GameEngine.ts (下注完成后)
await this.housePoolService.applyDelta(
  { asset: this.config.asset, amount: request.amount },
  tx
);
```

涉及文件：
- `lib/game-engine/GameEngine.ts`（替换 `getPoolBalance` 数据源）
- `lib/game-engine/RiskManager.ts`（使用动态 poolBalance）
- `lib/services/financial.ts`（事务内同步资金池）
- `prisma/schema.prisma`（新增资金池模型）

## P1-3 财务服务缺乏边界校验（金额有效性/负数）
现状：`FinancialService.changeBalance` 仅做 `roundMoney`，缺少 NaN/Infinity/符号方向校验。

修复方案：
1. 增加金额合法性校验：`Number.isFinite`、非 0、绝对值上限（可配置）。
2. 根据交易类型验证符号（BET/WITHDRAW 必须负数；WIN/RECHARGE/REFUND 必须正数）。
3. `batchChangeBalance` 与 `conditionalChangeBalance` 同步应用校验。

代码示例（通用校验）：
```ts
// financial.ts
private normalizeAmount(params: BalanceChangeParams): number {
  if (!Number.isFinite(params.amount) || params.amount === 0) {
    throw new Error('Invalid amount');
  }
  const amount = roundMoney(params.amount);
  const sign = Math.sign(amount);
  const positive = ['RECHARGE', 'WIN', 'REFUND'];
  const negative = ['BET', 'WITHDRAW'];
  if (sign > 0 && !positive.includes(params.type)) throw new Error('Amount sign mismatch');
  if (sign < 0 && !negative.includes(params.type)) throw new Error('Amount sign mismatch');
  return amount;
}
```

涉及文件：
- `lib/services/financial.ts`

## P1-4 注单锁无 token 保护（锁过期被他人重建）
现状：`LockManager.acquireBetLock` 使用 `SET NX`，释放时直接 `DEL`，锁过期后旧实例可能误删新锁。

修复方案：
1. 下注锁改用 `DistributedLock`（token）并返回 token。
2. `GameEngine.placeBet` 持有 token，释放时校验 token。
3. 释放失败时记录告警，避免误判。

代码示例（token 锁）：
```ts
// LockManager.ts
async acquireBetLock(orderId: string, ttlMs: number): Promise<string | null> {
  return this.distributedLock.acquire(`${REDIS_KEYS.BET_LOCK}${orderId}`, ttlMs);
}

async releaseBetLock(orderId: string, token: string): Promise<boolean> {
  return this.distributedLock.release(`${REDIS_KEYS.BET_LOCK}${orderId}`, token);
}
```

涉及文件：
- `lib/game-engine/LockManager.ts`
- `lib/game-engine/GameEngine.ts`

## 实施顺序和依赖关系
1. P0-1 兜底结算改为快照窗口判定（无 schema 变更，可先交付降低错判）
2. P1-3 财务金额校验（为后续资金池更新提供基础校验）
3. P0-2 资金池持久化（依赖 P1-3 校验与新增表迁移）
4. P1-4 注单锁 token 化（独立，可与任一步并行）

## 测试要点
- 快照兜底：构造不同 targetTime/targetRow 场景，覆盖命中、未命中、快照缺失降级。
- 资金池：下注/中奖/退款对余额的增减、重启恢复、并发更新与乐观锁冲突处理。
- 财务校验：NaN/Infinity/零金额/符号不匹配/超上限的拒绝逻辑。
- 注单锁：锁过期后重建，旧 token 释放不影响新锁；并发下注压力下 idempotency 正确。

## 风险评估
- 快照窗口判定增加 DB 查询量，需控制查询窗口并复用快照索引。
- 资金池持久化涉及 schema 迁移与历史数据初始化，需提供回滚与对账策略。
- 金额校验更严格，可能导致历史调用路径报错，需要全链路回归验证。
- 锁 token 化需要调用方同步升级，否则可能引入锁泄露或不释放问题。
