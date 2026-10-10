// Plain filtering over one day's menu. No AI here: given a day, a meal and some
// keywords, it returns the matching items grouped by meal and station.

import type { DiningDay, DiningItem } from "./types";

export type MenuBlock = { meal: string; mealSlug?: string; station: string; items: DiningItem[] };

export type RequestedMeal = "breakfast" | "lunch" | "dinner" | "any";

// "Brunch" counts for both breakfast and lunch.
const MEAL_PATTERNS: Record<Exclude<RequestedMeal, "any">, RegExp> = {
  breakfast: /breakfast|brunch/i,
  lunch: /lunch|brunch/i,
  dinner: /dinner|supper/i,
};

const EXACT_MEAL: Record<Exclude<RequestedMeal, "any">, RegExp> = {
  breakfast: /breakfast/i,
  lunch: /lunch/i,
  dinner: /dinner|supper/i,
};

const MAX_ITEMS_PER_BLOCK = 30;

// Stations that are mostly toppings and drinks. They go last when we have to choose what to show.
const LOW_VALUE_STATION =
  /beverage|build your own|condiment|topping|sauce|dressing/i;

export function isLowValueStation(station: string): boolean {
  return LOW_VALUE_STATION.test(station);
}

/** Which blocks to show or send to the model: real entrees first, toppings and drinks last, and no more than `max`. */
export function prioritizeBlocks(
  blocks: MenuBlock[],
  max: number,
): MenuBlock[] {
  const good = blocks.filter((b) => !LOW_VALUE_STATION.test(b.station));
  const rest = blocks.filter((b) => LOW_VALUE_STATION.test(b.station));
  return [...good, ...rest].slice(0, max);
}

/** "burgers" and "burger" should match each other. */
function stem(word: string): string {
  return word
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/(es|s)$/, "");
}

function itemMatches(
  item: DiningItem,
  station: string,
  keywords: string[],
): boolean {
  if (keywords.length === 0) return true;
  const haystack = stem(
    [
      item.name,
      item.description ?? "",
      station,
      ...(item.tags ?? []),
      ...(item.allergens ?? []),
    ].join(" "),
  );
  const haystackWords = haystack.split(/\s+/);
  return keywords.some((keyword) => {
    const k = stem(keyword);
    return (
      k.length > 0 &&
      (haystack.includes(k) || haystackWords.some((w) => w === k))
    );
  });
}

/** The meals, stations and items on this day that fit the request. An empty list means "nothing matches". */
export function filterDay(
  day: DiningDay,
  meal: RequestedMeal,
  keywords: string[],
): MenuBlock[] {
  const blocks: MenuBlock[] = [];
  // If a hall serves both Brunch and Lunch, "lunch" means Lunch; Brunch only stands in when there's no Lunch.
  const exact =
    meal === "any"
      ? []
      : day.meals.filter((m) => EXACT_MEAL[meal].test(m.name));
  const meals =
    meal === "any"
      ? day.meals
      : exact.length > 0
        ? exact
        : day.meals.filter((m) => MEAL_PATTERNS[meal].test(m.name));
  for (const m of meals) {
    for (const station of m.stations) {
      const items = station.items.filter((item) =>
        itemMatches(item, station.name, keywords),
      );
      // Very long stations are split so each block stays small enough to cite.
      for (let i = 0; i < items.length; i += MAX_ITEMS_PER_BLOCK) {
        blocks.push({
          meal: m.name,
          mealSlug: m.slug,
          station: station.name,
          items: items.slice(i, i + MAX_ITEMS_PER_BLOCK),
        });
      }
    }
  }
  return blocks;
}

/** One item as plain text, with the labels the menu posts, e.g. "Veggie Burger (vegan; contains soy)". */
export function describeItem(item: DiningItem): string {
  const labels = [...(item.tags ?? [])];
  if (item.allergens && item.allergens.length > 0)
    labels.push(`contains ${item.allergens.join(", ")}`);
  const notes = labels.length > 0 ? ` (${labels.join("; ")})` : "";
  const detail = item.description ? ` - ${item.description}` : "";
  return `${item.name}${notes}${detail}`;
}

/** The page on the menu site for this meal on this day, e.g. .../south-pointe-at-case/dinner/2026-10-10 */
export function mealPageUrl(hallMenuUrl: string, block: { meal: string; mealSlug?: string }, date: string): string {
  const slug = block.mealSlug ?? block.meal.toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  return `${hallMenuUrl}/${slug}/${date}`;
}

export function blockText(block: MenuBlock): string {
  return `${block.meal} · ${block.station}: ${block.items.map(describeItem).join("; ")}`;
}
