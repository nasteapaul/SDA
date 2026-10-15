// Markets the multi-market research covers: the exchange-local session each one is traded
// in, and IG's typical spread during that session (in price units of the history files).
// `history` names the folder in FutureSharks/financial-data (Oanda 1-minute bars, UTC) or
// HistData (DAX). Opening ranges start at `open`; positions are flat by `close`.
// Times are minutes after local midnight.
// `live` marks the markets the multi-market bot trades (bin/multibot.js): the IG epic on a
// spread-bet account, the CFD epics to try in order (smallest contract first) on a CFD
// account, and the opening-range settings. Chosen in the 2005-2020 research as the only ones positive
// both before and after 2013; the edge is small, so they run on demo as a forward test.

export const MARKETS = Object.freeze([
  { key: 'US500', name: 'US 500', history: 'oanda/SPX500_USD', tz: 'America/New_York', open: 570, close: 960, spread: 0.4 },
  { key: 'USTECH', name: 'US Tech 100', history: 'oanda/NAS100_USD', tz: 'America/New_York', open: 570, close: 960, spread: 1.0 },
  { key: 'US2000', name: 'US Russell 2000', history: 'oanda/US2000_USD', tz: 'America/New_York', open: 570, close: 960, spread: 0.4 },
  { key: 'UK100', name: 'FTSE 100', history: 'oanda/UK100_GBP', tz: 'Europe/London', open: 480, close: 990, spread: 1.0 },
  { key: 'FR40', name: 'France 40', history: 'oanda/FR40_EUR', tz: 'Europe/Paris', open: 540, close: 1050, spread: 1.0 },
  { key: 'NL25', name: 'Netherlands 25', history: 'oanda/NL25_EUR', tz: 'Europe/Amsterdam', open: 540, close: 1050, spread: 0.25 },
  { key: 'DE40', name: 'Germany 40', history: 'histdata/GRXEUR', tz: 'Europe/Berlin', open: 540, close: 1050, spread: 1.2 },
  { key: 'JP225', name: 'Japan 225', history: 'oanda/JP225_USD', tz: 'Asia/Tokyo', open: 540, close: 900, spread: 7 },
  { key: 'AU200', name: 'Australia 200', history: 'oanda/AU200_AUD', tz: 'Australia/Sydney', open: 600, close: 960, spread: 1.0, live: { epic: 'IX.D.ASX.MONTH1.IP', cfdEpics: ['IX.D.ASX.IFT.IP', 'IX.D.ASX.IFM.IP'], rangeMin: 60, targetR: 2 } },
  { key: 'GOLD', name: 'Spot Gold', history: 'oanda/XAU_USD', tz: 'America/New_York', open: 500, close: 960, spread: 0.3 },
  { key: 'OIL', name: 'US Crude', history: 'oanda/WTICO_USD', tz: 'America/New_York', open: 540, close: 870, spread: 0.028 },
  { key: 'NATGAS', name: 'Natural Gas', history: 'oanda/NATGAS_USD', tz: 'America/New_York', open: 540, close: 870, spread: 0.006 },
  { key: 'EURUSD', name: 'EUR/USD', history: 'oanda/EUR_USD', tz: 'Europe/London', open: 480, close: 960, spread: 0.00006, live: { epic: 'CS.D.EURUSD.TODAY.IP', cfdEpics: ['CS.D.EURUSD.MINI.IP'], rangeMin: 30, targetR: null } },
  { key: 'GBPUSD', name: 'GBP/USD', history: 'oanda/GBP_USD', tz: 'Europe/London', open: 480, close: 960, spread: 0.00009, live: { epic: 'CS.D.GBPUSD.TODAY.IP', cfdEpics: ['CS.D.GBPUSD.MINI.IP'], rangeMin: 60, targetR: 2 } },
  { key: 'EURJPY', name: 'EUR/JPY', history: 'oanda/EUR_JPY', tz: 'Europe/London', open: 480, close: 960, spread: 0.015 },
  { key: 'AUDUSD', name: 'AUD/USD', history: 'oanda/AUD_USD', tz: 'Asia/Tokyo', open: 540, close: 900, spread: 0.00006 },
  { key: 'USDCAD', name: 'USD/CAD', history: 'oanda/USD_CAD', tz: 'America/New_York', open: 480, close: 960, spread: 0.00013 },
]);

// Costs for lib/daytrade.js: the session spread applies all day (we only trade in session),
// plus half a spread of slippage on stops.
export const costsFor = (m) => ({ sessionSpread: m.spread, offSpread: m.spread, slippage: m.spread / 2 });

export const marketByKey = (key) => MARKETS.find((m) => m.key === key);

export const liveMarkets = () => MARKETS.filter((m) => m.live);
