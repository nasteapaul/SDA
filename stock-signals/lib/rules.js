// Rule-based first pass. Cheap and transparent: every point comes with a reason.
// The AI only adjusts candidates that already pass these rules.

export const GIANTS = [
  'Apple', 'Microsoft', 'NVIDIA', 'Amazon', 'AWS', 'Google', 'Alphabet', 'Meta Platforms', 'Tesla',
  'OpenAI', 'Anthropic', 'Samsung', 'TSMC', 'Intel', 'AMD', 'Oracle', 'IBM', 'Salesforce', 'Broadcom',
  'Pfizer', 'Novartis', 'Roche', 'Johnson & Johnson', 'Merck', 'Eli Lilly', 'AstraZeneca', 'Novo Nordisk',
  'Siemens', 'Airbus', 'Boeing', 'Lockheed Martin', 'Walmart', 'SpaceX', 'Department of Defense', 'Pentagon', 'NASA',
];
const giantRe = new RegExp(`\\b(${GIANTS.map((g) => g.replace(/[.*+?^${}()|[\]\\&]/g, '\\$&')).join('|')})\\b`);

const RULES = [
  // Before a takeover: the price usually jumps on these, well before a deal is signed.
  [4, /\b(explor\w*|evaluat\w*|review\w*|initiat\w*|commenc\w*|launch\w*|conduct\w*) (of )?(a (broad |formal |comprehensive )?(range of |process to (explore|evaluate|review) )?)?(potential |possible )?(strategic (alternatives|options)|(a )?(potential |possible )?sale of the company)\b|\bformal sale process\b/i, 'își caută cumpărător (alternative strategice)'],
  [4, /\b(unsolicited|non-binding|nonbinding|indicative) (and non-binding )?(acquisition |takeover |buyout |merger )?(proposal|offer|indication of interest)\b|\breceived (an? )?(\w+ )?(proposal|offer) to acquire\b/i, 'a primit o ofertă de cumpărare, încă nesemnată'],
  [3, /\b(in (advanced |early |exclusive )?talks to (be acquired|sell itself|merge)|(explores?|exploring|weighs?|weighing|considers?|considering) (a )?(potential )?sale\b|attract\w* takeover interest)/i, 'zvon de vânzare a firmei'],
  // After a signed deal the price is pinned to the offer: nothing left to gain.
  [-6, /\b(to be acquired by|definitive (merger )?agreement (to be acquired|under which .{0,80} will acquire)|agreed to be acquired|enter(s|ed)? into (a )?definitive (merger )?agreement|tender offer for all)\b/i, 'preluare deja semnată: prețul e fixat de ofertă'],
  [3, /\b(raises?|raising|increases?|lifts?) (its )?(full[- ]year |annual |fiscal( year)? \d{0,4} ?)?(guidance|outlook|forecast)\b/i, 'își ridică estimările'],
  [3, /\bFDA (approval|approves|approved|grants? (accelerated )?approval)\b|\b(EMA|CHMP) (positive opinion|recommends approval)\b/i, 'aprobare de medicament'],
  [2, /\b(awarded|wins?|won|secures?|secured|selected for) (a |an )?(\$?[\d.,]+ ?(million|billion|mn|bn|m|b) )?(multi-year )?(contract|order|award|deal)\b/i, 'contract nou'],
  [2, /\b(record (quarterly |annual )?(revenue|sales|earnings|profit))\b/i, 'venituri record'],
  [2, /\b(beats?|exceeds?|tops?|above) (analyst |consensus |wall street )?(estimates|expectations|consensus)\b/i, 'rezultate peste așteptări'],
  [1, /\b(strategic partnership|collaboration agreement|partnership agreement|joint venture|license agreement|supply agreement)\b/i, 'parteneriat'],
  [1, /\b(share (re)?purchase|buyback) (program|authori[sz]ation)\b/i, 'răscumpărare de acțiuni'],
  [1, /\b(phase (2|3|ii|iii)) (trial )?(met|achieved|positive|successful)/i, 'studiu clinic reușit'],
  [-3, /\b(proposed|pricing of|priced|announces) (an? )?(underwritten |registered direct |public )?(offering|placement)\b|\bat[- ]the[- ]market (offering|program)\b/i, 'emite acțiuni noi (diluare)'],
  [-4, /\b(going concern|chapter 11|bankruptcy|insolvency|delisting notice|notice of delisting)\b/i, 'risc de faliment sau delistare'],
  [-3, /\b(lowers?|cuts?|reduces?|withdraws?) (its )?(full[- ]year |annual )?(guidance|outlook|forecast)\b/i, 'își scade estimările'],
  [-2, /\b(reverse (stock )?split|class action|SEC investigation|subpoena|recall)\b/i, 'risc juridic sau reverse split'],
  [-2, /\b(complete response letter|clinical hold|did not meet|failed to meet)\b/i, 'eșec de reglementare sau studiu'],
];

// 8-K items (SEC form numbering).
const ITEMS = {
  '1.01': [1, 'raport SEC: acord important semnat'],
  '2.01': [1, 'raport SEC: achiziție finalizată'],
  '1.03': [-5, 'raport SEC: faliment'],
  '3.01': [-3, 'raport SEC: risc de delistare'],
  '4.02': [-3, 'raport SEC: rapoarte financiare retrase'],
  '3.02': [-1, 'raport SEC: acțiuni noi emise'],
};

export function scoreText(text, items = []) {
  let score = 0;
  const reasons = [];
  for (const [pts, re, why] of RULES) {
    if (re.test(text)) { score += pts; reasons.push(why); }
  }
  const giant = giantRe.exec(text)?.[1];
  // A giant counts only alongside a deal word; just being mentioned means nothing.
  if (giant && reasons.some((r) => /contract|parteneriat/.test(r))) {
    score += 2;
    reasons.push(`partener mare: ${giant}`);
  }
  for (const it of items) {
    const rule = ITEMS[it];
    if (rule) { score += rule[0]; reasons.push(rule[1]); }
  }
  return { score, reasons };
}

// Open-market buying by insiders with their own money, summed over the last 30 days.
// Studies of Form 4 buys (e.g. arXiv 2602.06198) find the strongest follow-through when
// several insiders buy, when the CFO buys and when it is an insider's first position or a
// big addition; buys by 10% holders who don't run the company show no edge, so they're dropped.
export function scoreInsiders(all) {
  const buys = all.filter((b) => !b.tenPctOnly);
  const owners = new Set(buys.map((b) => b.owner));
  const total = buys.reduce((s, b) => s + b.value, 0);
  const boss = buys.some((b) => /chief executive|ceo|chief financial|cfo|chair/i.test(b.title) && b.value >= 250e3);
  let score = 0;
  const reasons = [];
  if (owners.size >= 2 && total >= 100e3) { score += 3; reasons.push(`${owners.size} directori au cumpărat acțiuni cu banii lor`); }
  if (boss) { score += 2; reasons.push('CEO/CFO a cumpărat peste 250.000 $'); }
  if (total >= 1e6) { score += 1; reasons.push('cumpărări de insideri peste 1 mil. $'); }
  if (score > 0 || owners.size >= 2) {
    // Only as extra weight: on its own a single small buy still means little.
    if (buys.some((b) => /chief financial|\bcfo\b/i.test(b.title) && b.value >= 50e3)) { score += 1; reasons.push('directorul financiar (CFO) a cumpărat'); }
    const first = buys.find((b) => b.shares > 0 && b.after > 0 && b.shares / b.after >= 0.9);
    const bigger = buys.find((b) => b.shares > 0 && b.after > b.shares && b.shares / (b.after - b.shares) >= 0.5);
    if (first) { score += 1; reasons.push(`${first.owner} își cumpără primele acțiuni în firmă`); }
    else if (bigger) { score += 1; reasons.push(`${bigger.owner} și-a mărit pachetul cu peste 50%`); }
  }
  return { score, reasons, total, owners: owners.size };
}

// Schedule 13D: someone bought more than 5% and means to influence the company (passive
// holders file 13G instead). Known activists often push for a sale.
export const ACTIVISTS = [
  'Elliott', 'Starboard', 'Icahn', 'Trian', 'JANA', 'ValueAct', 'Third Point', 'Pershing Square', 'Engaged Capital',
  'Land & Buildings', 'Ancora', 'Legion Partners', 'Sachem Head', 'Corvex', 'Mantle Ridge', 'Politan', 'Irenic',
  'Barington', 'Impactive', 'Cevian', 'Blackwells', 'Kingstown', 'D. E. Shaw', 'Carlson Capital', 'Anson',
];
const activistRe = new RegExp(`\\b(${ACTIVISTS.map((a) => a.replace(/[.*+?^${}()|[\]\\&]/g, '\\$&')).join('|')})`, 'i');
const SALE_INTENT = /\b(sale of the (company|issuer)|strategic alternatives|(merger|acquisition|business combination) (of|with|involving) the issuer|acquire (all|the remaining)|take the (company|issuer) private|going[- ]private|board (representation|seats?|nominees?)|nominate)/i;

export function score13D(filer, text) {
  let score = 3;
  const reasons = ['a cumpărat peste 5% ca să influențeze firma (SEC 13D)'];
  const activist = activistRe.exec(`${filer} ${text.slice(0, 3000)}`)?.[1];
  if (activist) { score += 2; reasons.push(`investitor activist cunoscut: ${activist}`); }
  const intent = SALE_INTENT.exec(text)?.[1];
  if (intent) { score += 2; reasons.push(`scopul declarat: ${intent.toLowerCase()}`); }
  return { score, reasons };
}
