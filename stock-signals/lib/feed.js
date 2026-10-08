// Minimal RSS/Atom reader; good enough for news wires and SEC feeds.
export function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

export const stripTags = (s) => decode(String(s ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

export function tag(block, name) {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? decode(m[1]).trim() : '';
}

export function parseFeed(xml) {
  const items = [];
  for (const [block] of xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)) {
    const link = tag(block, 'link') || decode(/<link[^>]*href="([^"]+)"/i.exec(block)?.[1] ?? '');
    items.push({
      id: tag(block, 'guid') || tag(block, 'id') || link,
      title: stripTags(tag(block, 'title')),
      summary: tag(block, 'description') || tag(block, 'summary') || tag(block, 'content'),
      link,
      time: Date.parse(tag(block, 'pubDate') || tag(block, 'updated') || tag(block, 'published')) || null,
    });
  }
  return items;
}
