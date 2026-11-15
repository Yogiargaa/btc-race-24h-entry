// Recovery-breakout bot for the cbBTC 1-minute bars replay.
//
// The idea, in one paragraph: one-minute pool prices mostly chop sideways, and
// a plain breakout on them gets faked out again and again. What does follow
// through is a breakout that comes right after a sharp washout: the pool drops
// hard, the weak hands are gone, and the price reclaiming its recent range
// carries real buying behind it. So this bot only buys a 60-bar range breakout
// when the last two hours also contain a sharp drop that the price has already
// started to recover from. It holds with a trailing stop and a time stop, then
// waits out a cooldown before it is allowed to trade again. All comparisons
// are bigint multiplications on the closes the harness sends; there is no
// clock, no randomness and no network, so two runs on the same bars answer
// every batch the same way.
//
// Protocol notes: the harness sends one hello, then one batch per bar, then
// done. Each batch carries the bar that just closed, the fills of the orders
// decided on the previous batch, and the account. Orders decided on a batch
// fill at the next bar's open, so every decision here is made on the close the
// batch just delivered. A batch may carry no bar for our symbol (a minute the
// recorder missed); the bot still answers it, with no orders, and only extends
// its close history when a fresh bar actually arrives.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- strategy parameters (all in bars / basis points) ---
const LOOKBACK = 60; // breakout window: bars of closes
const BREAKOUT_BPS = 10n; // close must clear the prior window high by this much
const MIN_RANGE_BPS = 60n; // window high-to-low range; skips flat chop
const MOMENTUM_BARS = 30; // short-term momentum must be positive over this many bars
const DROP_BARS = 120; // washout context window
const DROP_BPS = 120n; // the context window's low must sit this far under its start
const RECOVER_BPS = 50n; // the close must have reclaimed this much off that low
const TRAIL_BPS = 60n; // trailing stop under the highest close since entry
const TIME_STOP = 240; // bars held before a forced exit
const COOLDOWN = 30; // bars to wait after an exit before re-entering
const MAX_SLIP_BPS = 300; // generous guard against gap fills; normal fills pass easily
// Both windows the rules publish (dev and race) hold 1,440 one-minute bars, and
// anything still held at the end is force-sold at the last close. A position
// opened in the final bars has no room to run before that flattening, so it can
// only pay the round-trip cost: refuse entries in the last NO_ENTRY_TAIL bars.
const TOTAL_BARS = 1440;
const NO_ENTRY_TAIL = 15;

const BPS = 10_000n;

class RecoveryBreakout {
  private closes: bigint[] = []; // closes seen so far, in bar order
  private lastBarT: number | null = null; // t of the last bar folded in (guards duplicates)
  private entryBar: number | null = null; // bar index where the position was first seen
  private peak = 0n; // highest close since entry
  private coolUntil = -1; // bar index before which no new entry is allowed
  private wasInPosition = false;

  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // Fold in a fresh bar for our symbol, if this batch carries one.
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL && bar.t !== this.lastBarT) {
        this.closes.push(BigInt(bar.c));
        this.lastBarT = bar.t;
      }
    }
    if (this.closes.length === 0) return [];

    const barIndex = this.closes.length - 1;
    const close = this.closes[barIndex]!;
    const held = state.positions.get(SYMBOL);
    const qty = held === undefined ? 0n : held.qty;

    if (qty > 0n) return this.managePosition(qty, barIndex, close);
    // Flat: notice an exit that just landed and start the cooldown.
    if (this.wasInPosition) {
      this.wasInPosition = false;
      this.entryBar = null;
      this.coolUntil = barIndex + COOLDOWN;
    }
    return this.maybeEnter(state, barIndex, close);
  }

  private managePosition(qty: bigint, barIndex: number, close: bigint): OrderInput[] {
    this.wasInPosition = true;
    if (this.entryBar === null) {
      this.entryBar = barIndex;
      this.peak = close;
    }
    if (close > this.peak) this.peak = close;
    // Trailing stop: give back more than TRAIL_BPS from the peak, get out.
    if (close * BPS < this.peak * (BPS - TRAIL_BPS)) return [this.sell(qty)];
    // Time stop: a position that never ran is dead weight; free the cash.
    if (barIndex - this.entryBar >= TIME_STOP) return [this.sell(qty)];
    return [];
  }

  private maybeEnter(state: BarsState, barIndex: number, close: bigint): OrderInput[] {
    if (barIndex < DROP_BARS) return []; // not enough history for the washout context yet
    if (barIndex < this.coolUntil) return [];
    if (barIndex >= TOTAL_BARS - NO_ENTRY_TAIL) return []; // no room to run before the end
    if (state.cash <= 0n) return [];

    const window = this.closes.slice(-LOOKBACK);
    let priorHigh = window[0]!;
    for (let i = 1; i < window.length - 1; i++) if (window[i]! > priorHigh) priorHigh = window[i]!;
    let windowLow = window[0]!;
    for (const c of window) if (c < windowLow) windowLow = c;
    // 1. The range must be wide enough to be worth trading at all:
    //    (high - low) / low >= MIN_RANGE_BPS, in multiplications only.
    if ((priorHigh - windowLow) * BPS < MIN_RANGE_BPS * windowLow) return [];
    // 2. The close must break the prior window high with conviction.
    if (close * BPS < priorHigh * (BPS + BREAKOUT_BPS)) return [];
    // 3. Short-term momentum must be positive: no buying a dead bounce.
    if (close <= this.closes[this.closes.length - 1 - MOMENTUM_BARS]!) return [];
    // 4. Washout context: a sharp drop inside the last two hours, already
    //    partly recovered. This is what separates a recovery breakout from a
    //    breakout inside a slow grind down.
    const context = this.closes.slice(-DROP_BARS);
    let contextLow = context[0]!;
    for (const c of context) if (c < contextLow) contextLow = c;
    // (low - start) / start <= -DROP_BPS, i.e. the drop is at least DROP_BPS.
    if ((context[0]! - contextLow) * BPS < DROP_BPS * context[0]!) return [];
    // The close has reclaimed at least RECOVER_BPS off that low.
    if ((close - contextLow) * BPS < RECOVER_BPS * contextLow) return [];

    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIP_BPS }];
  }

  private sell(qty: bigint): OrderInput {
    return { side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIP_BPS };
  }
}

const bot = new RecoveryBreakout();
await runBars({ onBatch: (state, batch) => bot.onBatch(state, batch) });
