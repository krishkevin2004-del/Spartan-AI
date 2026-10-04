"use client";

// "Which hall are you in?" picker and the contact card for that hall.
// All numbers come from data/hall-contacts.json, never from the AI.

import { CONFIG } from "@/lib/config";
import { HALLS, isRaOnDuty, NEIGHBORHOODS, type Hall } from "@/lib/halls";
import { PhoneIcon } from "./Icons";

function digits(phone: string) {
  return phone.replace(/[^0-9]/g, "");
}

export function HallPicker({ onPick }: { onPick: (hall: Hall) => void }) {
  return (
    <div className="hall-picker">
      <select
        aria-label="Choose your hall"
        defaultValue=""
        onChange={(e) => {
          const hall = HALLS.find((h) => h.id === e.target.value);
          if (hall) onPick(hall);
        }}
      >
        <option value="" disabled>
          Choose your hall…
        </option>
        {NEIGHBORHOODS.map((n) => (
          <optgroup key={n} label={n}>
            {HALLS.filter((h) => h.neighborhood === n).map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

export function HallContactCard({ hall }: { hall: Hall }) {
  // Only ever shown after a tap, so it's safe to read the clock right here.
  const onDuty = isRaOnDuty();
  const hours = CONFIG.raOnDuty.hoursLabel;

  return (
    <div className="hall-card">
      <strong>{hall.name}</strong>
      <p className="hours">
        {onDuty ? `RA on duty · ${hours}` : `RAs are on duty ${hours}`}
      </p>

      {hall.raOnDutyPhone ? (
        <a className="call" href={`tel:${digits(hall.raOnDutyPhone)}`}>
          <PhoneIcon size={18} /> Call RA on duty: {hall.raOnDutyPhone}
        </a>
      ) : onDuty ? (
        <p className="muted">
          The RA on duty number is posted in your hall. Your Service Center can also give it to you:
        </p>
      ) : (
        <p className="muted">Until then, your hall&apos;s Service Center can point you to your RA:</p>
      )}

      {hall.serviceCenters.map((sc) => (
        <div key={sc.name + sc.phone} className="sc">
          <span>
            {sc.name}
            {sc.hours ? ` (${sc.hours})` : ""}
          </span>
          <a className="call secondary" href={`tel:${digits(sc.phone)}`}>
            <PhoneIcon size={18} /> Call {sc.phone}
          </a>
        </div>
      ))}

      <p className="muted small">Emergency? Call 911. Campus police non-emergency: 517-355-2221.</p>
    </div>
  );
}
