/**
 * 婵炴挸鎲￠崹娆忣嚕閺囩喐鎯涢柡宥囶焾缁哄墽鐚?
 * 缂佺媴绱曢幃濠囧炊閻愬弶鍊ら柣銏㈠枎閹筹繝宕ㄩ妸锔藉焸闁靛棔鐒︽慨鍥р枖閵娿儺妲遍柣鐐叉閳ь兛鑳堕～顐﹀箻閻愭惌姊炬繛鏉戭儏閹锋壆绱掗幘鍓佹毈
 */

import { EventEmitter } from 'events';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '@prisma/client';
import type {
  RoundConfig,
  GameState,
  ServerBet,
  PriceUpdate,
  PlaceBetRequest,
  PlaceBetResponse,
  SettlementItem,
  HitDetails,
  GameEngineEvents,
  RoundStatus,
} from './types';
import {
  CENTER_ROW_INDEX,
  MIN_TARGET_TIME_OFFSET,
  HIT_TIME_TOLERANCE,
  MISS_TIME_BUFFER,
  DEFAULT_ROUND_CONFIG,
  REDIS_KEYS,
  ERROR_CODES,
  MAX_ROW_INDEX,
} from './constants';
import {
  calculateRowIndex,
  calculateMultiplier,
} from './utils';
import { roundMoney } from '../shared/gameMath';
import { GameError } from './errors';
import { PriceService } from './PriceService';
import { allowSlidingWindowRequest, buildRateLimitKey } from '../services/rateLimit';
import { DistributedLock } from './DistributedLock';
import { FinancialService } from '../services/financial';

export class GameEngine extends EventEmitter {
  private config: RoundConfig;
  private state: GameState | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  // 缂備焦鎸鹃悾濠氭⒓閻斿嘲鐏欓柨娑樼墕缁辨挸顫㈤妷锕€顥楀璺哄閹﹪鏁?  private settlementQueue: SettlementItem[] = [];
  private isSettling = false;
  private settlementRetryTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private settlementRetryAttempts: Map<string, number> = new Map();

  // 闁硅埖娲橀弫鐐哄籍閸洘锛熺紒渚垮灩缁扁晠鏁嶉崼鐔镐粯閻忓繐绻愰悥銏ゆ晬濮橆厼鐦?targetTime 闁圭儤甯掔花顓㈡晬?
  private betHeap: ServerBet[] = [];

  // 濞寸娀鏀遍悧姝岀疀椤愩倕寮剧紓鍌涙尭閸?(ring buffer: O(1) shift via head index)
  private priceSnapshotBuffer: Array<{
    roundId: string;
    timestamp: Date;
    price: number;
    rowIndex: number;
  }> = [];
  private priceSnapshotBufferHead = 0;
  private lastSnapshotFlush = 0;
  private snapshotFlushPromise: Promise<void> | null = null;
  private snapshotFlushBackoffUntil = 0;
  private snapshotFlushFailures = 0;

  // 闁煎搫鍊圭粊锕傚箳瑜嶉崺?
  private lastEmitTimes: Map<string, number> = new Map();

  // 濞寸娀鏀遍悧鍝ョ磽閹惧磭鎽?
  private priceCache: PriceUpdate | null = null;

  // 闁告帒妫楃粩宄邦嚕韫囨稒鏁?
  private distributedLock: DistributedLock;
  private roundLockToken: string | null = null;

  // 閻犳劑鍨规慨鐔煎嫉瀹ュ懎顫ら柨娑樼墕瀹曠喐绋夐埀顒勬嚂瀹€鍐厬闁挎稒纰嶆晶宥夊嫉婢跺绋囧Λ鐗堢箓瑜板宕濋…鎺旂
  private financialService: FinancialService;

  constructor(
    private redis: Redis,
    private prisma: PrismaClient,
    private priceService: PriceService,
    config?: Partial<RoundConfig>
  ) {
    super();
    this.config = { ...DEFAULT_ROUND_CONFIG, ...config };
    this.distributedLock = new DistributedLock(redis);
    this.financialService = new FinancialService(prisma);

    // 闁烩晜鍨甸幆澶嬬闁垮澹愰柡鍥х摠閺?
    this.priceService.on('price', (price: PriceUpdate) => {
      this.priceCache = price;
    });

    // 闁烩晜鍨甸幆澶嬬闁垮澹愬☉鎾崇Т瑜版煡鎮?
    this.priceService.on('price_critical', () => {
      this.handlePriceUnavailable();
    });
  }

  // ========== 闁稿浚鍓欓崣锟犲棘鐟欏嫮銆?==========

  /**
   * 闁兼儳鍢茶ぐ鍥亹閹惧啿顤呮繛鎾虫啞閸ㄦ瑩鎮╅懜纰樺亾?
   */
  getState(): GameState | null {
    return this.state;
  }

  /**
   * 闁兼儳鍢茶ぐ鍥煀瀹ュ洨鏋?
   */
  getConfig(): RoundConfig {
    return { ...this.config };
  }

  /**
   * 闁哄洤鐡ㄩ弻濠冪闁垮澹愮紓鍌涙尭閻°劑鏁嶉崼婊呰繑濠㈣埖鐗犻崕瀵告嫬閸愵亝鏆忛柨?
   */
  updatePriceCache(price: PriceUpdate): void {
    this.priceCache = price;
  }

  // ========== 闁搞儳鍋涢幃搴ㄦ偨閻旈攱鍤掗柛娑栧妽濠€?==========

  /**
   * 鐎殿喒鍋撳┑顔碱儐閺屽﹪宕堕悙鍙夊€?
   */
  async startRound(): Promise<void> {
    if (this.state?.status === 'RUNNING' ||
        this.state?.status === 'BETTING' ||
        this.state?.status === 'SETTLING') {
      throw new GameError(ERROR_CODES.NO_ACTIVE_ROUND, '鐎圭寮跺﹢渚€宕堕悙鍙夊€ら弶鈺傜椤㈡垶绋?);
    }

    // 1. 闁兼儳鍢茶ぐ鍥礆閸℃顏寸€殿喖绻橀弨?
    const lockKey = `${REDIS_KEYS.ROUND_STATE}${this.config.asset}:lock`;
    const lockTtl = (this.config.maxDuration + 60) * 1000; // 闁搞儳鍋涢幃搴ㄥ嫉閳ь剚寰勮濡炲倿姊?+ 60缂佸甯炵槐锕傚礃?
    this.roundLockToken = await this.distributedLock.acquire(lockKey, lockTtl);

    if (!this.roundLockToken) {
      throw new GameError(ERROR_CODES.NO_ACTIVE_ROUND, '闁哄啰濮电涵鍫曟嚔瀹勬澘绲块柛銉у仜閹酣鏌ㄦ笟濠勭闁告瑯鍨甸崗姗€寮垫径濠傚緭濞寸姵鐗曢悿鍕瑹鐎ｎ偒鍔€闁革负鍔忕换宥囨偘?);
    }

    try {
      // 2. 婵☆偀鍋撻柡灞诲劙閻滎垶寮介悡搴¤闁活潿鍔嶉埀?
      const startPrice = this.priceService.getLatestPrice();
      if (!startPrice) {
        throw new GameError(ERROR_CODES.PRICE_UNAVAILABLE, '濞寸娀鏀遍悧鎼佸嫉瀹ュ懎顫ゅ☉鎾崇Т瑜版煡鎮?);
      }

      const now = Date.now();

      // 3. 闁告帗绋戠紓鎾诲炊閻愬弶鍊ら悹浣规緲缂?
      const round = await this.prisma.round.create({
        data: {
          asset: this.config.asset,
          status: 'BETTING',
          startPrice: startPrice.price,
          startedAt: new Date(now),
        },
      });

      // 5. 闁告帗绻傞～鎰板礌閺嶎偄笑闁?
      this.state = {
        roundId: round.id,
        status: 'BETTING',
        asset: this.config.asset,
        startPrice: startPrice.price,
        currentPrice: startPrice.price,
        currentRow: CENTER_ROW_INDEX,
        elapsed: 0,
        roundStartTime: now,
        activeBets: new Map(),
      };

      // 6. 闁告艾鏈鐐哄礆?Redis
      await this.syncStateToRedis();

      // 7. 闁告凹鍨版慨?Tick 鐎甸偊浜為獮?
      this.startTickLoop();

      // 8. 妤犵偞瀵ч幐閬嶅炊閻愬弶鍊ょ€殿喒鍋撳┑?
      this.emit('round:start', {
        roundId: round.id,
        asset: this.config.asset,
        startPrice: startPrice.price,
        startTime: now,
        bettingDuration: this.config.bettingDuration,
        maxDuration: this.config.maxDuration,
      });

      // 9. 闁硅埖娲橀弫鐐烘⒓閼告鍞介柛濠冨笩椤撴悂寮?
      setTimeout(() => this.transitionToRunning(), this.config.bettingDuration * 1000);

      console.log(`[GameEngine] Round ${round.id} started`);
    } catch (error) {
      // 闂佹彃锕ラ弬渚€鏌ㄦ担姝屽珯闂佹彃绉甸弻濠囧箮濞戞ê姣夐梺鎸庣懆椤?
      console.error(`[GameEngine] startRound failed, releasing lock:`, error);
      await this.distributedLock.release(lockKey, this.roundLockToken);
      this.roundLockToken = null;
      throw error;
    }
  }

  /**
   * 閺夌儐鍓氬畷鏌ュ礆閹峰瞼绠ラ悶娑樼灱婵悂骞€?
   */
  private transitionToRunning(): void {
    if (!this.state || this.state.status !== 'BETTING') return;

    const roundId = this.state.roundId;

    void (async () => {
      // Persist status transition (authoritative gate for betting).
      const updated = await this.prisma.round.updateMany({
        where: { id: roundId, status: 'BETTING' },
        data: { status: 'RUNNING' },
      });

      if (updated.count !== 1) {
        console.warn(
          `[GameEngine] Round ${roundId} status transition BETTING->RUNNING skipped (round missing or already transitioned)`
        );
        return;
      }

      // If state has been cleaned up or replaced, do not mutate it.
      if (!this.state || this.state.roundId !== roundId) return;

      this.state.status = 'RUNNING';
      await this.syncStateToRedis().catch(console.error);

      this.emit('round:running', { roundId });

      console.log(`[GameEngine] Round ${roundId} now RUNNING`);
    })().catch((error) => {
      console.error(`[GameEngine] Failed to transition round ${roundId} to RUNNING:`, error);
      // Best-effort: close betting in-memory to avoid accepting late bets if DB update failed.
      if (this.state && this.state.roundId === roundId && this.state.status === 'BETTING') {
        this.state.status = 'RUNNING';
        this.syncStateToRedis().catch(console.error);
      }
    });
  }

  /**
   * 缂備焦鎸诲顐﹀炊閻愬弶鍊?
   */
  async endRound(reason: 'timeout' | 'manual' | 'crash' = 'timeout'): Promise<void> {
    if (!this.state || this.state.status === 'SETTLING' ||
        this.state.status === 'COMPLETED' || this.state.status === 'CANCELLED') {
      return;
    }

    // 缂佹柨顑呭畵鍡涘礆閸ャ劌搴婇柛?SETTLING 闂傚啫寮堕娑㈡煂瀹ュ懎寮?
    this.state.status = 'SETTLING';

    const roundId = this.state.roundId;
    const endPrice = this.state.currentPrice;
    const settlementSnapshot = {
      elapsed: this.state.elapsed,
      currentRow: this.state.currentRow,
      currentPrice: this.state.currentPrice,
    };
    console.log(`[GameEngine] Ending round ${roundId} (reason: ${reason})`);

    // 1. 闁稿绮嶉?Tick
    this.stopTickLoop();

    try {
      // 2. 闁告艾鏈鐐烘偐閼哥鍋撴担绋跨厒 Redis闁挎稑鐗嗛妵鎴犳嫻閵夈倗鐦嶅☉鎾崇Ч濡棙绻呴悙鍙夌闁告艾鐗忕划銊╁级閻曞倻绀夐梺顒€鐏濋崢銈夊嫉椤忓嫷妲遍柣鐐叉鐎氬棛绱掑┑鍡╁殼闁奸顥愮换妯肩矙鐎ｎ喒鍋撻埀顒勫礄閻氬绀?
      // 1.5 Persist SETTLING ASAP to close DB gate for new bets.
      await this.prisma.round
        .updateMany({
          where: { id: roundId, status: { in: ['BETTING', 'RUNNING'] } },
          data: { status: 'SETTLING' },
        })
        .catch((error) => {
          console.error(`[GameEngine] Failed to persist SETTLING status for round ${roundId}:`, error);
        });

      await this.syncStateToRedis().catch((error) => {
        console.error(`[GameEngine] Failed to sync state to Redis for round ${roundId}:`, error);
      });

      // 3. 缂備焦鎸鹃悾濠氬箥閳ь剟寮垫径瀣紦缂備焦鎸鹃悾濠氬箮閺囩喐鏆?
      this.settleAllPendingBets();

      // 4. 缂佹稑顦欢鐔虹磼閹惧墎鏆梻鍐枎閸亝寰勯崟顓熷€為悗鐟版湰閸?
      const flushed = await this.flushSettlementQueue().catch((error) => {
        console.error(`[GameEngine] Failed to flush settlement queue for round ${roundId}:`, error);
        return false;
      });

      // 5. 闁稿繑绮岀花鎶芥晬濮樹箻澶愬磻缁剁方濞戞搩鍘藉﹢顓犵磼閹惧墎鏆柣銊ュ婵洤鈻旈…鎺旂DB 閻℃帒鎳忓鍌涚▔瀹ュ懐瀹夐悗浣冨閸ぱ囧炊閻愬弶鍊ょ紓浣规尰濞碱偄霉娴ｈ　鏌ょ€规洍鏅滅花婵嬫晬?
      const unsettledBets = await this.prisma.bet
        .findMany({
          where: {
            roundId,
            status: 'PENDING',
          },
        })
        .catch((error) => {
          console.error(`[GameEngine] Failed to query unsettled bets for round ${roundId}:`, error);
          return [];
        });

      const settlementByBetId = new Map<string, SettlementItem>();
      for (const item of this.settlementQueue) {
        settlementByBetId.set(item.bet.id, item);
      }
      const stateSnapshot = settlementSnapshot;

      if (unsettledBets.length > 0) {
        console.warn(`[GameEngine] Found ${unsettledBets.length} unsettled bets, compensating...`);
        for (const dbBet of unsettledBets) {
          try {
            const queued = settlementByBetId.get(dbBet.id);

            const targetTime = Number(dbBet.targetTime ?? 0);
            const targetRow = Number(dbBet.targetRow ?? 0);

            const computedIsWin =
              stateSnapshot != null &&
              Math.abs(stateSnapshot.elapsed - targetTime) <= HIT_TIME_TOLERANCE &&
              Math.abs(stateSnapshot.currentRow - targetRow) <= this.config.hitTolerance;

            const isWin = queued?.isWin ?? computedIsWin;
            const hitDetails =
              queued?.hitDetails ??
              (isWin && stateSnapshot != null
                ? {
                    hitPrice: stateSnapshot.currentPrice,
                    hitRow: stateSnapshot.currentRow,
                    hitTime: stateSnapshot.elapsed,
                  }
                : undefined);

            const amount = Number(dbBet.amount);
            const multiplierValue = Number(dbBet.multiplier);
            const payout = this.calculatePayout(amount, multiplierValue, isWin);
            const settledAt = new Date();

            const didSettle = await this.prisma.$transaction(async (tx) => {
              const updated = await tx.bet.updateMany({
                where: { id: dbBet.id, status: 'PENDING' },
                data: {
                  status: isWin ? 'WON' : 'LOST',
                  isWin,
                  payout,
                  hitPrice: hitDetails?.hitPrice,
                  hitRow: hitDetails?.hitRow,
                  hitTime: hitDetails?.hitTime,
                  settledAt,
                },
              });

              if (updated.count !== 1) return false;

              if (isWin && payout > 0) {
                await this.financialService.changeBalance(
                  {
                    userId: dbBet.userId,
                    amount: payout,
                    type: 'WIN',
                    isPlayMode: dbBet.isPlayMode,
                    relatedBetId: dbBet.id,
                    remark: `閻犙佸灩缁堕亶骞庨弴鐔告殘 ${dbBet.id} (compensation)`,
                  },
                  tx
                );
              }

              if (!dbBet.isPlayMode) {
                await tx.user.update({
                  where: { id: dbBet.userId },
                  data: {
                    totalBets: { increment: 1 },
                    totalWins: isWin ? { increment: 1 } : undefined,
                    totalLosses: !isWin ? { increment: 1 } : undefined,
                    totalProfit: {
                      increment: isWin ? payout - amount : -amount,
                    },
                  },
                });
              }

              return true;
            });

            if (didSettle) {
              const memBet = this.state?.activeBets.get(dbBet.id);
              if (memBet) {
                memBet.status = isWin ? 'WON' : 'LOST';
              }
            }
          } catch (error) {
            console.error(`[GameEngine] Failed to compensate bet ${dbBet.id} for round ${roundId}:`, error);
          }
        }
      }

      // 6. 闁告帡鏀遍弻濠冪闁垮澹愰煫鍥跺亞閸?
      const pendingCount = await this.prisma.bet
        .count({ where: { roundId, status: 'PENDING' } })
        .catch((error) => {
          console.error(`[GameEngine] Failed to count pending bets for round ${roundId}:`, error);
          return 0;
        });
      if (pendingCount > 0) {
        const retryReason = flushed ? 'pending_bets' : 'flush_timeout';
        this.scheduleSettlementRetry(roundId, settlementSnapshot, retryReason);
      }

      await this.flushPriceSnapshots();

      // 7. 閻犱緤绱曢悾鑽ょ磼閻旀椿鍚€
      const stats = this.calculateRoundStats();

      // 8. 闁哄洤鐡ㄩ弻濠囧极閻楀牆绁﹂幖?
      const completed = await this.prisma.round
        .updateMany({
          where: { id: roundId, status: 'SETTLING' },
          data: {
            status: 'COMPLETED',
            endPrice,
            endedAt: new Date(),
            totalBets: stats.totalBets,
            totalVolume: stats.totalVolume,
            totalPayout: stats.totalPayout,
          },
        })
        .catch((error) => {
          console.error(`[GameEngine] Failed to update round ${roundId} in database:`, error);
          return { count: 0 };
        });

      if (completed.count !== 1) {
        console.warn(`[GameEngine] Round ${roundId} status transition SETTLING->COMPLETED did not apply`);
      }

      // 9. 妤犵偞瀵ч幐閬嶅炊閻愬弶鍊ょ紓浣规尰濞碱偊鏁嶉崼婵嗙ギ濞?DB 闁哄洤鐡ㄩ弻濠冨緞鏉堫偉袝闁挎稑濂旂弧鍐焊娴犲娅ら梺顐ｆ皑閻擄紕鈧箍鍨洪崺娑氱博椤栨粎娉㈤柡澶屽櫐缁?
      this.emit('round:end', {
        roundId,
        endPrice,
        reason,
        stats: {
          totalBets: stats.totalBets,
          totalWins: stats.totalWins,
          totalPayout: stats.totalPayout,
        },
      });
    } catch (error) {
      console.error(`[GameEngine] endRound failed for round ${roundId}:`, error);
      // 闂傚啫寮堕娑㈠嫉椤忓嫷妲遍柣?Promise 闁归攱甯炵划椋庘偓浣冨閸ぱ勬交濞戞埃鏌ら梺顐熷亾闁?
      try {
        const stats = this.calculateRoundStats();
        this.emit('round:end', {
          roundId,
          endPrice,
          reason: 'crash',
          stats: {
            totalBets: stats.totalBets,
            totalWins: stats.totalWins,
            totalPayout: stats.totalPayout,
          },
        });
      } catch (emitError) {
        console.error(`[GameEngine] Failed to emit round:end after failure for round ${roundId}:`, emitError);
      }
    } finally {
      // 10. 婵炴挸鎳愰幃濂焑dis ACTIVE_BETS闂?
      try {
        await this.redis.del(`${REDIS_KEYS.ACTIVE_BETS}${roundId}`);
      } catch (error) {
        console.error(`[GameEngine] Failed to delete Redis ACTIVE_BETS key for round ${roundId}:`, error);
      }

      // 11. 闂佹彃锕ラ弬渚€宕氶崱妤冾伌鐎殿喖绻橀弨?
      if (this.roundLockToken) {
        const lockKey = `${REDIS_KEYS.ROUND_STATE}${this.config.asset}:lock`;
        try {
          await this.distributedLock.release(lockKey, this.roundLockToken);
        } catch (error) {
          console.error(`[GameEngine] Failed to release round lock for round ${roundId}:`, error);
        } finally {
          this.roundLockToken = null;
        }
      }

      // 12. 婵炴挸鎳愰幃?
      this.cleanup();
    }

    console.log(`[GameEngine] Round ${roundId} completed`);
  }

  /**
   * 闁告瑦鐗楃粔鐑藉炊閻愬弶鍊ゆ鐐茬埣閳ь兘鍋撴繛?
   */
  async cancelRound(reason: string): Promise<void> {
    if (!this.state || this.state.status === 'SETTLING' ||
        this.state.status === 'COMPLETED' || this.state.status === 'CANCELLED') {
      return;
    }

    // 缂佹柨顑呭畵鍡涘礆閸ャ劌搴婇柛?SETTLING 闂傚啫寮堕娑㈡煂瀹ュ懎寮?
    this.state.status = 'SETTLING';

    const roundId = this.state.roundId;
    console.log(`[GameEngine] Cancelling round ${roundId} (reason: ${reason})`);

    try {
      // 1. 闁稿绮嶉?Tick
      this.stopTickLoop();

      // 3. 闂侇偀鍋撴繛鍡欏亾婢у秹寮垫径濠勭缂備焦鎸鹃悾濠氬箮閺囩喐鏆?
      // 2. Persist SETTLING ASAP (idempotent) before refunds.
      await this.prisma.round
        .updateMany({
          where: { id: roundId, status: { in: ['BETTING', 'RUNNING'] } },
          data: { status: 'SETTLING' },
        })
        .catch((error) => {
          console.error(`[GameEngine] Failed to persist SETTLING status for cancelled round ${roundId}:`, error);
        });

      const pendingBets = Array.from(this.state.activeBets.values()).filter(
        (b) => b.status === 'PENDING'
      );

      for (const bet of pendingBets) {
        await this.refundBet(bet, reason);
      }

      // 4. 闁哄洤鐡ㄩ弻濠囧极閻楀牆绁﹂幖?
      const cancelled = await this.prisma.round.updateMany({
        where: { id: roundId, status: 'SETTLING' },
        data: {
          status: 'CANCELLED',
          endedAt: new Date(),
        },
      });

      if (cancelled.count !== 1) {
        console.warn(`[GameEngine] Round ${roundId} status transition SETTLING->CANCELLED did not apply`);
      }

      // 5. 妤犵偞瀵ч幐閬嶅炊閻愬弶鍊ら柛娆愮墬缁?
      this.emit('round:cancelled', {
        roundId,
        reason,
        refundedBets: pendingBets.length,
      });

      // 6. 婵炴挸鎳愰幃濂焑dis ACTIVE_BETS闂?
      try {
        await this.redis.del(`${REDIS_KEYS.ACTIVE_BETS}${roundId}`);
      } catch (error) {
        console.error(`[GameEngine] Failed to delete Redis ACTIVE_BETS key for round ${roundId}:`, error);
      }

      console.log(`[GameEngine] Round ${roundId} cancelled, ${pendingBets.length} bets refunded`);
    } finally {
      // 7. 闂佹彃锕ラ弬渚€宕氶崱妤冾伌鐎殿喖绻橀弨?
      if (this.roundLockToken) {
        const lockKey = `${REDIS_KEYS.ROUND_STATE}${this.config.asset}:lock`;
        try {
          await this.distributedLock.release(lockKey, this.roundLockToken);
        } catch (error) {
          console.error(`[GameEngine] Failed to release round lock:`, error);
        } finally {
          this.roundLockToken = null;
        }
      }

      // 8. 婵炴挸鎳愰幃?
      this.cleanup();
    }
  }

  /**
   * 闂侇偀鍋撴繛鍡樺劤瀹曠喐绋夐鍛潓婵?
   * 濞达綀娉曢弫?FinancialService 缂備胶鍠嶇粩瀛樺緞閸曨厽鍊炲ù锝嗙懇椤ゅ倿宕ｅΟ鍝勑楅柛婊冩湰缁侊箑顫濈壕瀣靛敹鐟?
   */
  private async refundBet(bet: ServerBet, reason: string): Promise<void> {
    const settledAt = new Date();
    const roundId = this.state?.roundId;

    const didRefund = await this.prisma.$transaction(async (tx) => {
      // 濞达綀娉曢弫?updateMany 閻庡湱鍋熼獮鍥嵁閸屾粎鎼奸柨娑欒壘瑜把囧即鐎涙ɑ鐓€ PENDING 闁绘鍩栭埀顑胯兌濞堟垵鈻旈妸銉ョ
      const updated = await tx.bet.updateMany({
        where: { id: bet.id, status: 'PENDING' },
        data: {
          status: 'REFUNDED',
          settledAt,
        },
      });

      if (updated.count !== 1) return false;

      // 濞达綀娉曢弫?FinancialService 濠㈣泛瀚幃濠囨焻閳ь剙鈻庨幘鍛闁煎浜滄慨鈺冩媼閺夎法绉挎繛缈犵劍閹稿鏁?
      await this.financialService.changeBalance(
        {
          userId: bet.userId,
          amount: bet.amount,
          type: 'REFUND',
          isPlayMode: bet.isPlayMode,
          relatedBetId: bet.id,
          remark: `Refund bet ${bet.id}${roundId ? ` (round ${roundId})` : ''}: ${reason}`,
        },
        tx
      );

      return true;
    });

    if (!didRefund) {
      console.log(`[GameEngine] Bet ${bet.id} already refunded/settled, skipping`);
      return;
    }

    bet.status = 'REFUNDED';

    this.emit('bet:refunded', {
      betId: bet.id,
      orderId: bet.orderId,
      userId: bet.userId,
      amount: bet.amount,
      reason,
    });
  }

  // ========== 闁硅埖娲橀弫鐐村緞閸曨厽鍊?==========

  /**
   * 濞戞挸顑嗛弫?
   */
  async placeBet(userId: string, request: PlaceBetRequest): Promise<PlaceBetResponse> {
    // 1. 闁绘鍩栭埀顑跨劍椤ュ懘寮?
    if (!this.state) {
      throw new GameError(ERROR_CODES.NO_ACTIVE_ROUND, '鐟滅増鎸告晶鐘测柦閳╁啯绠掗弶鈺傜椤㈡垶绋夐鐘崇暠闁搞儳鍋涢幃?);
    }

    if (this.state.status !== 'BETTING') {
      throw new GameError(ERROR_CODES.BETTING_CLOSED, '鐟滅増鎸告晶鐘崇▔瀹ュ懎璁查柟鑸垫礃閺?);
    }

    // 2. 闁哄牃鍋撳鍫嗗嫭銇熼悹鍝勫暞婵洤鈻旈妸鈺傤€欓柛?
    const roundId = this.state.roundId;

    const maxActiveBets = parseInt(process.env.MAX_ACTIVE_BETS ?? '10000', 10);
    if (this.state.activeBets.size >= maxActiveBets) {
      throw new GameError(ERROR_CODES.MAX_BETS_REACHED, '缂侇垵宕电划娲箮閺囩喐鏆堥柡浣峰嵆閸ｅ搫顔忛懠鑸靛涧濞戞挸锕娲晬瀹€鍐惧殲缂佸绉撮幃妤呭礃瀹ュ牏妲?);
    }

    // 3. 闁硅埖娲橀弫鐐达紣閹寸姴鑺抽梻鍕姇閸?
    if (!(await this.checkRateLimit(userId))) {
      throw new GameError(
        ERROR_CODES.RATE_LIMITED,
        `闁硅埖娲橀弫鐐存交閸ワ妇鑹惧Λ鐗堝灩缁犳帡鏁嶇仦鍓фЖ缂佸甯楀〒鑸靛緞?${this.config.maxBetsPerSecond} 婵炲棭鎽?
      );
    }

    // 3. 闁哄啫鐖煎Λ鍨涢埀顒勫蓟?
    const minTargetTime = this.state.elapsed + MIN_TARGET_TIME_OFFSET;
    if (request.targetTime <= minTargetTime) {
      throw new GameError(ERROR_CODES.TARGET_TIME_PASSED, '闁烩晩鍠楅悥锝夊籍閸洘锛熺€规瓕灏换鍐箣閺嵮佷喊閺?);
    }

    // 缁绢収鍠曠换姘舵儎椤旂晫鍨奸柡鍐ㄧ埣濡寧绋夊鍫⑿㈤弶鈺佹搐濞叉牠宕ラ崼鐔镐粯濠㈠爢鍕槯闂傗偓?
    if (request.targetTime > this.config.maxDuration) {
      throw new GameError(ERROR_CODES.INVALID_AMOUNT, `闁烩晩鍠楅悥锝夊籍閸洘锛熷☉鎾崇Х閸忔鎼鹃崨鎵畺 ${this.config.maxDuration} 缂佸濡?;
    }

    // 4. 闂佸弶鍨块·鍌毼涢埀顒勫蓟?
    if (request.amount < this.config.minBetAmount || request.amount > this.config.maxBetAmount) {
      throw new GameError(
        ERROR_CODES.INVALID_AMOUNT,
        `闁硅埖娲橀弫鐐烘煂閹达富鏉洪梻鍥ｅ亾闁?${this.config.minBetAmount}-${this.config.maxBetAmount} 濞戞柨顑夊Λ绺?
      );
    }

    // 缁绢収鍠曠换姘舵煂閹达富鏉哄☉鎾跺劋椤掓粓寮?
    if (request.amount <= 0 || !Number.isFinite(request.amount)) {
      throw new GameError(ERROR_CODES.INVALID_AMOUNT, '闁硅埖娲橀弫鐐烘煂閹达富鏉洪煫鍥ф嚇閵嗗繑绋夐悜姗嗗妧闁?);
    }

    // 5. 闁烩晩鍠楅悥锝囨偘鐏炵虎姊鹃柡?
    if (!Number.isFinite(request.targetRow) || request.targetRow < 0 || request.targetRow > MAX_ROW_INDEX) {
      throw new GameError(ERROR_CODES.INVALID_AMOUNT, `闁烩晩鍠楅悥锝囨偘瀹€鈧崒銊ヮ嚕閺囩偟绠戝銈堫嚙濠€?0-${MAX_ROW_INDEX} 濞戞柨顑夊Λ绺?;
    }

    // 6. 闁活潿鍔嶉崺娑㈠箮閺囩喐鏆堥柡浣峰嵆閸ｆ椽姊介幇顒€鐓?
    const userBetCount = Array.from(this.state.activeBets.values()).filter(
      (b) => b.userId === userId && b.status === 'PENDING'
    ).length;
    if (userBetCount >= this.config.maxBetsPerUser) {
      throw new GameError(ERROR_CODES.MAX_BETS_REACHED, '鐎规瓕灏幓顏堝礆閻楀牊浠樺鍫嗗嫬顫屾繛澶堝妽閺嗙喖鏌?);
    }

    // 7. 閻犱緤绱曢悾濠氬磹瀹ュ洤鑺?
    const multiplier = calculateMultiplier(
      request.targetRow,
      this.state.currentRow,
      request.targetTime - this.state.elapsed
    );

    if (!Number.isFinite(multiplier) || multiplier <= 0) {
      throw new GameError(ERROR_CODES.INVALID_AMOUNT, '闁哄啰濮甸弲銉╂儍閸曨偀鍋撳鍥ц姵');
    }

    // 8. 閻犱降鍨瑰畷鐑瓺濡ょ姴鐭侀惁?
    if (!request.orderId || typeof request.orderId !== 'string' || request.orderId.trim() === '') {
      throw new GameError(ERROR_CODES.INVALID_AMOUNT, '閻犱降鍨瑰畷鐑瓺濞戞挸绉烽崗妯荤▔閾忓厜鏁?);
    }

    // 9. 妤犵偛鍊婚悺鎴﹀箑瑜庨ˉ鍛村蓟閵夘垳绐楅柛蹇撶墛閻擄紕鎷犻。鏅俤erId闁哄嫷鍨伴幆浣割啅閹绘帞鎽犻柛?
    const existingBet = await this.prisma.bet.findUnique({
      where: { orderId: request.orderId },
    });

    if (existingBet) {
      // 濡ょ姴鐭侀惁澶愭偨閵婏箑鐓曢柟纰樺亾闁哄牆顦板?
      if (existingBet.userId !== userId) {
        console.warn(`[GameEngine] Order ID ${request.orderId} belongs to different user`);
        throw new GameError(ERROR_CODES.DUPLICATE_BET, '閻犱降鍨瑰畷鐑瓺鐎规瓕灏～锔芥媴鐠恒劍鏆?);
      }
      console.log(`[GameEngine] Duplicate bet request: ${request.orderId}`);
      return {
        betId: existingBet.id,
        multiplier: Number(existingBet.multiplier),
        targetTime: Number(existingBet.targetTime ?? 0),
        targetRow: Number(existingBet.targetRow ?? 0),
      };
    }

    // 8. 闁告帒妫楃粩宄邦嚕韫囨稒鏁?
    const lockKey = `${REDIS_KEYS.BET_LOCK}${request.orderId}`;
    const locked = await this.redis.set(lockKey, '1', 'EX', 30, 'NX');
    if (!locked) {
      throw new GameError(ERROR_CODES.DUPLICATE_BET, '闂佹彃绉撮ˇ鏌ユ儍閸曨剙顫屾繛澶堝姀椤曨剙效?);
    }

    try {
      // 9. 闁告鍠庨悺娆撳箥閿濆棭鍎?+ 閻犱焦婢樼紞宥夊箮閺囩喐鏆堥柨娑樼墕鐏忓爼宕ュ鍥ㄦ殢闁规挳鏀遍悥鍫曟偝閳哄伆浣割嚕韫囨氨鍎查弶鈺佹处閺嗙喖骞戦鑲╂皑闁瑰灝绉崇紞鏃堟晬?
      const isAnonymous = userId.startsWith('anon-');
      const bet = await this.prisma.$transaction(async (tx) => {
        // 闁革负鍔嬬花銊╁礉閳ュ啿鏁跺ù婊冩湰椤愬ジ寮介敓鐘靛矗闁搞儳鍋涢幃搴ㄦ偐閼哥鍋?闂傚啫寮堕娑欑▔瀹稿潱dRound妤犵偠娉涜ぐ?
        const currentRound = await tx.round.findUnique({
          where: { id: roundId },
          select: { status: true },
        });

        if (!currentRound || currentRound.status !== 'BETTING') {
          throw new GameError(ERROR_CODES.BETTING_CLOSED, '闁搞儳鍋涢幃搴☆啅閹绘帒褰犻梻鍌ゅ幗閸ㄣ劍绋夊鍛憼闁?);
        }

        // 闁告牕鐏濋幃鏇㈡偨閵婏箑鐓曢柛娆樹海閸忔ê銆掗崫銉ヨ礋婵☆垪鈧磭纭€闁挎稑鐭侀悜锔芥交閸ワ妇绋囧Λ鐗堢箖椤ュ懘寮?
        if (isAnonymous && !request.isPlayMode) {
          throw new GameError(ERROR_CODES.INSUFFICIENT_BALANCE, '闁告牕鐏濋幃鏇㈡偨閵婏箑鐓曢柛娆樹海閸忔ɑ鎷呯捄銊︽殢婵炴挸鎽滅敮鍝勎熼垾宕囩');
        }

        // Create bet first so we can reliably attach relatedBetId for the BET transaction.
        const newBet = await tx.bet.create({
          data: {
            userId,
            roundId,
            orderId: request.orderId,
            amount: request.amount,
            multiplier,
            rowIndex: Math.round(request.targetRow),
            colIndex: Math.round(request.targetTime),
            targetRow: request.targetRow,
            targetTime: request.targetTime,
            asset: this.config.asset,
            isPlayMode: request.isPlayMode ?? false,
            status: 'PENDING',
          },
        });

        // 闂傚牏鍋涚亸鍫曞触瀹ュ洦鏆忛柟瀵稿厴濞撳墎鎲版担鐟扳拸婵炲棙鎷濈槐娆愭媴鐠恒劍鏆?FinancialService闁?
        if (!isAnonymous) {
          const result = await this.financialService.conditionalChangeBalance(
            {
              userId,
              amount: -request.amount,
              type: 'BET',
              isPlayMode: request.isPlayMode,
              minBalance: request.amount,
              relatedBetId: newBet.id,
              remark: `闁硅埖娲橀弫?${this.config.asset} 闁搞儳鍋涢幃?${roundId}`,
            },
            tx
          );

          if (!result.success) {
            throw new GameError(ERROR_CODES.INSUFFICIENT_BALANCE, result.error || '濞达絾鐟╅·鍌涚▔瀹ュ牆鍠?);
          }

        }

        // 闁告帗绋戠紓鎾诲箮閺囩喐鏆堥悹浣规緲缂嶅秹鏁嶉崼婵嗙樁闁告氨骞坮derId闁?
        return newBet;
      });

      // 9. 婵烇綀顕ф慨鐐哄礆閻楀牊銇熼悹鍝勫暞婵洤鈻旈妸锔炬建
      const serverBet: ServerBet = {
        id: bet.id,
        orderId: request.orderId,
        userId,
        amount: request.amount,
        multiplier,
        targetRow: request.targetRow,
        targetTime: request.targetTime,
        placedAt: Date.now(),
        status: 'PENDING',
        isPlayMode: request.isPlayMode ?? false,
      };

      this.state.activeBets.set(bet.id, serverBet);
      this.heapPush(serverBet);

      // 10. 闁告艾鏈鐐哄礆?Redis闁挎稑鐗嗙槐鎾愁潰閵夘垳绀?
      setImmediate(() => {
        if (!this.state || this.state.roundId !== roundId) return;

        this.redis
          .zadd(
            `${REDIS_KEYS.ACTIVE_BETS}${roundId}`,
            request.targetTime,
            JSON.stringify(serverBet)
          )
          .catch((err) => console.error('[GameEngine] Redis sync failed:', err));
      });

      // 11. 闁兼儳鍢茶ぐ鍥嫉閳ь剟寮０浣虹▏濡増绻愮槐娆撳礌閸喗鍊抽柣顫妽閸╂稒娼婚弬鎸庣 0闁?
      let newBalance = 0;
      if (!isAnonymous) {
        const user = await this.prisma.user.findUnique({
          where: { id: userId },
          select: { balance: true, playBalance: true },
        });
        newBalance = request.isPlayMode
          ? Number(user?.playBalance ?? 0)
          : Number(user?.balance ?? 0);
      }

      // 12. 妤犵偞瀵ч幐閬嶅箮閺囩喐鏆堢痪顓у枦椤撳鏁嶉崼婵嗙樁闁?userId 闁告粌濂旂紞鎴烇紣濠靛懍绻嗛柟顓у灣閺併倖绂嶆惔锛勬毎闁告碍鍨佃ぐ鍌炴焻娓氬﹦绀?
      this.emit('bet:confirmed', {
        userId,
        orderId: request.orderId,
        betId: bet.id,
        multiplier,
        targetRow: request.targetRow,
        targetTime: request.targetTime,
        amount: request.amount,
        newBalance,
      });

      console.log(`[GameEngine] Bet ${bet.id} placed by ${userId}`);

      return {
        betId: bet.id,
        multiplier,
        targetTime: request.targetTime,
        targetRow: request.targetRow,
      };
    } catch (error) {
      // 濠㈡儼绮剧憴锕傚籍閸撲胶褰岄柛妤佸▕閸ｆ挳寮ㄦィ鍐╂暁
      await this.redis.del(lockKey);
      throw error;
    }
    // 闁瑰瓨鍔曟慨娑㈠籍閹偊鍞ㄩ梺澶告祰閸ゆ粓鎮為幆鎵畺闁哄牏鍣︾槐婵嬫焼閸喖甯抽梺鎻掔Т椤﹁尙鎷犻柨瀣勾
  }

  /**
   * 闁硅埖娲橀弫鐐达紣閹寸姴鑺抽梻鍕姇閸╂螞閳ь剟寮?
   */
  private async checkRateLimit(userId: string): Promise<boolean> {
    const configuredWindowMs = Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '', 10);
    const windowMs = Number.isFinite(configuredWindowMs) && configuredWindowMs > 0 ? configuredWindowMs : 1000;
    return allowSlidingWindowRequest({
      redis: this.redis,
      key: buildRateLimitKey(userId),
      windowMs,
      maxRequests: this.config.maxBetsPerSecond,
    });
  }

  // ========== Tick 鐎甸偊浜為獮?==========

  private startTickLoop(): void {
    this.tickTimer = setInterval(() => this.tick(), this.config.tickInterval);
  }

  private stopTickLoop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  /**
   * 闁哄秶顭堢缓?Tick 鐎甸偊浜為獮?- 濞达綀娉曢弫銈夊嫉閳ь剛浜歌箛鎾跺灮濞村吋锚鐎?
   */
  private tick(): void {
    if (!this.state || this.state.status === 'SETTLING' || this.state.status === 'COMPLETED') {
      return;
    }

    const now = Date.now();
    this.state.elapsed = (now - this.state.roundStartTime) / 1000;

    // 1. 闁兼儳鍢茶ぐ鍥嫉閳ь剟寮０浣哄箚闁?
    if (this.priceCache) {
      this.state.currentPrice = this.priceCache.price;
      this.state.currentRow = calculateRowIndex(this.priceCache.price, this.state.startPrice);
    }

    // 2. 缁炬壆澧楅幐鎺懳涢埀顒€霉鐎ｅ墎绀勯柡鍫氬亾閻忓繐绻愰悥銏″濡搫顕ч柨娑欒壘瑜把勫緞閸曨厽鍊為柛妤€鍟块惃銏ゅ礆閻楀牊鍩傞柣銊ュ婵洤鈻旈…鎺旂
    const prevRow = this.state.prevRow ?? this.state.currentRow;
    const toSettle: SettlementItem[] = [];

    // 濞寸姴楠搁悥銏°亜鐠哄搫绲块柛鎴犲劋婢у秹寮垫径濠冭含婵☆偀鍋撴繛鏉戭儑閻涖儵宕ｉ敐鍛暥闁汇劌瀚慨鍥р枖?
    while (this.betHeap.length > 0) {
      const bet = this.betHeap[0];

      // 闁割偄妫濋妴濠囧箮閺囩喐鏆堥弶鈺偵戝﹢顓熸交濞戞ê寮虫俊顐熷亾婵炴潙顑囬悰銉╁矗閿濆繒绀夐柛姘捣閻㈠骞庨弴鐔告殘闁哄洤鐡ㄥ▍鍕晬瀹€鈧ú鍧楀箳閵夆斁鍋撻埀顒勫礄?
      if (bet.targetTime > this.state.elapsed + HIT_TIME_TOLERANCE) break;

      // 鐎规瓕灏粔瀛樻交?MISS 缂佹劖顨呰ぐ娑㈡晬鐏炲墽鍨奸悹渚€顣︾拹鐔稿緞鏉堫偉袝
      if (this.state.elapsed > bet.targetTime + MISS_TIME_BUFFER) {
        this.heapPop();
        if (bet.status === 'PENDING') {
          toSettle.push({ bet, isWin: false });
          bet.status = 'SETTLING';
        }
        continue;
      }

      // 闁革负鍔嶉ˉ鍛圭€ｎ剛宕堕柛娆欑到閸炴挳鏁嶇仦缁㈡⒕闁哄被鍎抽～顐﹀箻?
      const timeDiff = Math.abs(this.state.elapsed - bet.targetTime);
      if (timeDiff <= HIT_TIME_TOLERANCE) {
        const minRow = Math.min(prevRow, this.state.currentRow) - this.config.hitTolerance;
        const maxRow = Math.max(prevRow, this.state.currentRow) + this.config.hitTolerance;

        if (bet.targetRow >= minRow && bet.targetRow <= maxRow) {
          this.heapPop();
          if (bet.status === 'PENDING') {
            toSettle.push({
              bet,
              isWin: true,
              hitDetails: {
                hitPrice: this.state.currentPrice,
                hitRow: this.state.currentRow,
                hitTime: this.state.elapsed,
              },
            });
            bet.status = 'SETTLING';
          }
          continue;
        }
      }

      // 閺夆晜锚濠€顏嗙玻濡も偓瑜版盯宕橀崨顒傜ɑ闁哄牜浜滈幊鈩冪▔椤撱劎绀夊ǎ鍥ㄧ箘閺嗏偓闁革负鍔岄悥銏＄▔椤撶姷鎼肩€垫澘鎳嶇粭鍛▔閳ь剛鏁?
      break;
    }

    // 3. 濞ｅ洦绻傞悺銊︾▔婵犱胶顏遍悽顖嗗棭鏀界紒渚垮灩缁?
    this.state.prevRow = this.state.currentRow;

    // 4. 鐎殿喖鍊归鐐电磼閹惧墎鏆?
    if (toSettle.length > 0) {
      this.settlementQueue.push(...toSettle);
      this.processSettlementQueue();
    }

    // 5. 缂傚倹鎸搁崯鎸庣闁垮澹愰煫鍥跺亞閸?
    this.bufferPriceSnapshot();

    // 6. 妤犵偞瀵ч幐閬嶆偐閼哥鍋撴担瑙勭函闁哄倸搴滅槐娆撴嚍閸屾稓銈﹂柨?
    this.emitThrottled('state:update', {
      elapsed: this.state.elapsed,
      currentPrice: this.state.currentPrice,
      currentRow: this.state.currentRow,
    });

    // 7. 婵☆偀鍋撻柡灞诲劚濞叉牠宕ラ崼锝囆㈤柡?
    if (this.state.elapsed >= this.config.maxDuration) {
      setImmediate(() => {
        if (!this.state) return;
        void this.endRound('timeout').catch((error) => {
          console.error('[GameEngine] endRound failed:', error);
        });
      });
    }
  }

  // ========== 缂備焦鎸鹃悾缁樺緞閸曨厽鍊?==========

  /**
   * 缂備焦鎸鹃悾濠氬箥閳ь剟寮垫径濠勭缂備焦鎸鹃悾濠氬箮閺囩喐鏆堥柨娑樼墕濞叉牠宕ラ崼銏㈡尝闁哄鍠愬鍌滄嫬閸愵亝鏆忛柨?
   */
  private settleAllPendingBets(): void {
    // 婵炴挸鎳愰埞鏍醇閸℃洝鍘柟纰樺亾闁哄牆顦晶鎸庢媴濞嗘劕顫屾繛?
    while (this.betHeap.length > 0) {
      const bet = this.heapPop()!;
      if (bet.status !== 'PENDING') continue;

      const timeDiff = Math.abs(this.state!.elapsed - bet.targetTime);
      const rowDiff = Math.abs(this.state!.currentRow - bet.targetRow);
      const isWin = timeDiff <= HIT_TIME_TOLERANCE && rowDiff <= this.config.hitTolerance;

      bet.status = 'SETTLING';

      this.settlementQueue.push({
        bet,
        isWin,
        hitDetails: isWin
          ? {
              hitPrice: this.state!.currentPrice,
              hitRow: this.state!.currentRow,
              hitTime: this.state!.elapsed,
            }
          : undefined,
      });
    }

    this.processSettlementQueue();
  }

  /**
   * 鐎殿喖鍊归鐐电磼閹惧墎鏆梻鍐枎閸亝寰勯崟顓熷€?
   * 濞达綀娉曢弫?FinancialService 闁归潧缍婇崳鐑樺緞閸曨厽鍊為柣顫妽閸╂稒鎷呭▎鎿冩澓闁告瑦锚婵晠鏁嶇仦鎯х倒濡ゅ倹蓱閳ь儸鍡楀幋
   */
  private async processSettlementQueue(): Promise<void> {
    if (this.isSettling || this.settlementQueue.length === 0) return;

    this.isSettling = true;

    try {
      while (this.settlementQueue.length > 0) {
        const batch = this.settlementQueue.slice(0, 50);
        let retryCount = 0;
        const maxRetries = 3;

        while (retryCount <= maxRetries) {
          try {
            await this.prisma.$transaction(async (tx) => {
              // 闁圭顦遍弫銈夊箣閻ゎ垯绮甸柛姘墛婵洤鈻旈…鎺旂闁告垵绻愰惃顖炲极閻楀牆绁﹂幖瀛樻尰閻擄紕鎷犻姀鈽嗗仹闁?
              const userAggregates = new Map<string, {
                bets: Array<{ bet: typeof batch[0]['bet'], isWin: boolean, hitDetails: typeof batch[0]['hitDetails'], payout: number }>,
                totalPayout: number,
                totalPayoutPlay: number,
                totalBets: number,
                totalWins: number,
                totalLosses: number,
                totalProfit: number,
                balanceChanges: Array<{ amount: number, type: 'WIN', relatedBetId: string, remark: string }>,
              }>();

              // 缂佹鍏涚粩鎾⒓閼告鍞介柨娑欑濞插潡寮悧鍫濐潓婵炲鍔庢慨鎼佸箑娴ｆ瓕瀚欓柤杈ㄨ壘閹酣鎮介妸锕€鐓曢柡浣哄瀹?
              for (const { bet, isWin, hitDetails } of batch) {
                // 缁绢収鍠曠换?multiplier 闁肩绉撮崣鍡樼▔閳ь剟鎳涚€涙ǚ鍋?
                const payout = this.calculatePayout(bet.amount, bet.multiplier, isWin);

                const updated = await tx.bet.updateMany({
                  where: { id: bet.id, status: 'PENDING' },
                  data: {
                    status: isWin ? 'WON' : 'LOST',
                    isWin,
                    payout,
                    hitPrice: hitDetails?.hitPrice,
                    hitRow: hitDetails?.hitRow,
                    hitTime: hitDetails?.hitTime,
                    settledAt: new Date(),
                  },
                });

                if (updated.count === 1) {
                  const agg = userAggregates.get(bet.userId) || {
                    bets: [],
                    totalPayout: 0,
                    totalPayoutPlay: 0,
                    totalBets: 0,
                    totalWins: 0,
                    totalLosses: 0,
                    totalProfit: 0,
                    balanceChanges: [],
                  };

                  agg.bets.push({ bet, isWin, hitDetails, payout });
                  if (isWin && payout > 0) {
                    if (bet.isPlayMode) {
                      agg.totalPayoutPlay += payout;
                    } else {
                      agg.totalPayout += payout;
                      // 闁衡偓閸洘鑲犻柣顏嗗枎閻ゅ嫭鎷呭▎鎿冩澓闁汇劌瀚懓浠嬫煢閸楃偛缍侀柛?
                      agg.balanceChanges.push({
                        amount: payout,
                        type: 'WIN',
                        relatedBetId: bet.id,
                        remark: `閻犙佸灩缁堕亶骞庨弴鐔告殘 ${bet.id}`,
                      });
                    }
                  }
                  if (!bet.isPlayMode) {
                    agg.totalBets++;
                    if (isWin) agg.totalWins++;
                    else agg.totalLosses++;
                    agg.totalProfit += isWin ? payout - bet.amount : -bet.amount;
                  }

                  userAggregates.set(bet.userId, agg);
                } else {
                  console.log(`[GameEngine] Bet ${bet.id} already settled, skipping`);
                }
              }

              // 缂佹鍏涚花鈺呮⒓閼告鍞介柨娑欑婢规帡鏌岃箛鏃€绾柡鍌涘閺併倝骞嬮摎鍌滅▏濡増绻傞幏鎵磼閻旀椿鍚€闁挎稑鐗呮繛鍥偨?FinancialService闁?
              for (const [userId, agg] of userAggregates) {
                // 闁哄洤鐡ㄩ弻濠勭磼閻旀椿鍚€閻庢稒顨嗛?
                const updateData: any = {
                  totalBets: { increment: agg.totalBets },
                  totalWins: agg.totalWins > 0 ? { increment: agg.totalWins } : undefined,
                  totalLosses: agg.totalLosses > 0 ? { increment: agg.totalLosses } : undefined,
                  totalProfit: { increment: agg.totalProfit },
                };

                // 闁哄洤鐡ㄩ弻濠囨儑閻旈鏉藉ù锝嗙懇椤ゅ倿鏁嶉崼婊冣枏闁?FinancialService 闁归潧缍婇崳鐑樺緞閸曨厽鍊為柨?
                if (agg.balanceChanges.length > 0) {
                  await this.financialService.batchChangeBalance(
                    {
                      userId,
                      changes: agg.balanceChanges,
                      isPlayMode: false,
                    },
                    tx
                  );
                } else if (agg.totalPayout > 0) {
                  // Fallback: should be rare, but still route through FinancialService.
                  await this.financialService.changeBalance(
                    {
                      userId,
                      amount: agg.totalPayout,
                      type: 'WIN',
                      isPlayMode: false,
                      remark: 'Batch payout (fallback)',
                    },
                    tx
                  );
                }

                // 闁哄洤鐡ㄩ弻濠傘€掗崨濠傜亞濞达絾鐟╅·?
                if (agg.totalPayoutPlay > 0) {
                  await this.financialService.changeBalance(
                    {
                      userId,
                      amount: agg.totalPayoutPlay,
                      type: 'WIN',
                      isPlayMode: true,
                      remark: 'Batch payout (play)',
                    },
                    tx
                  );
                }

                await tx.user.update({ where: { id: userId }, data: updateData });
              }
            });

            // DB闁瑰瓨鍔曟慨娑㈠触鎼淬垹顤呭ǎ鍥跺枟閺佸ジ宕橀崨顓犳憼闁绘鍩栭埀?
            for (const { bet, isWin } of batch) {
              bet.status = isWin ? 'WON' : 'LOST';
            }

            // 妤犵偞瀵ч幐杈╃磼閹惧墎鏆紓浣规尰閻?
            for (const { bet, isWin, hitDetails } of batch) {
              // 缁绢収鍠曠换?multiplier 闁肩绉撮崣鍡樼▔閳ь剟鎳涚€涙ǚ鍋?
              const payout = this.calculatePayout(bet.amount, bet.multiplier, isWin);
              this.emit('bet:settled', {
                betId: bet.id,
                orderId: bet.orderId,
                userId: bet.userId,
                isWin,
                payout,
                hitDetails,
              });
            }

            // 闁瑰瓨鍔曟慨娑㈠触鎼达及鈺呮⒔椤﹀潊tch
            this.settlementQueue.splice(0, batch.length);
            break;
          } catch (error) {
            retryCount++;
            if (retryCount > maxRetries) {
              console.error('[GameEngine] Settlement batch failed after retries:', error);
              // 濠㈡儼绮剧憴锕傚触鎼存繄鐟濈紒澶婎煼濞呭酣鏁嶇仦鑲╃憮婵炲棌鈧櫕鍎曢柣婊庡灟缁变即鏌屽鍫㈡Ц
              break;
            }
            // 闁圭娲﹂弳鐔兼焻閳ь剟鏌?
            await new Promise((resolve) => setTimeout(resolve, Math.pow(2, retryCount) * 100));
          }
        }

        // 濠碘€冲€归悘澶愭煂瀹ュ牏妲稿鎯扮簿鐟欙箓鏁嶅畝鍐劜闁告垵鎼幆濠囨偝椤栫偘缂夐柛蹇撶У椤掓潙顕ラ鍡楃畾
        if (retryCount > maxRetries) {
          break;
        }
      }
    } finally {
      this.isSettling = false;
    }
  }

  /**
   * 缂佹稑顦欢鐔虹磼閹惧墎鏆梻鍐枎閸亜銆掗崨顖楁晞
   */
  private async flushSettlementQueue(): Promise<boolean> {
    const maxWaitTime = 30000; // 閺堚偓婢舵氨鐡戝?0缁?
    const startTime = Date.now();

    while (this.settlementQueue.length > 0 || this.isSettling) {
      // 妫€鏌ヨ秴鏃?
      if (Date.now() - startTime > maxWaitTime) {
        console.error('[GameEngine] Settlement queue flush timeout, continuing anyway');
        return false;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    return true;
  }

  private scheduleSettlementRetry(
    roundId: string,
    snapshot: { elapsed: number; currentRow: number; currentPrice: number },
    reason: string
  ): void {
    if (this.settlementRetryTimers.has(roundId)) return;

    const attempts = this.settlementRetryAttempts.get(roundId) ?? 0;
    const maxAttempts = 3;
    if (attempts >= maxAttempts) {
      console.error(`[GameEngine] Pending bet settlement exhausted retries for round ${roundId}`);
      return;
    }

    const delayMs = Math.min(30000, 1000 * Math.pow(2, attempts));
    console.warn(
      `[GameEngine] Scheduling settlement retry for round ${roundId} in ${delayMs}ms (attempt ${attempts + 1}, reason: ${reason})`
    );

    const timer = setTimeout(() => {
      this.settlementRetryTimers.delete(roundId);
      this.settlementRetryAttempts.set(roundId, attempts + 1);
      void this.retryPendingBets(roundId, snapshot, reason);
    }, delayMs);

    this.settlementRetryTimers.set(roundId, timer);
  }

  private clearSettlementRetry(roundId: string): void {
    const timer = this.settlementRetryTimers.get(roundId);
    if (timer) {
      clearTimeout(timer);
      this.settlementRetryTimers.delete(roundId);
    }
    this.settlementRetryAttempts.delete(roundId);
  }

  private async retryPendingBets(
    roundId: string,
    snapshot: { elapsed: number; currentRow: number; currentPrice: number },
    reason: string
  ): Promise<void> {
    const unsettledBets = await this.prisma.bet
      .findMany({
        where: {
          roundId,
          status: 'PENDING',
        },
      })
      .catch((error) => {
        console.error(`[GameEngine] Failed to query unsettled bets for retry (round ${roundId}):`, error);
        return [];
      });

    if (unsettledBets.length === 0) {
      this.clearSettlementRetry(roundId);
      return;
    }

    console.warn(
      `[GameEngine] Retrying ${unsettledBets.length} unsettled bets for round ${roundId} (reason: ${reason})`
    );

    for (const dbBet of unsettledBets) {
      try {
        const targetTime = Number(dbBet.targetTime ?? 0);
        const targetRow = Number(dbBet.targetRow ?? 0);
        const isWin =
          Math.abs(snapshot.elapsed - targetTime) <= HIT_TIME_TOLERANCE &&
          Math.abs(snapshot.currentRow - targetRow) <= this.config.hitTolerance;
        const hitDetails = isWin
          ? {
              hitPrice: snapshot.currentPrice,
              hitRow: snapshot.currentRow,
              hitTime: snapshot.elapsed,
            }
          : undefined;

        const amount = Number(dbBet.amount);
        const multiplierValue = Number(dbBet.multiplier);
        const payout = this.calculatePayout(amount, multiplierValue, isWin);
        const settledAt = new Date();

        const didSettle = await this.prisma.$transaction(async (tx) => {
          const updated = await tx.bet.updateMany({
            where: { id: dbBet.id, status: 'PENDING' },
            data: {
              status: isWin ? 'WON' : 'LOST',
              isWin,
              payout,
              hitPrice: hitDetails?.hitPrice,
              hitRow: hitDetails?.hitRow,
              hitTime: hitDetails?.hitTime,
              settledAt,
            },
          });

          if (updated.count !== 1) return false;

          if (isWin && payout > 0) {
            await this.financialService.changeBalance(
              {
                userId: dbBet.userId,
                amount: payout,
                type: 'WIN',
                isPlayMode: dbBet.isPlayMode,
                relatedBetId: dbBet.id,
                remark: `Win bet ${dbBet.id} (retry)`,
              },
              tx
            );
          }

          if (!dbBet.isPlayMode) {
            await tx.user.update({
              where: { id: dbBet.userId },
              data: {
                totalBets: { increment: 1 },
                totalWins: isWin ? { increment: 1 } : undefined,
                totalLosses: !isWin ? { increment: 1 } : undefined,
                totalProfit: {
                  increment: isWin ? payout - amount : -amount,
                },
              },
            });
          }

          return true;
        });

        if (didSettle) {
          const memBet = this.state?.activeBets.get(dbBet.id);
          if (memBet) {
            memBet.status = isWin ? 'WON' : 'LOST';
          }
        }
      } catch (error) {
        console.error(`[GameEngine] Failed to retry settle bet ${dbBet.id} for round ${roundId}:`, error);
      }
    }

    const remaining = await this.prisma.bet
      .count({ where: { roundId, status: 'PENDING' } })
      .catch((error) => {
        console.error(`[GameEngine] Failed to count pending bets after retry for round ${roundId}:`, error);
        return unsettledBets.length;
      });

    if (remaining > 0) {
      this.scheduleSettlementRetry(roundId, snapshot, reason);
    } else {
      this.clearSettlementRetry(roundId);
    }
  }

  // ========== 閺夊牆鎳庢慨顏堝棘鐟欏嫮銆?==========

  /**
   * 缂傚倹鎸搁崯鎸庣闁垮澹愰煫鍥跺亞閸?
   */
  private bufferPriceSnapshot(): void {
    if (!this.state) return;

    // 婵?100ms 閻犱焦婢樼紞宥嗙▔閳ь剙鈻?
    const snapshotIndex = Math.floor(this.state.elapsed * 10);
    const bufferSize = this.priceSnapshotBuffer.length - this.priceSnapshotBufferHead;
    if (bufferSize > 0) {
      const lastIndex = Math.floor(
        (this.priceSnapshotBuffer[this.priceSnapshotBuffer.length - 1].timestamp.getTime() -
          this.state.roundStartTime) /
          100
      );
      if (snapshotIndex === lastIndex) return;
    }

    // 闂傚啰鍠庨崹顏堟⒔閹邦剙鐓戦柨娑欏哺濡茶顫㈤姀鐘叉暥閻庢稒蓱鐎涒晠宕?(O(1) shift via head increment)
    const maxQueue = parseInt(process.env.MAX_SNAPSHOT_QUEUE ?? '10000', 10);
    if (bufferSize >= maxQueue) {
      this.priceSnapshotBufferHead++;
    }

    this.priceSnapshotBuffer.push({
      roundId: this.state.roundId,
      timestamp: new Date(),
      price: this.state.currentPrice,
      rowIndex: this.state.currentRow,
    });

    // 婵絽绻掗～妤呭箥瑜版帒娅ら柛鎰懃閸?
    const now = Date.now();
    if (
      now - this.lastSnapshotFlush >= 1000 &&
      now >= this.snapshotFlushBackoffUntil &&
      bufferSize > 0
    ) {
      void this.flushPriceSnapshots().catch(console.error);
    }
  }

  /**
   * 闁告帡鏀遍弻濠冪闁垮澹愰煫鍥跺亞閸欏酣宕氶悧鍫熸闁硅鍠栫花?
   */
  private flushPriceSnapshots(): Promise<void> {
    if (this.snapshotFlushPromise) return this.snapshotFlushPromise;
    const bufferSize = this.priceSnapshotBuffer.length - this.priceSnapshotBufferHead;
    if (bufferSize === 0) return Promise.resolve();

    const now = Date.now();
    if (now < this.snapshotFlushBackoffUntil) return Promise.resolve();

    this.lastSnapshotFlush = now;

    this.snapshotFlushPromise = this.flushPriceSnapshotsInternal().finally(() => {
      this.snapshotFlushPromise = null;
    });

    return this.snapshotFlushPromise;
  }

  private async flushPriceSnapshotsInternal(): Promise<void> {
    const buffer = this.priceSnapshotBuffer.slice(this.priceSnapshotBufferHead);
    this.priceSnapshotBuffer = [];
    this.priceSnapshotBufferHead = 0;
    if (buffer.length === 0) return;

    const rawBatchSize = parseInt(process.env.SNAPSHOT_FLUSH_BATCH_SIZE ?? '500', 10);
    const batchSize = Number.isFinite(rawBatchSize) && rawBatchSize > 0 ? rawBatchSize : 500;

    let index = 0;
    try {
      for (; index < buffer.length; index += batchSize) {
        const batch = buffer.slice(index, index + batchSize);
        await this.prisma.priceSnapshot.createMany({ data: batch });
      }

      this.snapshotFlushFailures = 0;
      this.snapshotFlushBackoffUntil = 0;
    } catch (error) {
      console.error('[GameEngine] Price snapshot flush failed:', error);

      // 濠㈡儼绮剧憴锕傚籍鐠鸿櫣娈洪柡鍫簻閸熸捇宕楅妷褎鐣遍柡浣哄瀹撲線寮ㄩ幆褎绀€缂傚倹鎸搁崯鍧楀礌?闂侇剙鐏濋崢銈嗙▔閵忕姰浜奸柨娑樼墕閸戯繝骞嬮幇顒€顫犻柛鎰懃閸欏棝鎯冮崟顒€顥楁繛鍡忊偓鑼憹闁搞儳鍋炵划鎾晬?
      const remaining = buffer.slice(index);
      if (remaining.length > 0) {
        this.priceSnapshotBuffer = remaining.concat(this.priceSnapshotBuffer);
      }

      this.snapshotFlushFailures = Math.min(this.snapshotFlushFailures + 1, 10);
      const baseDelayMs = parseInt(process.env.SNAPSHOT_FLUSH_RETRY_BASE_MS ?? '1000', 10);
      const maxDelayMs = parseInt(process.env.SNAPSHOT_FLUSH_RETRY_MAX_MS ?? '30000', 10);
      const base = Number.isFinite(baseDelayMs) && baseDelayMs > 0 ? baseDelayMs : 1000;
      const max = Number.isFinite(maxDelayMs) && maxDelayMs > 0 ? maxDelayMs : 30000;
      const delayMs = Math.min(max, base * 2 ** (this.snapshotFlushFailures - 1));
      this.snapshotFlushBackoffUntil = Date.now() + delayMs;
    }
  }

  /**
   * 闁煎搫鍊圭粊锕傚矗閹达腹鍋撴担椋庣殤濞?
   */
  private emitThrottled(event: string, data: unknown, intervalMs = 50): void {
    const now = Date.now();
    const lastEmit = this.lastEmitTimes.get(event) || 0;

    if (now - lastEmit >= intervalMs) {
      this.emit(event, data);
      this.lastEmitTimes.set(event, now);
    }
  }

  /**
   * 闁告艾鏈鐐烘偐閼哥鍋撴担绋跨厒 Redis
   */
  private async syncStateToRedis(): Promise<void> {
    if (!this.state) return;

    await this.redis.hset(`${REDIS_KEYS.ROUND_STATE}${this.state.asset}`, {
      id: this.state.roundId,
      status: this.state.status,
      startPrice: this.state.startPrice.toString(),
      currentRow: this.state.currentRow.toString(),
      elapsed: this.state.elapsed.toString(),
    });
  }

  /**
   * 閻犱緤绱曢悾濠氬炊閻愬弶鍊ょ紓浣哄枙椤?
   */
  private roundMultiplier(multiplier: number): number {
    if (!Number.isFinite(multiplier)) return 0;
    return Math.round(multiplier * 10000) / 10000;
  }

  private calculatePayout(amount: number, multiplier: number, isWin: boolean): number {
    if (!isWin) return 0;
    if (!Number.isFinite(amount) || !Number.isFinite(multiplier)) return 0;
    return roundMoney(amount * this.roundMultiplier(multiplier));
  }

  private calculateRoundStats(): {
    totalBets: number;
    totalWins: number;
    totalVolume: number;
    totalPayout: number;
  } {
    const bets = Array.from(this.state!.activeBets.values()).filter((bet) => !bet.isPlayMode);
    return {
      totalBets: bets.length,
      totalWins: bets.filter((b) => b.status === 'WON').length,
      totalVolume: bets.reduce((sum, b) => sum + b.amount, 0),
      totalPayout: bets
        .filter((b) => b.status === 'WON')
        .reduce((sum, b) => sum + this.calculatePayout(b.amount, b.multiplier, true), 0),
    };
  }

  /**
   * 濠㈣泛瀚幃濠冪闁垮澹愬☉鎾崇Т瑜版煡鎮?
   */
  private handlePriceUnavailable(): void {
    if (this.state && (this.state.status === 'RUNNING' || this.state.status === 'BETTING')) {
      console.warn('[GameEngine] Price unavailable, cancelling round...');
      this.cancelRound('濞寸娀鏀遍悧鎼佸嫉瀹ュ懎顫ゅ☉鎾崇Т瑜版煡鎮?).catch(console.error);
    }
  }

  /**
   * 婵炴挸鎳愰幃濠勬導閸曨剛鐖?
   */
  private cleanup(): void {
    this.state = null;
    this.priceSnapshotBuffer = [];
    this.priceSnapshotBufferHead = 0;
    this.settlementQueue = [];
    this.betHeap = [];
  }

  // ========== 闁哄牃鍋撻悘蹇撶箰閻栥垽骞欏鍕▕ ==========

  /**
   * 闁圭粯甯掗崣鍡涘箮閺囩喐鏆堥柛鎺斿濞撳墎浜歌箛鎾跺灮闁挎稑鐗婄€?targetTime 闁圭儤甯掔花顓㈡晬?
   */
  private heapPush(bet: ServerBet): void {
    this.betHeap.push(bet);
    this.heapifyUp(this.betHeap.length - 1);
  }

  /**
   * 鐎殿喚鎳撻崵顓㈠醇閸℃稏鈧﹪骞庨弴鐔告殘
   */
  private heapPop(): ServerBet | undefined {
    if (this.betHeap.length === 0) return undefined;
    if (this.betHeap.length === 1) return this.betHeap.pop();

    const top = this.betHeap[0];
    this.betHeap[0] = this.betHeap.pop()!;
    this.heapifyDown(0);
    return top;
  }

  /**
   * 濞戞挸锕ョ拠鐐哄箼瀹ュ嫮绋?
   */
  private heapifyUp(idx: number): void {
    while (idx > 0) {
      const parent = Math.floor((idx - 1) / 2);
      if (this.betHeap[idx].targetTime >= this.betHeap[parent].targetTime) break;
      [this.betHeap[idx], this.betHeap[parent]] = [this.betHeap[parent], this.betHeap[idx]];
      idx = parent;
    }
  }

  /**
   * 濞戞挸顑嗛惌鍥箼瀹ュ嫮绋?
   */
  private heapifyDown(idx: number): void {
    const len = this.betHeap.length;
    while (true) {
      let smallest = idx;
      const left = 2 * idx + 1;
      const right = 2 * idx + 2;

      if (left < len && this.betHeap[left].targetTime < this.betHeap[smallest].targetTime) {
        smallest = left;
      }
      if (right < len && this.betHeap[right].targetTime < this.betHeap[smallest].targetTime) {
        smallest = right;
      }
      if (smallest === idx) break;

      [this.betHeap[idx], this.betHeap[smallest]] = [this.betHeap[smallest], this.betHeap[idx]];
      idx = smallest;
    }
  }

  /**
   * 闁稿绮嶉娑橆嚕閺囩喐鎯?
   */
  async stop(): Promise<void> {
    this.stopTickLoop();
    this.stopAutoRound();

    if (this.state) {
      await this.cancelRound('鐎殿喗娲橀幖鎼佸磻濠婂嫷鍓?);
    }

    for (const timer of this.settlementRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.settlementRetryTimers.clear();
    this.settlementRetryAttempts.clear();

    console.log('[GameEngine] Stopped');
  }

  // ========== 闁煎浜滄慨鈺呭炊閻愬弶鍊ょ紒鐙呯磿閹?==========

  private autoRoundTimer: ReturnType<typeof setTimeout> | null = null;
  private autoRoundEnabled = false;
  private boundScheduleNextRound: ((delayMs: number) => void) | null = null;

  /**
   * 闁告凹鍨版慨鈺呮嚊椤忓嫬袟闁搞儳鍋涢幃搴☆嚗椤忓棗绠?
   * 闁搞儳鍋涢幃搴ｇ磼閹惧瓨灏嗛柛姘唉閸ゆ粓宕濋妸銉х；濠殿喖顑勭粭鍛▔閳ь剟宕堕悙鍙夊€?
   */
  startAutoRound(delayMs = 3000): void {
    if (this.autoRoundEnabled) return;

    this.autoRoundEnabled = true;
    console.log('[GameEngine] Auto-round enabled');

    // 闁告帗绋戠紓鎾剁磼閹存繄鏆伴柣銊ュ閸ら亶寮弶璺ㄧ┛闁?濞寸姰鍎扮粚鍫曞触鎼达絿鏁剧紒澶婎煼濞?
    this.boundScheduleNextRound = () => this.scheduleNextRound(delayMs);

    // 闁烩晜鍨甸幆澶愬炊閻愬弶鍊ょ紓浣规尰濞碱偅绂嶇€ｂ晜顐?
    this.on('round:end', this.boundScheduleNextRound);
    this.on('round:cancelled', this.boundScheduleNextRound);

    // 鐎点倖鍎肩换婊堝触椤栨艾袟缂佹鍏涚粩鎾炊閻愬弶鍊ら柨娑樼灱缁増绂掗柨瀣闁哄牆绉存慨鐔煎籍閸洘锛熼柛鎴濇椤?
    this.scheduleNextRound(1000);
  }

  /**
   * 闁稿绮嶉娑㈡嚊椤忓嫬袟闁搞儳鍋涢幃搴☆嚗椤忓棗绠?
   */
  stopAutoRound(): void {
    this.autoRoundEnabled = false;

    if (this.autoRoundTimer) {
      clearTimeout(this.autoRoundTimer);
      this.autoRoundTimer = null;
    }

    // 闁告瑯浜炰簺闂傚嫨鍊涢崵婊堝礉閵娿儲绀€闁告艾鐗忓ù澶愬礂瀹曞洦鐣遍柣鈺傚灥閹宕?
    if (this.boundScheduleNextRound) {
      this.off('round:end', this.boundScheduleNextRound);
      this.off('round:cancelled', this.boundScheduleNextRound);
      this.boundScheduleNextRound = null;
    }

    console.log('[GameEngine] Auto-round disabled');
  }

  /**
   * 閻庣懓顦扮敮鎾寸▔鐎ｂ晝顏遍柛銉у仜閹?
   */
  private scheduleNextRound(delayMs: number): void {
    if (!this.autoRoundEnabled) return;

    console.log(`[GameEngine] Next round in ${delayMs}ms`);

    this.autoRoundTimer = setTimeout(async () => {
      if (!this.autoRoundEnabled) return;

      try {
        await this.startRound();
      } catch (error) {
        console.error('[GameEngine] Failed to start next round:', error);
        // 闂佹彃绉烽惁?
        this.scheduleNextRound(5000);
      }
    }, delayMs);
  }
}
