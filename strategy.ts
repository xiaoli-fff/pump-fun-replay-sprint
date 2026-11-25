// RQ-cross momentum bot, v3 (confirmed explosive cross) for agent-fun/replay/v2.
//
// What the dev tape (1222 coins, full 24h window) actually shows:
//   - The pump happens in the same slot as the trade that pushes a coin's real SOL
//     over a threshold; with the harness's 2-slot fill latency, buying the crossing
//     trade's price is impossible and buying 2 slots later is already too late
//     (median -2.5% over the next 10 slots). Dip-buying, creator-buy signals,
//     repeat-buyer signals, second-burst signals and mature-coin holds all lose
//     at a 2-slot delay. The tape is ~unpredictable 2 slots ahead.
//   - The one filter with a real edge: buy 1 slot after a coin's real SOL first
//     crosses 2 SOL, ONLY when the buying is explosive and broad -- net flow
//     positive, at least 5 distinct non-creator buyers in the confirmation
//     window, and real SOL at least doubled since the cross. Offline that setup
//     averages about +4% gross over the next 10 slots; in the full simulator it
//     nets +0.19 SOL over 41 trades (44% win rate, avg win ~1.9x avg loss).
//     The edge lives in the first ~10 slots after the fill, so exits are fast
//     (TP/SL 10%, max hold 8 slots from fill).
//   - Fresh launches are untradeable: the 1%-of-reserve size cap forces buys so
//     small that the fixed 105k-lamport tx fee eats them. Entries require real
//     SOL >= 2 at the cross and >= 2x growth, so buys are >= 0.04 SOL (the
//     guardrail round-trip minimum is 0.01 SOL).
//
// HONEST CAVEAT (read before submitting): the dev profit is thin and
// regime-dependent. Split by create-slot quarter it is -0.03 / +0.19 / -0.08 /
// +0.12 SOL, and the top 3 coins contribute +0.25 SOL of the +0.19 net --
// without the single best coin (+0.13) the run is slightly negative. The
// neighbouring parameter cells are all positive (+0.19..+0.22 over 36 combos),
// so this is not a single sharp peak, but on the unseen 6h final window the
// outcome is still close to a coin flip with a small positive tilt. This is the
// best version found after testing all three kit pilots, ~10 offline tape
// analyses and ~200 simulator runs; no configuration was found that is
// clearly and robustly positive with margin.
//
// Strategy: watch every curve from its CreateEvent. When its real SOL reserve
// first crosses minRqSol, wait confirmDelay slots; enter only if net buy flow
// since the cross is positive, at least minDistinctBuyers distinct non-creator
// wallets bought in that window, and real SOL grew to minRqGrowthBps of the
// cross value. Buy stakeSol (capped at 1% of real SOL). Exit whole on take
// profit, stop loss, creator sell, or a short time limit. One entry per coin,
// at most 5 open positions. Pure function of the batches: no clock, no
// randomness, no I/O, deterministic iteration order.

import { BPS, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Real SOL reserve a coin must hold at entry. */
  minRqSol: number;
  /** Slots to wait after the reserve first crossed minRqSol before deciding. */
  confirmDelay: number;
  /** Net buy SOL over (cross, decision] required at entry. */
  minFlowSol: number;
  /** Distinct non-creator buyers in (cross, decision] required at entry. */
  minDistinctBuyers: number;
  /** Real SOL at decision must be at least this many bps of the real SOL at the cross. */
  minRqGrowthBps: number;
  /** SOL to put into one position (capped at 1% of real SOL). */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage allowed on buys (bps); sells always 10000. */
  buySlipBps: number;
  /** Exit when the position is worth this much over its cost (bps). */
  tpBps: number;
  /** Exit when it is worth this much under its cost (bps). */
  slBps: number;
  /** Trailing stop: once up at least trailArmBps, exit on a fall of trailBps from the best value. */
  trailArmBps: number;
  trailBps: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held (and had not sold before entry). */
  exitOnDevSell: boolean;
}

export const DEFAULT_PARAMS: Params = {
  minRqSol: 2,
  confirmDelay: 1,
  minFlowSol: 0,
  minDistinctBuyers: 5,
  minRqGrowthBps: 20000,
  stakeSol: 0.2,
  minBuySol: 0.02,
  buySlipBps: 10000,
  tpBps: 1000,
  slBps: 1000,
  trailArmBps: 100000,
  trailBps: 1000,
  maxHold: 8,
  exitOnDevSell: true,
};

const FEE_BPS = 125n;

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** Slot the real SOL reserve first reached minRqSol (-1 = never). */
  crossSlot: number;
  /** Real SOL reserve (lamports) at the cross. */
  crossRq: bigint;
  devSold: boolean;
  recent: Tick[];
  entered: boolean;
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
  devSoldAtOpen: boolean;
}

/** What selling `tokens` against (vq, vt) would pay after curve fees (95 + 30 bps). */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(params: Params = DEFAULT_PARAMS) {
  const P = params;
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  const selling = new Set<Pubkey>();
  const minRq = BigInt(Math.floor(P.minRqSol * 1e9));
  const stake = BigInt(Math.floor(P.stakeSol * 1e9));
  const minBuy = BigInt(Math.floor(P.minBuySol * 1e9));
  const minFlow = BigInt(Math.floor(P.minFlowSol * 1e9));

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          crossSlot: -1,
          crossRq: 0n,
          devSold: false,
          recent: [],
          entered: false,
          done: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
        if (c.crossSlot < 0 && BigInt(e.real_quote_reserves) >= minRq) {
          c.crossSlot = e.slot;
          c.crossRq = BigInt(e.real_quote_reserves);
        }
        if (!e.is_buy && e.user === c.creator) c.devSold = true;
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  /** Distinct non-creator buyers over (fromSlot, slot]. */
  function distinctBuyers(c: Coin, fromSlot: number, slot: number): number {
    const buyers = new Set<Pubkey>();
    for (let i = c.recent.length - 1; i >= 0; i--) {
      const t = c.recent[i]!;
      if (t.slot <= fromSlot) break;
      if (t.slot > slot) continue;
      if (t.isBuy && t.user !== c.creator) buyers.add(t.user);
    }
    return buyers.size;
  }
  function flowSince(c: Coin, fromSlot: number, slot: number): bigint {
    let net = 0n;
    for (let i = c.recent.length - 1; i >= 0; i--) {
      const t = c.recent[i]!;
      if (t.slot <= fromSlot) break;
      if (t.slot > slot) continue;
      net += t.isBuy ? t.sol : -t.sol;
    }
    return net;
  }

  function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'buy') return true;
    return false;
  }

  function hasPendingSell(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'sell') return true;
    return false;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      readEvents(batch);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          held.set(f.mint, { openedSlot: f.slot, txPaid: BigInt(f.tx_fee_lamports), best: 0n, devSoldAtOpen: coins.get(f.mint)?.devSold ?? false });
        }
      }
      for (const mint of [...selling]) if (!hasPendingSell(state, mint)) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy(state, mint)) held.delete(mint);
      }

      // Exits first.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, best: 0n, devSoldAtOpen: c?.devSold ?? false };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;
        let exit = false;
        if (basis > 0n) {
          if (value * BPS >= basis * (BPS + BigInt(P.tpBps))) exit = true;
          if (value * BPS <= basis * (BPS - BigInt(P.slBps))) exit = true;
          if (h.best * BPS >= basis * (BPS + BigInt(P.trailArmBps)) && value * BPS <= h.best * (BPS - BigInt(P.trailBps))) exit = true;
        }
        if (state.slot - h.openedSlot >= P.maxHold) exit = true;
        if (c !== undefined && P.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Entries: decide exactly confirmDelay slots after the cross, only on continued buying.
      let free = state.freeCashLamports();
      let open = state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete || c.entered) continue;
        if (open >= state.hello.caps.max_open_positions) break;
        if (c.crossSlot < 0) continue;
        // Decide on the first batch at or just after crossSlot + confirmDelay; past
        // that small window the confirmation is stale, so the coin is done.
        if (state.slot < c.crossSlot + P.confirmDelay) continue;
        if (state.slot > c.crossSlot + P.confirmDelay + 2) {
          c.done = true;
          continue;
        }
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (curve.real_quote_reserves < minRq) continue;
        if (flowSince(c, c.crossSlot, state.slot) <= minFlow) continue;
        if (distinctBuyers(c, c.crossSlot, state.slot) < P.minDistinctBuyers) continue;
        if (curve.real_quote_reserves * BPS < c.crossRq * BigInt(P.minRqGrowthBps)) continue;
        if (hasPendingBuy(state, c.mint)) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = stake < maxBuy ? stake : maxBuy;
        if (amount < minBuy) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlipBps });
        free -= amount + tx;
        c.entered = true;
        open += 1;
      }
      return orders;
    },
  };
}
