"use client";

import { useEffect, useState } from "react";
import { isRaOnDuty } from "@/lib/halls";

/**
 * Is an RA on duty right now? Returns null until the page has loaded in the
 * browser (so the server-rendered page and the first browser render match),
 * then keeps itself up to date every minute.
 */
export function useRaOnDuty(): boolean | null {
  const [onDuty, setOnDuty] = useState<boolean | null>(null);
  useEffect(() => {
    const update = () => setOnDuty(isRaOnDuty());
    update();
    const timer = setInterval(update, 60_000);
    return () => clearInterval(timer);
  }, []);
  return onDuty;
}
