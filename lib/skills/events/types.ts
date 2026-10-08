// The shape of events data. The daily job turns the UAB feed into this shape
// before it goes in the cache.

export type CampusEvent = {
  id: string; // e.g. "uab-2113"
  title: string;
  start: string; // ISO time (UTC)
  end?: string; // ISO time (UTC)
  location?: string; // only when the listing clearly names one
  description: string; // plain text, shortened
  url: string; // the event's page on uabevents.com
};

export type EventsSnapshot = {
  fetchedAt: string; // ISO time the feed was fetched, shown as "as of ..." in answers
  source: string; // where it came from
  events: CampusEvent[];
};

/** What the router extracts from an events question. */
export type EventsRoute = {
  from: string; // first day they mean, YYYY-MM-DD
  to: string; // last day they mean, YYYY-MM-DD (same as from for a single day)
  keywords: string[]; // what kind of thing they want, e.g. "comedy", "free food"
};
