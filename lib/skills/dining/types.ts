// The shape of dining data. Whatever the source (an official feed, a file,
// a scheduled job), it is converted to this shape before it goes in the cache.

export type DiningItem = {
  name: string;
  description?: string;
  tags?: string[]; // labels the menu posts, e.g. "vegan", "vegetarian", "gluten-free"
  allergens?: string[]; // allergens the menu says the item contains, e.g. "milk", "wheat"
};
export type DiningStation = { name: string; items: DiningItem[] };
export type DiningMeal = { name: string; slug?: string; stations: DiningStation[] }; // slug: the meal's page name on the menu site, used to link straight to it // name: "Breakfast", "Lunch", "Dinner", ...
export type DiningDay = { meals: DiningMeal[] };

/** What the daily update sends in: one hall, several days. */
export type DiningHallInfo = { address?: string; hours?: string };

export type DiningSnapshot = {
  hallId: string;
  hallInfo?: DiningHallInfo; // address and posted hours, if the source has them
  scrapedAt: string; // ISO time the menu was fetched, shown as "as of ..." in answers
  source: string; // where it came from, e.g. the official menu page
  days: Record<string, DiningDay>; // keys are dates like "2026-10-08"
};

export type DiningHall = {
  id: string;
  name: string;
  building: string;
  menuUrl: string;
  enabled: boolean;
  hours: string | null;
  aliases?: string[]; // names people use for it ("Akers", "The Edge")
};

/** What the router extracts from a dining question. */
export type DiningRoute = {
  hall: string; // a hall id from data/dining/halls.json, "other_hall" (a place we don't cover), or "none" (not named)
  meal: "breakfast" | "lunch" | "dinner" | "any" | "none";
  date: string; // YYYY-MM-DD, or "" if not stated
  dateTo?: string; // last day, when they ask about more than one ("today and tomorrow")
  keywords: string[]; // specific foods or diets they asked about
  // "dish" = something a menu would list by name (pizza, tacos, chicken): searched for by word first.
  // "style" = a cuisine, mood or description (chinese, spicy, light, comfort food): matched by judgement.
  kind?: "dish" | "style";
};
