// Reads UAB's RSS feed (https://uabevents.com/calendar/rss.xml) and turns each
// <item> into a CampusEvent. The feed is regular, machine-made XML, so small
// plain-text matching is enough and no extra library is needed.
//
// Each item's <description> holds HTML (escaped inside the XML): the posted-by
// line, the event blurb in <p> paragraphs, and an "Event Dates" block with the
// real start and end as <time datetime="..."> tags. An item with no usable
// start time is skipped, because we couldn't place it on a day.

import type { CampusEvent } from "./types";

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "–",
  mdash: "—",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** HTML to plain text: tags removed, entities decoded, whitespace tidied. */
export function htmlToText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  if (!m) return null;
  return m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1");
}

const MAX_DESCRIPTION = 500;

/** The whole feed in, a list of events out. Items it can't use are counted, not thrown. */
export function parseUabFeed(xml: string): { events: CampusEvent[]; skipped: number } {
  const events: CampusEvent[] = [];
  let skipped = 0;

  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const item = match[1];
    const title = tag(item, "title");
    const link = tag(item, "link");
    const guid = tag(item, "guid") ?? link ?? "";
    const rawDescription = tag(item, "description");
    if (!title || !link || !rawDescription) {
      skipped++;
      continue;
    }

    // The description is HTML that was escaped to live inside the XML, so decode it once.
    const html = decodeEntities(rawDescription);

    // Event times are <time datetime="..."> tags without a title="" attribute
    // (the "posted on" time has one). The first is the start, the second the end.
    const times = [...html.matchAll(/<time datetime="([^"]+)"(?![^>]*\btitle=)[^>]*>/gi)].map((m) => m[1]);
    const start = times[0] && !Number.isNaN(Date.parse(times[0])) ? new Date(times[0]).toISOString() : null;
    const end = times[1] && !Number.isNaN(Date.parse(times[1])) ? new Date(times[1]).toISOString() : undefined;
    if (!start) {
      skipped++;
      continue;
    }

    // The blurb is the <p> paragraphs before the "Event Dates" block. If the last
    // paragraph is just a bold line, it's the location ("MSU Union Lake Huron").
    const beforeDates = html.split(/Event Dates/i)[0];
    const paragraphs = [...beforeDates.matchAll(/<p>([\s\S]*?)<\/p>/gi)].map((m) => m[1].trim());
    let location: string | undefined;
    const last = paragraphs[paragraphs.length - 1];
    if (last && /^<strong>[\s\S]*<\/strong>$/i.test(last) && htmlToText(last).length <= 100) {
      location = htmlToText(last);
      paragraphs.pop();
    }
    const description = htmlToText(paragraphs.join(" ")).slice(0, MAX_DESCRIPTION);

    const idNumber = guid.match(/\d+/)?.[0] ?? link.match(/\d+/)?.[0];
    events.push({
      id: `uab-${idNumber ?? events.length}`,
      title: htmlToText(title),
      start,
      ...(end ? { end } : {}),
      ...(location ? { location } : {}),
      description,
      url: link.trim(),
    });
  }
  return { events, skipped };
}
