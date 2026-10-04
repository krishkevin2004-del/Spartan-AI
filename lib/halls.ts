// ─────────────────────────────────────────────────────────────────────────────
// RA ON DUTY LOOKUP
//
// When a resident asks for their RA's number, we don't send that to the AI.
// We ask which hall they live in, then show that hall's contacts straight from
// data/hall-contacts.json. Plain code, no model, so a phone number can never
// be made up.
// ─────────────────────────────────────────────────────────────────────────────

import hallData from "../data/hall-contacts.json";
import { CONFIG } from "./config";
import { normalizeQuestion } from "./escalation";

export type ServiceCenter = { name: string; phone: string; hours?: string };
export type Hall = {
  id: string;
  name: string;
  neighborhood: string;
  raOnDutyPhone: string | null;
  serviceCenters: ServiceCenter[];
};

export const HALLS: Hall[] = hallData.halls as Hall[];
export const HALLS_CHECKED = hallData.checked;

export const NEIGHBORHOODS = [...new Set(HALLS.map((h) => h.neighborhood))];

// Words that identify each hall in a message. Hall names that are also normal
// English words ("case", "rather", "owen"?) must be followed by "hall", unless
// the resident is directly answering "which hall are you in?".
const ALIASES: Record<string, { strong: string[]; weak?: string[] }> = {
  abbot: { strong: ["abbot", "abbott"] },
  campbell: { strong: ["campbell"] },
  gilchrist: { strong: ["gilchrist"] },
  landon: { strong: ["landon"] },
  mason: { strong: ["mason hall"], weak: ["mason"] },
  mayo: { strong: ["mayo"] },
  phillips: { strong: ["phillips"] },
  snyder: { strong: ["snyder"] },
  williams: { strong: ["williams hall"], weak: ["williams"] },
  yakeley: { strong: ["yakeley"] },
  armstrong: { strong: ["armstrong"] },
  bailey: { strong: ["bailey hall"], weak: ["bailey"] },
  bryan: { strong: ["bryan hall"], weak: ["bryan"] },
  butterfield: { strong: ["butterfield"] },
  emmons: { strong: ["emmons"] },
  rather: { strong: ["rather hall"], weak: ["rather"] },
  mcdonel: { strong: ["mcdonel", "mcdonnell", "mcdonell"] },
  owen: { strong: ["owen hall"], weak: ["owen"] },
  shaw: { strong: ["shaw hall"], weak: ["shaw"] },
  vanhoosen: { strong: ["van hoosen", "vanhoosen"] },
  akers: { strong: ["akers"] },
  holmes: { strong: ["holmes hall"], weak: ["holmes"] },
  hubbard: { strong: ["hubbard"] },
  case: { strong: ["case hall"], weak: ["case"] },
  holden: { strong: ["holden"] },
  wilson: { strong: ["wilson hall"], weak: ["wilson"] },
  wonders: { strong: ["wonders hall"], weak: ["wonders"] },
  "university-village": { strong: ["university village"], weak: ["uv"] },
  "1855-place": { strong: ["1855 place", "1855"] },
};

/**
 * Find the hall named in a message.
 * `answeringHallQuestion` = the resident is replying to "which hall?", so a bare
 * "wilson" or "case" counts.
 */
export function matchHall(text: string, answeringHallQuestion = false): Hall | null {
  const t = ` ${normalizeQuestion(text)} `;
  for (const hall of HALLS) {
    const alias = ALIASES[hall.id];
    if (!alias) continue;
    const words = answeringHallQuestion ? [...alias.strong, ...(alias.weak ?? [])] : alias.strong;
    if (words.some((w) => t.includes(` ${w} `))) return hall;
  }
  return null;
}

/** Is an RA on duty right now? (7 pm to 7 am, Michigan time. Set in lib/config.ts.) */
export function isRaOnDuty(now: Date = new Date()): boolean {
  const { startHour, endHour, timeZone } = CONFIG.raOnDuty;
  const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone }).format(now));
  return hour >= startHour || hour < endHour;
}

// "What's the RA on duty number?", "how do I call my RA", "RA phone", ...
const RA_REQUEST_RULES: RegExp[] = [
  /\b(ra|ras|resident assistant)\b.*\b(number|phone|contact|cell)\b/,
  /\b(number|phone|contact|cell)\b.*\b(ra|ras|resident assistant)\b/,
  /\b(ra|resident assistant)s? on (duty|call)\b/,
  /\bon (duty|call) (ra|resident assistant)\b/,
  /\b(call|reach|text|contact|find|get ahold of|get a hold of) (my|an|the|a|our) (ra|resident assistant)\b/,
];

export function isRaContactRequest(text: string): boolean {
  const t = normalizeQuestion(text);
  return RA_REQUEST_RULES.some((rule) => rule.test(t));
}
