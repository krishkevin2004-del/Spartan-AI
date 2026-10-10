"use client";

// The chat page. Conversation history lives only in this browser tab's memory:
// nothing is saved, and it's gone when the tab closes (GUARDRAIL #4).

import { useCallback, useEffect, useRef, useState } from "react";
import { CONFIG } from "@/lib/config";
import {
  checkEscalation,
  SCREENS,
  type EscalationCategory,
} from "@/lib/escalation";
import { HALLS, isRaOnDuty, matchHall, type Hall } from "@/lib/halls";
import type { AssistantReply, HistoryTurn } from "@/lib/types";
import EscalationScreen from "./EscalationScreen";
import { HallContactCard, HallPicker } from "./HallContacts";
import { BookIcon, HeartIcon, PhoneIcon, SendIcon } from "./Icons";
import { useRaOnDuty } from "./useRaOnDuty";

type Message =
  | { id: number; role: "user"; text: string }
  | { id: number; role: "assistant"; reply: AssistantReply };

let nextId = 1;

/** The last few messages, as plain text, so follow-up questions make sense. */
function buildHistory(messages: Message[]): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  for (const m of messages) {
    if (m.role === "user") turns.push({ role: "user", text: m.text });
    else if (m.reply.type === "answer")
      turns.push({ role: "assistant", text: m.reply.answer });
    else if (m.reply.type === "chat")
      turns.push({ role: "assistant", text: m.reply.text });
  }
  return turns.slice(-CONFIG.historyTurns);
}

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [escalation, setEscalation] = useState<EscalationCategory | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const closeHelp = useCallback(() => setEscalation(null), []);

  // "Reach the RA on duty" during duty hours (7 pm to 7 am); "Reach your RA" otherwise.
  const onDuty = useRaOnDuty();
  const raLabel = onDuty ? "Reach the RA on duty" : "Reach your RA";

  // Keep the newest message in view.
  useEffect(() => {
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    bottomRef.current?.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "end",
    });
  }, [messages, loading]);

  // The text box grows with what's typed (up to a few lines). When it's empty we
  // leave its size to the stylesheet, so it can never get stuck tall.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    if (!input) {
      el.style.height = "";
      el.style.overflowY = "hidden";
      return;
    }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
    el.style.overflowY = el.scrollHeight > 140 ? "auto" : "hidden"; // no scrollbar until it's needed
  }, [input]);

  function addUser(text: string) {
    setMessages((m) => [...m, { id: nextId++, role: "user", text }]);
  }

  function addReply(reply: AssistantReply) {
    setMessages((m) => [...m, { id: nextId++, role: "assistant", reply }]);
    if (reply.type === "escalate") setEscalation(reply.category);
  }

  /** Anonymous audit log for escalations that happen in the browser. No message text is sent. */
  function logEscalation(
    category: EscalationCategory,
    layer: "keyword" | "help_link",
  ) {
    fetch("/api/escalation-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category, layer }),
    }).catch(() => {});
  }

  /** The "Get help" button in the corner: always there, whatever else is happening. */
  function openHelp() {
    logEscalation("general", "help_link");
    setEscalation("general");
  }

  function reachRA() {
    addUser(
      onDuty ? "How do I reach the RA on duty?" : "How do I reach my RA?",
    );
    addReply({ type: "ra_lookup" });
  }

  // Did we just ask "which hall are you in?" and not get an answer yet?
  const last = messages[messages.length - 1];
  const awaitingHall =
    last?.role === "assistant" &&
    last.reply.type === "ra_lookup" &&
    !last.reply.hallId;

  function pickHall(hall: Hall) {
    addUser(hall.name);
    addReply({ type: "ra_lookup", hallId: hall.id });
  }

  async function ask(question: string) {
    const q = question.trim();
    if (!q || loading) return;
    setInput("");
    const history = buildHistory(messages);
    addUser(q);

    // These checks run right here in the browser, so sensitive questions never
    // leave the resident's device. The server runs the same checks again.
    const category = checkEscalation(q);
    if (category) {
      logEscalation(category, "keyword");
      return addReply({ type: "escalate", category });
    }

    // A short reply to "which hall?" (like "akers") is answered right here.
    // Anything longer goes to the server, so the safety classifier sees it first.
    if (awaitingHall && q.split(/\s+/).length <= 3) {
      const hall = matchHall(q, true);
      if (hall) return addReply({ type: "ra_lookup", hallId: hall.id });
    }

    setLoading(true);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, history }),
      });
      addReply((await res.json()) as AssistantReply);
    } catch {
      addReply({
        type: "error",
        message:
          "Couldn't reach the assistant. Check your connection and try again.",
      });
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="msu-strip">
          <div className="strip-inner">
            {/* Official MSU logo, shown unaltered (green on white) */}
            <img
              className="msu-logo"
              src="/msu-logo.png"
              width={595}
              height={70}
              alt="Michigan State University"
              decoding="async"
            />
            <button
              className="help-btn"
              onClick={openHelp}
              aria-label="Get help now"
            >
              <HeartIcon size={16} />
              <span>Get help</span>
            </button>
          </div>
        </div>
        <div className="brand-band">
          <div className="band-inner brand">
            <span className="brand-mark">
              <BookIcon size={20} />
            </span>
            <div className="brand-text">
              <h1>Housing Handbook Assistant</h1>
              <small>MSU Residence Education and Housing Services</small>
            </div>
          </div>
        </div>
      </header>

      <main className="chat">
        <div
          className="chat-inner"
          role="log"
          aria-live="polite"
          aria-label="Conversation"
        >
          {messages.length === 0 && (
            <section className="welcome">
              <span className="welcome-mark">
                <BookIcon size={30} />
              </span>
              <h2>How can I help?</h2>
              <p>
                Your friend, Spart-I, the Housing Handbook that answers back.
              </p>
            </section>
          )}

          {messages.map((m, i) =>
            m.role === "user" ? (
              <div key={m.id} className="bubble user">
                {m.text}
              </div>
            ) : (
              <AssistantMessage
                key={m.id}
                reply={m.reply}
                isLatest={i === messages.length - 1}
                onReopen={setEscalation}
                onPickHall={pickHall}
                onReachRA={reachRA}
                onAsk={ask}
                raLabel={raLabel}
              />
            ),
          )}

          {loading && (
            <div className="bubble assistant typing" role="status">
              <span className="dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              Checking the handbook…
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </main>

      <div className="dock">
        <div className="dock-inner">
          <div className="quick">
            <button className="chip" onClick={reachRA}>
              <PhoneIcon size={15} /> {raLabel}
            </button>
            {input.length > 400 && (
              <span className="count" aria-live="off">
                {input.length}/{CONFIG.maxQuestionLength}
              </span>
            )}
          </div>

          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              ask(input);
            }}
          >
            <label htmlFor="question" className="sr-only">
              Your question
            </label>
            <textarea
              id="question"
              ref={inputRef}
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends; Shift+Enter makes a new line.
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  ask(input);
                }
              }}
              placeholder={
                awaitingHall ? "Type your hall, e.g. Akers" : "Ask a question…"
              }
              maxLength={CONFIG.maxQuestionLength}
              enterKeyHint="send"
              autoComplete="off"
            />
            <button
              type="submit"
              className="send"
              disabled={loading || !input.trim()}
              aria-label="Send"
            >
              <SendIcon size={20} />
            </button>
          </form>

          <p className="fineprint">
            Everything is anonymous. Feel free to share whatever&apos;s on your
            mind. <strong>In an emergency, call 911.</strong>
          </p>
        </div>
      </div>

      {escalation && (
        <EscalationScreen category={escalation} onBack={closeHelp} />
      )}
    </div>
  );
}

function AssistantMessage({
  reply,
  isLatest,
  onReopen,
  onPickHall,
  onReachRA,
  onAsk,
  raLabel,
}: {
  reply: AssistantReply;
  isLatest: boolean;
  onReopen: (c: EscalationCategory) => void;
  onPickHall: (hall: Hall) => void;
  onReachRA: () => void;
  onAsk: (question: string) => void;
  raLabel: string;
}) {
  switch (reply.type) {
    case "answer":
      return <AnswerCard reply={reply} />;

    case "chat":
      return (
        <div className="bubble assistant">
          <p>{reply.text}</p>
        </div>
      );

    case "ra_lookup": {
      const hall = HALLS.find((h) => h.id === reply.hallId);
      return (
        <div className="bubble assistant">
          {hall ? (
            <>
              <p>
                {isRaOnDuty()
                  ? "Here's how to reach the RA on duty:"
                  : "Here's how to reach your RA:"}
              </p>
              <HallContactCard hall={hall} />
            </>
          ) : (
            <>
              <p>Sure. Which hall do you live in?</p>
              {isLatest && <HallPicker onPick={onPickHall} />}
            </>
          )}
        </div>
      );
    }

    case "escalate":
      return (
        <div className="bubble assistant handoff">
          <p>{SCREENS[reply.category].title}. This is one for a real person.</p>
          <button className="link" onClick={() => onReopen(reply.category)}>
            Show contacts again
          </button>
        </div>
      );

    case "not_found":
      if (reply.source) {
        return (
          <div className="bubble assistant handoff">
            <p>{reply.note}</p>
            {reply.link && (
              <a
                className="chip inline"
                href={reply.link.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {reply.link.label}
              </a>
            )}
          </div>
        );
      }
      return (
        <div className="bubble assistant handoff">
          <p>{reply.note ?? "I couldn't find this in the handbook."}</p>
          <p className="muted small">
            Rather than guess, check with your RA or your hall&apos;s Service
            Center.
          </p>
          <button className="chip inline" onClick={onReachRA}>
            <PhoneIcon size={15} /> {raLabel}
          </button>
        </div>
      );

    case "dining_pick_hall":
      return (
        <div className="bubble assistant">
          <p>Which dining hall?</p>
          {isLatest && (
            <div className="hall-chips">
              {reply.halls.map((h) => (
                <button
                  key={h.id}
                  className="chip"
                  onClick={() =>
                    onAsk(
                      `${reply.question.replace(/[?.!\s]+$/, "")} at ${h.name}`,
                    )
                  }
                >
                  {h.name}
                  <small>{h.building}</small>
                </button>
              ))}
            </div>
          )}
        </div>
      );

    case "off_topic":
      return (
        <div className="bubble assistant">
          <p>
            I can only help with MSU housing questions, like guests, quiet
            hours, lockouts and room changes.
          </p>
        </div>
      );

    case "rate_limited":
      return (
        <div className="bubble assistant handoff">
          <p>
            {reply.reason === "visitor" &&
              "You've asked a lot in a short time. Please wait a minute and try again."}
            {reply.reason === "busy" &&
              "The assistant is very busy right now. Please try again in a minute."}
            {reply.reason === "budget" &&
              "The assistant has reached its limit for today and will be back tomorrow. Your RA and hall Service Center can answer in the meantime."}
          </p>
          <p className="muted small">
            If you&apos;re going through something hard or anyone is in danger,
            tap &ldquo;Get help&rdquo; in the top corner.
          </p>
          <button className="chip inline" onClick={onReachRA}>
            <PhoneIcon size={15} /> {raLabel}
          </button>
        </div>
      );

    case "error":
      return (
        <div className="bubble assistant">
          <p>{reply.message}</p>
        </div>
      );
  }
}

function AnswerCard({
  reply,
}: {
  reply: Extract<AssistantReply, { type: "answer" }>;
}) {
  const [vote, setVote] = useState<"up" | "down" | null>(null);

  function sendVote(v: "up" | "down") {
    if (vote) return;
    setVote(v);
    // Anonymous: only the vote and the section name are sent.
    fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vote: v, section: reply.citations[0]?.section }),
    }).catch(() => {});
  }

  return (
    <div className="bubble assistant answer">
      <p>{reply.answer}</p>

      <div className="citations">
        {reply.citations.map((c) => (
          <details key={c.source + c.section} className="citation">
            <summary>
              <span className="cite-label">Source</span>
              <span className="cite-name">
                {c.source} — <strong>{c.section}</strong>
                {c.pages ? `, ${c.pages}` : ""}
              </span>
            </summary>
            <blockquote>{c.passage}</blockquote>
            {c.url && (
              <a
                className="cite-link"
                href={c.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open the event page
              </a>
            )}
          </details>
        ))}
      </div>

      <div className="feedback">
        {vote ? (
          <span>Thanks for the feedback.</span>
        ) : (
          <>
            <span>Was this helpful?</span>
            <button aria-label="Helpful" onClick={() => sendVote("up")}>
              👍
            </button>
            <button aria-label="Not helpful" onClick={() => sendVote("down")}>
              👎
            </button>
          </>
        )}
      </div>
    </div>
  );
}
