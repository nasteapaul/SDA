// Tuning knobs in one place.
export const CONFIG = {
  alertScore: 5,          // send to Telegram at or above this score (after the AI adjustment)
  candidateScore: 3,      // rules score needed before spending a price lookup / AI call
  minDollarVolume: 1e6,   // average daily traded value, USD; below this XTB rarely lists it
  minPriceUsd: 1,         // penny stocks are where pump-and-dumps live
  maxAiCalls: 10,         // per run; GitHub Models' free tier is rate limited
  maxAiPerDay: 120,       // the free tier allows about 150 calls a day
  rippleEveryMin: 45,     // how often the AI reads the queued headlines for knock-on effects
  rippleBatch: 40,        // headlines per AI call
  buzzEveryMin: 30,       // how often Reddit mention counts are checked
  buzzMinMentions: 30,    // mentions in 24h before a jump counts
  maxSecDocs: 30,         // 8-K documents fetched per run
  maxForm4: 150,          // Form 4 files fetched per run
  secPages: 2,            // pages of 100 filings read from each SEC feed per run
  repeatAfterDays: 3,     // don't alert the same stock again sooner than this
  feedFailWarn: 60,       // consecutive failed checks (~2 hours, i.e. also after a move to another server) before a feed is reported
};
