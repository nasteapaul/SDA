// Fills a data file with ~4 months of realistic demo transactions so you can
// explore the app before linking your bank.
//   DATA_DIR=demo-data node scripts/seed-demo.js && DATA_DIR=demo-data npm start
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../lib/store.js';
import { categorize } from '../public/js/shared/categories.js';
import { addMonths, monthKey, todayISO, uid, round2 } from '../public/js/shared/money.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = path.resolve(ROOT, process.env.DATA_DIR || 'demo-data');
const store = await new Store(path.join(dir, 'budget.json')).load();

let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const between = (a, b) => round2(a + rnd() * (b - a));

const today = todayISO();
const current = monthKey(today);
const txs = [];
const add = (date, type, amount, description) => {
  if (date > today) return;
  const now = new Date().toISOString();
  txs.push({ id: uid(), type, amount: round2(amount), description, category: categorize({ description, type }, [], store.get().categories), date, note: '', source: 'bank', createdAt: now, updatedAt: now });
};

for (let i = -4; i <= 0; i += 1) {
  const m = addMonths(current, i);
  const d = (day) => `${m}-${String(day).padStart(2, '0')}`;
  add(d(1), 'income', 7850, 'SALARIU ACME SOFTWARE SRL');
  if (i % 2 === 0) add(d(18), 'income', between(600, 1400), 'Incasare factura emisa freelance');
  add(d(3), 'expense', 2300, 'Chirie apartament');
  add(d(9), 'expense', between(180, 320), 'ENEL ENERGIE MUNTENIA');
  add(d(9), 'expense', between(60, 140), 'ENGIE ROMANIA gaz');
  add(d(12), 'expense', 52, 'DIGI ROMANIA');
  add(d(14), 'expense', 350, 'Asociatia de proprietari intretinere');
  add(d(5), 'expense', 55.99, 'NETFLIX.COM');
  add(d(7), 'expense', 26.99, 'SPOTIFY');
  add(d(20), 'expense', 99, 'WORLD CLASS abonament');
  for (let k = 0; k < 9; k += 1) add(d(1 + Math.floor(rnd() * 28)), 'expense', between(60, 420), `PLATA LA POS ${pick(['KAUFLAND', 'LIDL', 'MEGA IMAGE', 'PROFI', 'CARREFOUR'])}`);
  for (let k = 0; k < 11 + (i === -1 ? 6 : 0); k += 1) add(d(1 + Math.floor(rnd() * 28)), 'expense', between(28, 95), pick(['GLOVO*FOOD', 'TAZZ', 'BOLT FOOD', 'STARBUCKS', '5 TO GO']));
  for (let k = 0; k < 6; k += 1) add(d(1 + Math.floor(rnd() * 28)), 'expense', between(12, 48), pick(['BOLT.EU RIDE', 'UBER TRIP', 'METROREX']));
  add(d(16), 'expense', between(250, 330), 'OMV PETROM benzinarie');
  for (let k = 0; k < 3; k += 1) add(d(1 + Math.floor(rnd() * 28)), 'expense', between(80, 650), pick(['EMAG.RO', 'ZARA', 'DECATHLON', 'H&M', 'ALTEX']));
  if (rnd() > 0.4) add(d(22), 'expense', between(60, 180), pick(['CINEMA CITY', 'IABILET concert']));
  if (rnd() > 0.5) add(d(25), 'expense', between(40, 160), 'FARMACIA CATENA');
  add(d(26), 'expense', 500, 'Transfer intre conturi proprii');
}

await store.mutate((s) => {
  s.transactions = txs;
  s.goals = [
    { id: uid(), name: 'Emergency fund', icon: '🛡️', target: 15000, initialSaved: 4200, deadline: null, priority: 'high', createdAt: today, updatedAt: today },
    { id: uid(), name: 'Summer in Greece', icon: '🏖️', target: 6000, initialSaved: 800, deadline: `${addMonths(current, 9)}-01`, priority: 'medium', createdAt: today, updatedAt: today },
    { id: uid(), name: 'New laptop', icon: '💻', target: 7500, initialSaved: 0, deadline: `${addMonths(current, 5)}-15`, priority: 'low', createdAt: today, updatedAt: today },
  ];
});
console.log(`Seeded ${txs.length} demo transactions and 3 goals into ${dir}`);
