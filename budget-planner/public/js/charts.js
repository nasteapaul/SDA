// Small, dependency-free charts rendered as HTML/SVG strings.
// Single series → one colour (slot 1); text always uses ink tokens.

import { formatRON, monthLabel } from './shared/money.js';

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Horizontal bars of spending by category, sorted descending.
 * rows: [{ name, icon, value, count, limit? }]
 */
export function categoryBars(rows, total) {
  if (!rows.length) return '<div class="empty"><b>No spending yet</b>Add an expense or link your bank.</div>';
  const max = Math.max(...rows.map((r) => Math.max(r.value, r.limit || 0)));
  return `<div class="bars" role="list">${rows.map((r) => {
    const pct = max ? (r.value / max) * 100 : 0;
    const share = total ? Math.round((r.value / total) * 100) : 0;
    const over = r.limit && r.value > r.limit;
    const tip = `<b>${esc(r.name)}</b><br>${formatRON(r.value)} · ${share}% of spending<br>${r.count} transaction${r.count === 1 ? '' : 's'}${r.limit ? `<br>Budget ${formatRON(r.limit, { short: true })}${over ? ` — over by ${formatRON(r.value - r.limit, { short: true })}` : ` — ${formatRON(r.limit - r.value, { short: true })} left`}` : ''}`;
    return `<button class="bar-row" role="listitem" data-category="${esc(r.name)}" data-tip="${esc(tip)}" aria-label="${esc(`${r.name}: ${formatRON(r.value)}, ${share}% of spending${r.limit ? `, budget ${formatRON(r.limit)}` : ''}`)}">
      <span class="bar-name"><span aria-hidden="true">${esc(r.icon)}</span><span>${esc(r.name)}</span></span>
      <span class="bar-track">
        <span class="bar-fill" style="width:${pct.toFixed(2)}%"></span>
        ${r.limit ? `<span class="bar-limit" style="left:calc(${((r.limit / max) * 100).toFixed(2)}% - 1px)" title="Budget"></span>` : ''}
      </span>
      <span class="bar-value num">${formatRON(r.value, { short: true })}<small>${over ? `<span class="bar-over">▲ over budget</span>` : r.limit ? `of ${formatRON(r.limit, { short: true })}` : `${share}%`}</small></span>
    </button>`;
  }).join('')}</div>`;
}

/**
 * Grouped columns: income vs spending per month (one shared axis).
 * months: [{ key, income, spend, noData?, partial? }]
 * partial: the data starts part-way through that month — its bars are
 * hatched and lighter, and its label gets an asterisk.
 */
export function trendChart(months) {
  const W = 560; const H = 200; const padL = 44; const padB = 24; const padT = 8;
  const innerW = W - padL; const innerH = H - padB - padT;
  const max = Math.max(1, ...months.flatMap((m) => [m.income, m.spend]));
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const y = (v) => padT + innerH - (v / top) * innerH;
  const groupW = innerW / months.length;
  const barW = Math.min(22, (groupW - 14) / 2);

  let svg = months.some((m) => m.partial)
    ? `<defs>${[1, 2].map((n) => `<pattern id="hatch-${n}" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)"><rect width="6" height="6" fill="var(--series-${n})" fill-opacity=".28"/><rect width="2.5" height="6" fill="var(--series-${n})"/></pattern>`).join('')}</defs>`
    : '';
  for (let v = 0; v <= top + 0.001; v += step) {
    svg += `<line class="${v === 0 ? 'base-line' : 'grid-line'}" x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/>`;
    svg += `<text x="${padL - 8}" y="${y(v) + 4}" text-anchor="end">${shortNum(v)}</text>`;
  }
  months.forEach((m, i) => {
    const cx = padL + groupW * i + groupW / 2;
    const bars = m.partial
      ? [['income', m.income, 'url(#hatch-1)', cx - barW - 1], ['spend', m.spend, 'url(#hatch-2)', cx + 1]]
      : [['income', m.income, 'var(--series-1)', cx - barW - 1], ['spend', m.spend, 'var(--series-2)', cx + 1]];
    for (const [, v, color, x] of bars) {
      const h = Math.max(0, y(0) - y(v));
      if (h > 0) svg += `<path d="${roundedTop(x, y(v), barW, h, Math.min(4, h))}" fill="${color}"/>`;
    }
    svg += `<text x="${cx}" y="${H - 6}" text-anchor="middle">${esc(monthLabel(m.key, { month: 'short' }))}${m.partial ? '*' : ''}</text>`;
    if (m.noData) svg += `<text x="${cx}" y="${y(0) - 8}" text-anchor="middle">no data</text>`;
    const net = m.income - m.spend;
    const tip = `<b>${esc(monthLabel(m.key, { month: 'long', year: 'numeric' }))}</b><br>Income ${formatRON(m.income)}<br>Spending ${formatRON(m.spend)}<br>Net ${formatRON(net, { sign: true })}${m.partial ? '<br><i>* Partial: your data starts part-way through this month</i>' : ''}`;
    svg += `<rect class="hit" x="${padL + groupW * i}" y="${padT}" width="${groupW}" height="${innerH}" data-tip="${esc(tip)}" tabindex="0" aria-label="${esc(`${monthLabel(m.key, { month: 'long', year: 'numeric' })}: income ${formatRON(m.income)}, spending ${formatRON(m.spend)}${m.partial ? ' (partial month: data starts part-way through)' : ''}`)}"/>`;
  });
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Income and spending for the last ${months.length} months">${svg}</svg>${months.some((m) => m.partial) ? '<p class="chart-note">* Hatched: your data starts part-way through that month</p>' : ''}</div>`;
}

function roundedTop(x, yTop, w, h, r) {
  return `M${x},${yTop + h}V${yTop + r}Q${x},${yTop} ${x + r},${yTop}H${x + w - r}Q${x + w},${yTop} ${x + w},${yTop + r}V${yTop + h}Z`;
}

function niceStep(raw) {
  const pow = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * pow;
}

function shortNum(v) {
  if (v >= 1000) return `${(v / 1000).toLocaleString('ro-RO', { maximumFractionDigits: 1 })}k`;
  return String(Math.round(v));
}

// One tooltip element for every [data-tip] mark on the page.
export function attachTooltips(root, tooltipEl) {
  const show = (target, x, y) => {
    tooltipEl.innerHTML = target.dataset.tip;
    tooltipEl.hidden = false;
    const r = tooltipEl.getBoundingClientRect();
    const left = Math.min(Math.max(8, x + 14), window.innerWidth - r.width - 8);
    const top = y - r.height - 12 < 8 ? y + 16 : y - r.height - 12;
    tooltipEl.style.left = `${left}px`;
    tooltipEl.style.top = `${top}px`;
  };
  const hide = () => { tooltipEl.hidden = true; };
  root.addEventListener('pointermove', (e) => {
    const t = e.target.closest?.('[data-tip]');
    if (t && e.pointerType === 'mouse') show(t, e.clientX, e.clientY); else hide();
  });
  root.addEventListener('pointerleave', hide);
  root.addEventListener('focusin', (e) => {
    const t = e.target.closest?.('[data-tip]');
    if (t) { const r = t.getBoundingClientRect(); show(t, r.left + r.width / 2, r.top); }
  });
  root.addEventListener('focusout', hide);
  window.addEventListener('scroll', hide, { passive: true });
}
