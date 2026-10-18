// The Magistrala map: real city coordinates projected onto the board, the route network,
// and the geography used for decoration (outline, Carpathians, Danube, Black Sea coast).

const LON0 = 25.0;
const LAT0 = 45.95;
const SCALE = 3.2;
const LON_K = Math.cos((46 * Math.PI) / 180);

/** lon/lat -> board units (x to the east, z to the south). */
export function project(lon, lat) {
  return { x: (lon - LON0) * LON_K * SCALE, z: (LAT0 - lat) * SCALE };
}

const RAW_CITIES = {
  TM: ['Timișoara', 21.23, 45.75],
  AR: ['Arad', 21.31, 46.17],
  OR: ['Oradea', 21.92, 47.07],
  BM: ['Baia Mare', 23.58, 47.66],
  CJ: ['Cluj-Napoca', 23.6, 46.77],
  BN: ['Bistrița', 24.5, 47.13],
  SV: ['Suceava', 26.25, 47.65],
  IS: ['Iași', 27.59, 47.16],
  PN: ['Piatra Neamț', 26.38, 46.93],
  BC: ['Bacău', 26.91, 46.57],
  MS: ['Târgu Mureș', 24.56, 46.54],
  AB: ['Alba Iulia', 23.58, 46.07],
  DV: ['Deva', 22.9, 45.88],
  SB: ['Sibiu', 24.15, 45.79],
  BV: ['Brașov', 25.59, 45.65],
  DT: ['Drobeta', 22.66, 44.63],
  CV: ['Craiova', 23.8, 44.32],
  VL: ['Râmnicu Vâlcea', 24.37, 45.1],
  PT: ['Pitești', 24.87, 44.86],
  B: ['București', 26.1, 44.43],
  PH: ['Ploiești', 26.02, 44.94],
  BZ: ['Buzău', 26.82, 45.15],
  FC: ['Focșani', 27.18, 45.7],
  GL: ['Galați', 28.01, 45.43],
  CT: ['Constanța', 28.63, 44.17],
  TL: ['Tulcea', 28.8, 45.18],
};

export const CITIES = Object.fromEntries(
  Object.entries(RAW_CITIES).map(([id, [name, lon, lat]]) => [id, { id, name, lon, lat, ...project(lon, lat) }]),
);
export const CITY_IDS = Object.keys(CITIES);

export const COLORS = ['rosu', 'albastru', 'verde', 'galben', 'negru', 'alb'];
export const WILD = 'loco';

// [from, to, length, color]; 'gri' routes take any single color.
const RAW_ROUTES = [
  ['TM', 'AR', 1, 'gri'], ['AR', 'OR', 2, 'rosu'], ['TM', 'DV', 2, 'albastru'], ['AR', 'DV', 2, 'verde'],
  ['OR', 'CJ', 3, 'galben'], ['OR', 'BM', 3, 'negru'], ['BM', 'CJ', 2, 'alb'], ['BM', 'BN', 3, 'gri'],
  ['CJ', 'BN', 2, 'rosu'], ['CJ', 'AB', 2, 'negru'], ['CJ', 'MS', 2, 'albastru'], ['BN', 'SV', 4, 'verde'],
  ['BN', 'MS', 2, 'galben'], ['SV', 'IS', 3, 'alb'], ['SV', 'PN', 2, 'albastru'], ['IS', 'BC', 3, 'negru'],
  ['PN', 'BC', 1, 'gri'], ['PN', 'MS', 4, 'alb'], ['MS', 'SB', 3, 'verde'], ['MS', 'BV', 3, 'rosu'],
  ['AB', 'DV', 1, 'galben'], ['AB', 'SB', 2, 'alb'], ['TM', 'DT', 3, 'verde'], ['DV', 'DT', 4, 'negru'],
  ['DT', 'CV', 2, 'rosu'], ['SB', 'BV', 3, 'albastru'], ['SB', 'VL', 2, 'negru'], ['VL', 'PT', 1, 'gri'],
  ['VL', 'CV', 2, 'galben'], ['CV', 'PT', 3, 'alb'], ['CV', 'B', 4, 'albastru'], ['PT', 'B', 2, 'verde'],
  ['BV', 'PH', 2, 'galben'], ['PH', 'B', 1, 'rosu'], ['BV', 'BC', 4, 'gri'], ['BV', 'BZ', 3, 'alb'],
  ['PH', 'BZ', 2, 'negru'], ['BC', 'FC', 2, 'verde'], ['IS', 'GL', 4, 'galben'], ['FC', 'BZ', 1, 'albastru'],
  ['FC', 'GL', 2, 'rosu'], ['B', 'BZ', 3, 'gri'], ['GL', 'TL', 2, 'alb'], ['B', 'CT', 4, 'rosu'],
  ['TL', 'CT', 3, 'verde'], ['GL', 'B', 4, 'negru'],
];

export const ROUTES = RAW_ROUTES.map(([a, b, len, color], id) => ({ id, a, b, len, color }));

export const ROUTE_POINTS = { 1: 1, 2: 2, 3: 4, 4: 7 };

// ---------------------------------------------------------------- tickets

function shortestLengths(from) {
  const dist = Object.fromEntries(CITY_IDS.map((c) => [c, Infinity]));
  dist[from] = 0;
  const todo = new Set(CITY_IDS);
  while (todo.size) {
    let cur = null;
    for (const c of todo) if (cur === null || dist[c] < dist[cur]) cur = c;
    todo.delete(cur);
    for (const r of ROUTES) {
      const other = r.a === cur ? r.b : r.b === cur ? r.a : null;
      if (other && dist[cur] + r.len < dist[other]) dist[other] = dist[cur] + r.len;
    }
  }
  return dist;
}

export const DISTANCES = Object.fromEntries(CITY_IDS.map((c) => [c, shortestLengths(c)]));

// A fixed, hand-balanced spread of destination tickets (value = shortest path length).
const TICKET_PAIRS = [
  ['TM', 'CJ'], ['AR', 'SB'], ['OR', 'BV'], ['BM', 'IS'], ['CJ', 'B'], ['BN', 'BC'], ['SV', 'BV'],
  ['IS', 'B'], ['PN', 'GL'], ['MS', 'CV'], ['AB', 'PT'], ['DV', 'B'], ['SB', 'CT'], ['BV', 'CT'],
  ['DT', 'SB'], ['CV', 'PH'], ['VL', 'BZ'], ['TM', 'CV'], ['OR', 'SV'], ['AR', 'B'], ['BM', 'MS'],
  ['CJ', 'GL'], ['SV', 'TL'], ['IS', 'BV'], ['BC', 'B'], ['DT', 'PT'], ['TM', 'BV'], ['AB', 'FC'],
  ['MS', 'CT'], ['PH', 'TL'], ['OR', 'DT'], ['CV', 'GL'],
];
export const TICKETS = TICKET_PAIRS.map(([a, b], id) => ({ id, a, b, value: DISTANCES[a][b] }));

// Long-haul state contracts, won in the secret auction. Bonus only, never a penalty.
const CONTRACT_PAIRS = [['TM', 'CT'], ['OR', 'B'], ['SV', 'CV'], ['BM', 'TL'], ['DT', 'IS'], ['AR', 'GL']];
export const CONTRACTS = CONTRACT_PAIRS.map(([a, b], id) => ({ id: 100 + id, a, b, value: DISTANCES[a][b] + 4, contract: true }));

// ---------------------------------------------------------------- geography for the 3D board

const ll = (pts) => pts.map(([lon, lat]) => project(lon, lat));

export const OUTLINE = ll([
  [20.3, 46.1], [21.0, 46.6], [21.5, 47.4], [22.1, 47.8], [22.9, 48.0], [24.0, 47.95], [24.9, 47.75], [26.0, 48.1],
  [26.6, 48.25], [27.3, 47.8], [28.0, 47.1], [28.2, 46.6], [28.1, 46.0], [28.2, 45.45], [28.8, 45.25], [29.7, 45.2],
  [29.6, 44.8], [28.9, 44.4], [28.6, 43.75], [27.9, 43.95], [27.0, 44.15], [26.1, 43.98], [25.3, 43.65], [24.1, 43.7],
  [23.0, 43.8], [22.5, 44.2], [22.7, 44.55], [21.9, 44.65], [21.4, 44.9], [21.4, 45.2], [20.7, 45.6],
]);

export const CARPATHIANS = ll([
  [24.6, 47.75], [25.1, 47.45], [25.6, 47.15], [25.9, 46.8], [26.05, 46.45], [26.15, 46.1], [26.1, 45.75],
  [25.75, 45.45], [25.3, 45.4], [24.8, 45.42], [24.3, 45.45], [23.7, 45.38], [23.2, 45.3], [22.75, 45.15],
  [22.35, 45.0], [22.6, 46.45], [22.95, 46.55], [22.8, 46.75], [23.15, 46.35],
]);

export const DANUBE = ll([
  [21.35, 44.85], [21.9, 44.68], [22.45, 44.5], [22.65, 44.25], [22.95, 43.9], [23.6, 43.78], [24.1, 43.72],
  [24.8, 43.7], [25.3, 43.68], [25.8, 43.85], [26.1, 44.0], [26.7, 44.08], [27.3, 44.12], [27.9, 44.05],
  [28.0, 44.45], [27.95, 44.9], [28.05, 45.25], [28.3, 45.35], [28.7, 45.25], [29.1, 45.2], [29.6, 45.17],
]);

/** Black Sea, as a polygon from the coast out to the board edge. */
export const SEA = ll([
  [29.7, 45.2], [29.6, 44.8], [28.9, 44.4], [28.6, 43.75], [28.55, 43.4], [31.0, 43.4], [31.0, 46.2], [30.2, 46.2],
  [29.9, 45.6],
]);
