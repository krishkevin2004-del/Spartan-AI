// ─────────────────────────────────────────────────────────────────────────────
// GUARDRAIL #2: HARDCODED ESCALATION (layer 1 of 2: keywords)
//
// Some topics must never reach the AI's answer step: self-harm, suicide,
// abuse, immediate safety threats, conduct violations and roommate conflict.
// Every message goes through two checks before anything else:
//   1. These keyword rules (instant, no AI, also run in the browser).
//   2. A separate safety-classifier call (lib/safety.ts) that catches
//      paraphrased distress the keywords miss, and fails closed.
// If either fires, the resident sees a fixed screen from SCREENS below with
// real people to contact and click-to-call buttons. Nothing the model says can
// change these screens.
//
// Plain policy questions ("what counts as harassment?", "what is a roommate
// agreement?") are not escalated; they get a normal cited answer.
//
// ⚠️  Changes to this file should be reviewed by REHS staff. Run
//     `npm run test:escalation` after every edit.
// ─────────────────────────────────────────────────────────────────────────────

export type EscalationCategory =
  | "crisis" // self-harm, suicide, distress
  | "safety" // immediate danger, emergencies
  | "abuse" // abuse, assault, harassment or stalking happening to someone
  | "conduct" // the resident's own conduct incident or write-up
  | "roommate" // roommate or suitemate conflict
  | "general"; // the safety classifier flagged it, or it failed (fail closed), or "Get help now"

// ── Contact resources ───────────────────────────────────────────────────────
// CAPS details: MSU University Health & Wellbeing (uhw.msu.edu), checked
// 2026-09-29. Police and Civil Rights numbers: Safety section of the 2026-27
// handbook (p. 7). Re-check every year.

export type Resource = {
  name: string;
  detail: string;
  phone?: string; // digits only, used for the tel: link
  sms?: string; // digits only, used for the sms: link
  actionLabel?: string; // text on the button
  raLookup?: boolean; // show the "which hall are you in?" picker instead of a number
};

export const RESOURCES = {
  emergency: {
    name: "Emergency: 911",
    detail: "If anyone is in immediate danger or hurt, call 911.",
    phone: "911",
    actionLabel: "Call 911",
  },
  crisisLifeline: {
    name: "988 Suicide & Crisis Lifeline",
    detail: "Free, confidential, 24/7. Call or text 988.",
    phone: "988",
    actionLabel: "Call 988",
  },
  capsCrisis: {
    name: "MSU CAPS 24/7 Crisis Line",
    detail:
      "Free and confidential, any time. Call and press 1 to talk with a crisis counselor. In person: Mon–Fri, 8 a.m.–5 p.m., 3rd floor of Olin Health Center, 463 E. Circle Drive.",
    phone: "5173558270",
    actionLabel: "Call (517) 355-8270, press 1",
  },
  crisisTextLine: {
    name: "Crisis Text Line",
    detail: "Free, 24/7, by text. Text HOME to 741741.",
    sms: "741741",
    actionLabel: "Text 741741",
  },
  msuPolice: {
    name: "MSU Police (non-emergency)",
    detail: "Campus safety concerns, 24/7.",
    phone: "5173552221",
    actionLabel: "Call (517) 355-2221",
  },
  civilRights: {
    name: "MSU Office of Civil Rights",
    detail: "Support and reporting for harassment, discrimination, relationship violence and sexual misconduct.",
    phone: "5173533922",
    actionLabel: "Call (517) 353-3922",
  },
  raOnDuty: {
    name: "Your RA on duty",
    detail: "RAs are on duty 7 pm to 7 am. Pick your hall to get the right contacts.",
    raLookup: true,
  },
} satisfies Record<string, Resource>;

// Shown at the bottom of EVERY escalation screen, whatever the category.
export const ALWAYS_SHOWN: Resource[] = [
  RESOURCES.emergency,
  RESOURCES.crisisLifeline,
  RESOURCES.capsCrisis,
  RESOURCES.crisisTextLine,
  RESOURCES.msuPolice,
];

// ── The fixed screens ───────────────────────────────────────────────────────

export type EscalationScreen = {
  title: string;
  message: string;
  resources: Resource[]; // shown first; ALWAYS_SHOWN is added below them
};

export const SCREENS: Record<EscalationCategory, EscalationScreen> = {
  crisis: {
    title: "You don't have to handle this alone",
    message:
      "This is something a real person should help with, right now. These people are available any time and want to hear from you.",
    resources: [RESOURCES.capsCrisis, RESOURCES.crisisLifeline, RESOURCES.crisisTextLine, RESOURCES.raOnDuty],
  },
  safety: {
    title: "Get help from a person now",
    message: "If you or someone else is in danger, don't wait on a chatbot. Contact one of these right away.",
    resources: [RESOURCES.emergency, RESOURCES.msuPolice, RESOURCES.raOnDuty],
  },
  abuse: {
    title: "You deserve support from a real person",
    message:
      "What you're describing should be handled by trained people, not an automated assistant. You can reach out confidentially.",
    resources: [RESOURCES.capsCrisis, RESOURCES.civilRights, RESOURCES.raOnDuty],
  },
  conduct: {
    title: "Talk to hall staff about this",
    message:
      "Questions about a specific incident or conduct case need a person who can look at your situation. Your RA or hall staff can walk you through what happens next.",
    resources: [RESOURCES.raOnDuty],
  },
  roommate: {
    title: "Your RA can help with this",
    message:
      "Roommate situations are exactly what RAs are trained for. They can help you talk it through, set up a roommate agreement, and figure out next steps.",
    resources: [RESOURCES.raOnDuty],
  },
  general: {
    title: "Let's get you to a person",
    message:
      "This sounds like something a real person should help with. Reach out to any of these. If you're in danger, call 911.",
    resources: [RESOURCES.raOnDuty, RESOURCES.capsCrisis],
  },
};

// ── The trigger rules ───────────────────────────────────────────────────────
// Each rule is a regular expression tested against a NORMALIZED copy of the
// question: lowercase, apostrophes removed ("don't" → "dont"), all other
// punctuation turned into spaces. Write patterns in that form.
//
// Checked in order, first match wins: crisis → safety → abuse → conduct → roommate.

const RULES: Record<Exclude<EscalationCategory, "general">, RegExp[]> = {
  crisis: [
    /\bsuicid/, // suicide, suicidal
    /\bkill(ing|ed)? (my ?self|myself|him ?self|her ?self|them ?selves|them ?self)\b/,
    /\bkms\b/,
    /\bunalive/,
    /\bend(ing)? (my|their|his|her|it) (life|all)\b/,
    /\b(want|wanna|going|gonna) (to )?die\b/,
    /\bdont want to (live|be alive|be here|exist)/,
    /\bno reason to live\b/,
    /\bbetter off dead\b/,
    /\bself ?harm/,
    /\b(hurt|hurting|cut|cutting|harm|harming) (my ?self|myself)\b/,
    /\boverdos/,
  ],
  safety: [
    /\b(this is|its|having|have|theres|there is) an emergency\b/, // not "emergency lock change"
    /^(emergency|help)\b/,
    /\b(in danger|not safe|unsafe|scared for my life)\b/,
    /\b(someone|somebody|guy|man|woman|person|people|student|he|she|they|roommate|neighbor)\b.*\b(has|had|is holding|holding|pulled( out)?|with|carrying|waving|pointed|pointing) an? (gun|knife|weapon|firearm)/,
    /\b(shooter|shooting|gunshot|shots fired)\b/,
    /\b(threatened|threatening) (me|us|to (kill|hurt|shoot|stab))/,
    /\b(theres|there is|i see|i smell|smells like) (a )?(fire|smoke|gas)\b(?! (drill|safety|door|code|policy|rule))/,
    /\bgas leak\b/,
    /\bon fire\b/,
    /\b((not|isnt|stopped) breathing|unconscious|unresponsive|passed out|wont wake up|seizure|bleeding)\b/,
    /\balcohol poisoning\b/,
    /\b(broke|breaking|broken) into\b/,
    /\b(following|followed) me\b/,
    /\b(banging|pounding) on (my|our|the) door\b/,
    /\btrying to (get|break) in\b/,
  ],
  abuse: [
    // Something happening to a person, not a question about the policy.
    /\b(abused|abusing|abusive)\b/,
    /\babuse (me|us|my|her|him|them)\b/,
    /\b(assaulted|assaulting|sexual assault|sexually assault)/,
    /\brap(e|ed|ing)\b/,
    /\bmolest/,
    /\b(harassing|harassed|harasses|stalking|stalked|stalks) (me|us|my|her|him|them)\b/,
    /\bbeing (harassed|stalked|abused|bullied|threatened)\b/,
    /\b(domestic|dating|relationship) violence\b/,
    /\b(hit|hits|hitting|punched|slapped|choked|shoved|pushed|grabbed) me\b/,
    /\btouched me\b/,
    /\bcoerc/,
    /\bgrooming me\b/,
    /\bhazing\b/,
    /\bnon ?consensual\b/,
    /\bwithout (my )?consent\b/,
  ],
  conduct: [
    /\b(written|write|wrote) (me )?up\b/,
    /\bgot (a )?write ?up\b/,
    /\bincident report\b/,
    /\bconduct (hearing|meeting|case|violation|letter|charge)/,
    /\b(i|we|my roommate) (got|was|were|have been|been) (caught|documented|reported|cited|written)\b/,
    /\b(caught|documented) (me|us)\b/,
    /\b(police|cops|ra) (caught|found|documented|reported) (me|us)\b/,
    /\bgetting (kicked|thrown) out\b/,
    /\b(kicked|thrown) out of (housing|the hall|my room|the dorm)/,
    /\bappeal (my|a|the) (sanction|decision|removal)/,
    /\binterim removal\b/,
  ],
  roommate: [
    // "roommate" or "suitemate" together with a sign of conflict.
    /\b(room|suite) ?mates?\b.*\b(conflict|fight|fighting|argu|problem|issue|hate|cant stand|annoying|disrespect|rude|mean to me|messy|dirty|steal|stole|stealing|won ?t|wont|keeps|always|never|lock(s|ed)? me out|sexile|kick(ed|ing)? me out|get along|not getting along|mad at|yell|scream|uncomfortable|drama|toxic|bully|bullying|pressur)/,
    /\b(conflict|fight|fighting|argu|problem|issue|drama|not getting along|dont get along|cant stand|hate) .*\b(room|suite) ?mates?\b/,
    /\bnew roommate because\b/,
  ],
};

const ORDER = ["crisis", "safety", "abuse", "conduct", "roommate"] as const;

/** Lowercase, drop apostrophes, and replace other punctuation with spaces. */
export function normalizeQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’'`]/g, "") // don't → dont
    .replace(/[^a-z0-9]+/g, " ") // punctuation → space
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Returns the escalation category for a question, or null if it is fine to
 * send to the assistant. Plain pattern matching, no AI.
 */
export function checkEscalation(question: string): EscalationCategory | null {
  const text = normalizeQuestion(question);
  for (const category of ORDER) {
    if (RULES[category].some((rule) => rule.test(text))) return category;
  }
  return null;
}
