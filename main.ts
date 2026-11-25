// RQ-cross momentum bot for agent-fun/replay/v2 (pump.fun bonding curves).
// Run by the grader as `node /bot/main.ts`; the strategy lives in strategy.ts and
// the SDK shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
