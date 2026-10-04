"use client";

// GUARDRAIL #2: the fixed escalation screen.
// Everything shown here comes from lib/escalation.ts and data/hall-contacts.json.
// It takes only a category name as input, so no model output can ever change
// what it says.
//
// On a phone it slides up as a bottom sheet; on a laptop it's a centered card.
// Escape or tapping outside closes it, and focus returns to where it was.

import { useEffect, useRef, useState } from "react";
import { ALWAYS_SHOWN, SCREENS, type EscalationCategory, type Resource } from "@/lib/escalation";
import type { Hall } from "@/lib/halls";
import { CloseIcon, PhoneIcon } from "./Icons";
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
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    sheetRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onBack();
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previouslyFocused?.focus?.();
    };
  }, [onBack]);

  return (
    <div className="sheet-backdrop" onClick={onBack}>
      <div
        ref={sheetRef}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="esc-title"
        aria-describedby="esc-message"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <h2 id="esc-title">{screen.title}</h2>
          <button className="icon-btn" onClick={onBack} aria-label="Close">
            <CloseIcon size={20} />
          </button>
        </div>
        <p id="esc-message" className="sheet-message">
          {screen.message}
        </p>

        <ul className="resources">
          {screen.resources.map((r) => (
            <ResourceItem key={r.name} resource={r} />
          ))}
        </ul>

        <h3 className="resources-heading">Crisis and safety contacts, any time</h3>
        <ul className="resources">
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
      <div className="resource-text">
        <strong>{r.name}</strong>
        <span>{r.detail}</span>
      </div>
      {r.phone && (
        <a className="call" href={`tel:${r.phone}`}>
          <PhoneIcon size={18} /> {r.actionLabel}
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
