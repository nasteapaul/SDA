// Default categories and keyword rules tuned for Romanian banks and merchants.
// `essential` drives the planner: essential spending is never proposed for cuts.
// `role` marks special categories:
//   - "savings"  money moved to a goal; reduces the balance but is not "spending"
//   - "transfer" moves between your own accounts; ignored by every statistic

export const DEFAULT_CATEGORIES = [
  { name: 'Housing', kind: 'expense', icon: '🏠', essential: true },
  { name: 'Utilities', kind: 'expense', icon: '💡', essential: true },
  { name: 'Groceries', kind: 'expense', icon: '🛒', essential: true },
  { name: 'Transport', kind: 'expense', icon: '🚗', essential: true },
  { name: 'Health', kind: 'expense', icon: '💊', essential: true },
  { name: 'Education', kind: 'expense', icon: '📚', essential: true },
  { name: 'Eating out', kind: 'expense', icon: '🍕', essential: false },
  { name: 'Shopping', kind: 'expense', icon: '🛍️', essential: false },
  { name: 'Entertainment', kind: 'expense', icon: '🎬', essential: false },
  { name: 'Subscriptions', kind: 'expense', icon: '📺', essential: false },
  { name: 'Travel', kind: 'expense', icon: '✈️', essential: false },
  { name: 'Personal care', kind: 'expense', icon: '💇', essential: false },
  { name: 'Gifts', kind: 'expense', icon: '🎁', essential: false },
  { name: 'Cash', kind: 'expense', icon: '💵', essential: false },
  { name: 'Sent to people', kind: 'expense', icon: '👥', essential: false },
  { name: 'Credit card repayment', kind: 'expense', icon: '💳', essential: true, role: 'repayment' },
  { name: 'Interest & fees', kind: 'expense', icon: '🏦', essential: true },
  { name: 'Other', kind: 'expense', icon: '📦', essential: false },
  { name: 'Savings', kind: 'both', icon: '🐷', essential: false, role: 'savings' },
  { name: 'Salary', kind: 'income', icon: '💼' },
  { name: 'Extra income', kind: 'income', icon: '🧾' },
  { name: 'Refunds', kind: 'income', icon: '↩️' },
  { name: 'Other income', kind: 'income', icon: '💰' },
  { name: 'Transfers', kind: 'both', icon: '🔁', role: 'transfer' },
];

export const FALLBACK_EXPENSE = 'Other';
export const FALLBACK_INCOME = 'Other income';
export const SAVINGS_CATEGORY = 'Savings';

// Ordered: first match wins. Patterns are matched against a normalised
// (lowercase, no diacritics) description + counterparty name.
export const DEFAULT_RULES = [
  // Paying off the credit card from the current account (the card side of it is a transfer)
  { pattern: 'alimentare card( de)? credit|plata card( de)? credit|rambursare (rata )?card|credit card (re)?payment', category: 'Credit card repayment', kind: 'expense' },
  // Transfers between own accounts / to savings deposits
  { pattern: 'transfer intre conturi proprii|transfer propriu|own account|depozit|economisire|round up|roundup|rambursare (rata )?card|card de credit|plata card credit|credit card (re)?payment|depunere numerar|cash deposit|transfer fonduri|revolut\\*|trimis prin revolut|top.?up', category: 'Transfers' },
  // Income
  { pattern: 'salariu|salary|payroll|drepturi salariale|avans salariu|lichidare|chenzina', category: 'Salary', kind: 'income' },
  { pattern: 'refund|rambursare|retur|storno|cashback', category: 'Refunds', kind: 'income' },
  { pattern: 'dividend|dobanda|interest|bonus|\\bprima\\b|factura emisa', category: 'Extra income', kind: 'income' },
  // What the bank charges: card/overdraft interest, fees and commissions (money in "dobanda" stays income above)
  { pattern: 'dobanda debitoare|dobanda (la )?card|dobanzi|interest charge|comision|taxa (anuala|administrare|lunara)|annual fee|bank fee', category: 'Interest & fees', kind: 'expense' },
  // Groceries
  { pattern: 'kaufland|lidl|mega image|carrefour|\\bprofi\\b|auchan|\\bpenny\\b|\\bcora\\b|selgros|\\bmetro\\b|la doi pasi|annabella|freshful|sezamo|bringo', category: 'Groceries' },
  // Eating out & delivery
  { pattern: 'glovo|tazz|bolt food|foodpanda|mcdonald|kfc|burger king|starbucks|5 to go|tucano|restaurant|pizza|bistro|cafenea|coffee|cafe|shaorma|salad box|spartan|gelat|cofetari|patiser|food|sandwich|kebab|burger', category: 'Eating out' },
  // Transport
  { pattern: '\\bomv\\b|petrom|rompetrol|\\bmol\\b|lukoil|socar|gazprom|benzinarie|\\buber\\b|\\bbolt\\b|\\bstb\\b|metrorex|ratb|\\bctp\\b|\\bcfr\\b|parcare|parking|rovinieta|vigneta|\\bitp\\b|service auto|autonet|tpark', category: 'Transport' },
  // Utilities & telecom
  { pattern: '\\benel\\b|\\be\\.?on\\b|engie|electrica|hidroelectrica|\\bppc\\b|apa nova|apavital|aquatim|compania de apa|\\bdigi\\b|\\brcs\\b|\\brds\\b|orange|vodafone|telekom|\\bupc\\b|termoenergetica|radet|asociatia de proprietari|intretinere', category: 'Utilities' },
  // Housing
  { pattern: 'chirie|\\brent\\b|rata credit|rata ipotecar|ipoteca|imobiliar|ikea|dedeman|leroy merlin|hornbach|brico', category: 'Housing' },
  // Health
  { pattern: 'catena|dr\\.? ?max|help net|sensiblu|farmacia|farmacie|farmaciile tei|regina maria|medlife|sanador|synevo|bioclinica|stomatolog|dentist|clinica|spital', category: 'Health' },
  // Subscriptions
  { pattern: 'netflix|spotify|hbo|max\\.com|disney|youtube|apple\\.com|icloud|google \\*|google one|amazon prime|voyo|antena play|chatgpt|openai|claude|anthropic|microsoft|adobe|playstation|xbox|steam', category: 'Subscriptions' },
  // Shopping
  { pattern: 'emag|altex|flanco|media galaxy|zara|h&m|h & m|reserved|decathlon|about you|answear|fashion days|aliexpress|temu|shein|amazon|pepco|jysk|noriel|libris|carturesti|elefant|douglas|notino|sephora', category: 'Shopping' },
  // Entertainment
  { pattern: 'cinema|cinema city|happy cinema|bilet|iabilet|eventim|entertix|teatru|concert|bowling|escape|netopia.*bilet', category: 'Entertainment' },
  // Travel
  { pattern: 'booking\\.com|airbnb|wizz|ryanair|tarom|blue air|hotel|pensiune|travel|vola\\.ro|esky', category: 'Travel' },
  // Personal care
  { pattern: 'frizerie|coafor|salon|barber|cosmetic|manichiura|world class|7card|gym|fitness|stay fit', category: 'Personal care' },
  // Education
  { pattern: 'udemy|coursera|scoala|gradinita|universitate|taxa scolar|meditatii|curs ', category: 'Education' },
  // Money sent to other people (own accounts are caught earlier as Transfers)
  { pattern: "transfer home.?bank|plata instant|instant payment|transfer catre|sent to", category: 'Sent to people', kind: 'expense' },
  // Cash
  { pattern: 'retragere numerar|cash withdrawal|\\batm\\b|bancomat', category: 'Cash' },
];

export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const regexCache = new Map();
function toRegex(pattern) {
  if (!regexCache.has(pattern)) {
    let re;
    try { re = new RegExp(pattern, 'i'); } catch { re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
    regexCache.set(pattern, re);
  }
  return regexCache.get(pattern);
}

/**
 * The rule that categorises a transaction: { category, rule, source }.
 * source: 'user' (one of your rules), 'builtin' (DEFAULT_RULES) or 'fallback'
 * (nothing matched; rule is null). userRules come first (they are learnt
 * from your own edits), then defaults.
 */
export function matchRule({ description = '', counterparty = '', type = 'expense' } = {}, userRules = [], categories = DEFAULT_CATEGORIES) {
  const text = normalize(`${description} ${counterparty}`);
  const known = new Set(categories.map((c) => c.name));
  const users = Array.isArray(userRules) ? userRules : [];
  const all = [...users, ...DEFAULT_RULES];
  let words = null; // keyText, worked out only when a rule of yours needs it
  for (let i = 0; i < all.length; i += 1) {
    const rule = all[i];
    if (!rule?.pattern || !known.has(rule.category)) continue;
    if (rule.kind && rule.kind !== type) continue;
    const cat = categories.find((c) => c.name === rule.category);
    if (cat && cat.kind !== 'both' && cat.kind !== type) continue;
    const re = toRegex(rule.pattern);
    // Your rules are usually a merchant key ("revolut dublin"): also try the words it was made from.
    const hit = re.test(text) || (i < users.length && re.test(words === null ? (words = keyText(`${description} ${counterparty}`)) : words));
    if (hit) return { category: rule.category, rule, source: i < users.length ? 'user' : 'builtin' };
  }
  return { category: type === 'income' ? FALLBACK_INCOME : FALLBACK_EXPENSE, rule: null, source: 'fallback' };
}

/** Pick a category for a transaction (see matchRule). */
export function categorize(tx, userRules = [], categories = DEFAULT_CATEGORIES) {
  return matchRule(tx, userRules, categories).category;
}

// Bank boilerplate that is never part of a merchant's name.
const NOISE = new Set(`
  plata cumparare pos card nr numar tranzactie tranzactia comerciant la in ref referinta ro data finalizarii decontarii
  autorizare autorizarii suma valoare detalii number transaction transactions at authorization authorisation date
  payment purchase contactless online terminal id the of to from
  incasare home bank homebank titular ordonator beneficiar contul din catre detalii depunere transfer dl dna
  bucuresti sector cluj napoca iasi timisoara constanta brasov
`.trim().split(/\s+/));

// Pulls the merchant out of statement text such as
//   "Card number, **** 7204, Transaction at, CARREFOUR EXPRESS BAILE, Authorization date, ..."
//   "Cumparare POS ... Tranzactie la:NETFLIX INTERNATIONAL B.V NL Amsterdam"
export function extractMerchant(text) {
  const s = String(text ?? '');
  const m = s.match(/transaction at,?\s*([^,;]+)/i)
    || s.match(/(?:ordering party|beneficiary|ordonator|beneficiar)\s*[:,]\s*([^,;]+)/i)
    || s.match(/tranzac[tț]i[ea] la:?\s*([^,;]+)/i)
    || s.match(/comerciant:?\s*([^,;]+)/i)
    || s.match(/(?:plata|cumparare) (?:la )?pos\s+([^,;]+)/i);
  const name = (m ? m[1] : s).replace(/\*+\s*\d+/g, ' ').replace(/\s+/g, ' ').trim();
  return name.slice(0, 80);
}

// Short, stable key for a merchant ("carrefour express"), used to suggest
// rules and to detect recurring payments.
export function merchantKey(description) {
  const words = normalize(extractMerchant(description))
    .replace(/[^a-z& ]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 2 && !NOISE.has(w));
  return words.slice(0, 2).join(' ');
}

// A keyword that is only bank boilerplate would match almost everything.
export function isUselessKeyword(keyword) {
  const words = normalize(keyword).replace(/\\/g, '').split(/[^a-z]+/).filter(Boolean);
  return !words.length || words.every((w) => NOISE.has(w));
}

export function ruleText(t) {
  return normalize(`${t.description || ''} ${t.note || ''}`);
}

export function ruleMatches(rule, t) {
  if (!rule?.pattern) return false;
  const re = toRegex(rule.pattern);
  return re.test(ruleText(t)) || re.test(keyText(`${t.description || ''} ${t.note || ''}`));
}

/**
 * The words a merchant key is made of (see merchantKey): letters only, bank
 * boilerplate left out. "Revolut**1234* Dublin" → "revolut dublin", so a rule
 * learnt from a merchant key matches the bank text it came from.
 */
export function keyText(text) {
  return normalize(text).replace(/[^a-z& ]+/g, ' ').split(' ').filter((w) => w.length > 2 && !NOISE.has(w)).join(' ');
}

export function escapeForRule(text) {
  return normalize(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
