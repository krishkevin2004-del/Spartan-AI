"use client";

// GUARDRAIL #2: the fixed escalation screen.
// Everything shown here comes from lib/escalation.ts and data/hall-contacts.json.
// It takes only a category name as input, so no model output can ever change
// what it says.

import { useState } from "react";
import { ALWAYS_SHOWN, SCREENS, type EscalationCategory, type Resource } from "@/lib/escalation";
import type { Hall } from "@/lib/halls";
import { HallContactCard, HallPicker } from "./HallContacts";

export default function EscalationScreen({
  category,
  onBack,
}: {
  category: EscalationCategory;
  onBack: () => void;
}) {
  const screen = SCREENS[category];
  // The category's own contacts first, then the crisis list every screen shows.
  const extras = ALWAYS_SHOWN.filter((r) => !screen.resources.includes(r));

  return (
    <div className="escalation" role="alertdialog" aria-labelledby="esc-title" aria-describedby="esc-message">
      <div className="escalation-card">
        <h2 id="esc-title">{screen.title}</h2>
        <p id="esc-message">{screen.message}</p>

        <ul className="resources">
          {screen.resources.map((r) => (
            <ResourceItem key={r.name} resource={r} />
          ))}
        </ul>

        <h3 className="resources-heading">Crisis and safety contacts, any time</h3>
        <ul className="resources compact">
          {extras.map((r) => (
            <ResourceItem key={r.name} resource={r} />
          ))}
        </ul>

        <button className="back" onClick={onBack}>
          Back to questions
        </button>
      </div>
    </div>
  );
}

function ResourceItem({ resource: r }: { resource: Resource }) {
  const [hall, setHall] = useState<Hall | null>(null);
  return (
    <li className="resource">
      <div>
        <strong>{r.name}</strong>
        <span>{r.detail}</span>
      </div>
      {r.phone && (
        <a className="call" href={`tel:${r.phone}`}>
          {r.actionLabel}
        </a>
      )}
      {r.sms && (
        <a className="call" href={`sms:${r.sms}`}>
          {r.actionLabel}
        </a>
      )}
      {r.raLookup && (hall ? <HallContactCard hall={hall} /> : <HallPicker onPick={setHall} />)}
    </li>
  );
}
