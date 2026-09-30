// ─────────────────────────────────────────────────────────────────────────────
// The handbook's section headings, copied from its Table of Contents (pp. 2-4).
//
// The ingest script uses these to split the handbook into citable sections, so
// every answer can say exactly which section it came from.
//
// WHEN A NEW HANDBOOK COMES OUT: compare its Table of Contents to this list and
// update it. `npm run ingest -- --dry-run` prints any heading it could not find
// in the PDF, so you'll know what to fix.
//
// These are headings only, never policy content.
// ─────────────────────────────────────────────────────────────────────────────

export type Part = { title: string; subsections: string[] };

export const HANDBOOK_PARTS: Part[] = [
  { title: "INTRODUCTION", subsections: [] },
  { title: "LEGAL INFORMATION", subsections: [] },
  { title: "RESIDENCE EDUCATION AND HOUSING SERVICES", subsections: ["REHS Purpose", "REHS Values"] },
  { title: "RESIDENTIAL AND HOSPITALITY SERVICES", subsections: ["RHS Mission"] },
  { title: "COMMUNITY AND ENGAGEMENT", subsections: [] },
  {
    title: "SAFETY",
    subsections: ["Helpful Numbers", "Missing Student Emergency Contact", "Mental Health Resources"],
  },
  { title: "RESOURCE CENTER FOR PERSONS WITH DISABILITIES (RCPD)", subsections: [] },
  { title: "ON-CAMPUS HOUSING REQUIREMENT", subsections: [] },
  {
    title: "RESIDENT RIGHTS AND RESPONSIBILITIES",
    subsections: ["Resident Rights", "Resident Responsibilities"],
  },
  {
    title: "UNIVERSITY RESPONSIBILITIES",
    subsections: ["Changes by Michigan State University", "Emergencies and Maintenance"],
  },
  { title: "UNIVERSITY HOUSING REGULATIONS", subsections: [] },
  {
    title: "CAMPUS HOUSING RULES AND REGULATIONS",
    subsections: [
      "Access to Residential Buildings",
      "Air Conditioners",
      "Animals/Pets",
      "Appliances and Electrical Items",
      "Athletic Games",
      "Bathrooms",
      "Bystander Response",
      "Campaign, Canvassing and Election Information in Residence Halls",
      "Community Spaces",
      "Conducting Business in Housing Units",
      "Controlled Substances (Alcohol and Other Drugs)",
      "Drills",
      "Equipment Misuse",
      "Explosive Materials and Weapons",
      "Family Housing",
      "Fire Safety",
      "Gambling",
      "Gender-Inclusive Housing",
      "Grilling Equipment",
      "Guests",
      "Identification",
      "Intimidation and Harassment",
      "Keys",
      "Mobility Devices",
      "Noise",
      "Posting",
      "Recording",
      "Responsibility of Your Room",
      "Roofs, Roof Decks and Ledges",
      "Roommate Conflicts",
      "Smoking",
      "Substance-Free Housing",
      "Windows",
    ],
  },
  { title: "RESIDENTS UNDER AGE 18", subsections: [] },
  {
    title: "ROOM ASSIGNMENTS",
    subsections: [
      "Room Assignments",
      "Transitional Housing",
      "Open Space in Under-Assigned Housing Unit",
      "Open Space at the End of the Semester",
    ],
  },
  {
    title: "STUDENT ROOMS",
    subsections: [
      "Room Furnishings and Decorations",
      "Room Maintenance and Cleaning",
      "Bed Adjustments",
      "Damages",
      "Removal and Modifications of Furnishings from Resident Rooms",
      "Room Entry Policy",
    ],
  },
  {
    title: "COMMON AREAS",
    subsections: ["Lounge Usage", "Laundry Facilities", "Responsibility for Common Areas"],
  },
  {
    title: "PACKAGES, MAIL AND DELIVERY GUIDELINES",
    subsections: [
      "General",
      "Prohibited Items",
      "Addressing Packages",
      "Recognized Carriers",
      "Perishables",
      "Unclaimed Packages",
      "Forwarding",
      "Resolution",
    ],
  },
  { title: "LOST AND FOUND", subsections: [] },
  {
    title: "VACATING",
    subsections: [
      "Closed Periods",
      "Holiday Periods and Winter Break Housing",
      "Checking Out",
      "Room Conditions at Checkout",
      "Room Damage Charges",
      "Other Charges that May be Assessed",
      "Residence Hall Cancellation", // in the body text, not listed in the TOC
    ],
  },
  {
    title: "STUDENT ACCOUNTABILITY",
    subsections: [
      "Residential Care and Community Expectations",
      "Contract Violations",
      "Procedures for Contract Violation",
      "Procedures for Policy Violation",
      "Removal",
    ],
  },
  {
    title: "CONTRACT ENDING PROCESS",
    subsections: [
      "Temporary Suspension of Contract",
      "Contract Cancellation",
      "Contract Buyout",
      "Contract Release",
      "Contract Termination",
    ],
  },
  {
    title: "CULINARY SERVICES",
    subsections: ["Entrance to Dining Facilities", "Dining Service Behavior and Dress Standards", "Dining Service"],
  },
  { title: "INFORMATION TECHNOLOGY RESOURCES", subsections: [] },
  {
    title: "PUBLIC HEALTH CRISIS",
    subsections: [
      "Health and Safety",
      "Dining",
      "Housing Assignments and Contracts",
      "On-campus Housing Requirement",
      "Relocation",
      "Contract Termination",
    ],
  },
  { title: "ADDITIONAL RESOURCES", subsections: [] }, // back cover, not in the TOC
];

// Note: boxed call-outs printed beside the main text ("SAFETY AT MSU", "BE A
// GOOD ROOMMATE") stay inside whichever section they sit next to. The PDF
// doesn't place them consistently enough to split them out reliably.

// Pages to skip: the cover and the Table of Contents.
export const SKIP_PAGES_THROUGH = 4;
