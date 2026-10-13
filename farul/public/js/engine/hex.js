// Pointy-top hexes in "odd-r" offset layout; a tile is addressed by index r*cols+c.
const DIRS = [
  [[1, 0], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1]],
  [[1, 0], [1, -1], [0, -1], [-1, 0], [0, 1], [1, 1]],
];

export function neighbors(i, cols, rows) {
  const c = i % cols, r = (i / cols) | 0;
  const out = [];
  for (const [dc, dr] of DIRS[r & 1]) {
    const nc = c + dc, nr = r + dr;
    if (nc >= 0 && nc < cols && nr >= 0 && nr < rows) out.push(nr * cols + nc);
  }
  return out;
}

function cube(i, cols) {
  const c = i % cols, r = (i / cols) | 0;
  const q = c - (r - (r & 1)) / 2;
  return [q, r, -q - r];
}

export function distance(a, b, cols) {
  const [aq, ar, as] = cube(a, cols), [bq, br, bs] = cube(b, cols);
  return Math.max(Math.abs(aq - bq), Math.abs(ar - br), Math.abs(as - bs));
}

// Breadth-first search limited to maxDist steps over passable tiles.
export function reach(start, maxDist, passable, cols, rows) {
  const dist = new Map([[start, 0]]);
  const prev = new Map();
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift();
    const d = dist.get(cur);
    if (d >= maxDist) continue;
    for (const n of neighbors(cur, cols, rows)) {
      if (dist.has(n) || !passable(n)) continue;
      dist.set(n, d + 1);
      prev.set(n, cur);
      queue.push(n);
    }
  }
  return { dist, prev };
}

export function pathTo(prev, start, target) {
  const path = [target];
  let cur = target;
  while (cur !== start) {
    cur = prev.get(cur);
    if (cur === undefined) return null;
    path.push(cur);
  }
  return path.reverse();
}

export function hexCenter(i, cols, size) {
  const c = i % cols, r = (i / cols) | 0;
  return { x: size * Math.sqrt(3) * (c + 0.5 * (r & 1)), y: size * 1.5 * r };
}
