"use client";

// The chat page. Conversation history lives only in this browser tab's memory:
// nothing is saved, and it's gone when the tab closes (GUARDRAIL #4).

import { useEffect, useRef, useState } from "react";
import { CONFIG } from "@/lib/config";
import {
  checkEscalation,
  SCREENS,
  type EscalationCategory,
} from "@/lib/escalation";
import { HALLS, matchHall, type Hall } from "@/lib/halls";
import type { AssistantReply, HistoryTurn } from "@/lib/types";
import EscalationScreen from "./EscalationScreen";
import { HallContactCard, HallPicker } from "./HallContacts";

type Message =
  | { id: number; role: "user"; text: string }
  | { id: number; role: "assistant"; reply: AssistantReply };

const STARTER_QUESTIONS = [
  "Can my friend stay over this weekend?",
  "Are candles allowed in my room?",
  "I'm locked out of my room. What do I do?",
  "When do finals quiet hours start?",
  "How do I switch rooms?",
];

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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

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

  function openHelp() {
    logEscalation("general", "help_link");
    setEscalation("general");
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

    // A short reply to "which hall?" (like "wilson") is answered right here.
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
    }
  }

  return (
    <div className="page">
      <header className="header">
        <div className="header-inner">
          <span className="eyebrow">
            MSU Residence Education and Housing Services
          </span>
          <h1>Wilson Hall Handbook Assistant</h1>
          <p>
            Answers come from the official {CONFIG.handbookTitle}, with the
            section cited.
          </p>
          <button
            className="ra-button"
            onClick={() => {
              addUser("How do I reach the RA on duty?");
              addReply({ type: "ra_lookup" });
            }}
          >
            📞 Reach the RA on duty
          </button>
        </div>
      </header>

      <main className="chat" aria-live="polite">
        {messages.length === 0 && (
          <section className="welcome">
            <p>
              Ask a question about living on campus in plain language. If the
              handbook doesn&apos;t cover it, I&apos;ll point you to a person
              instead of guessing.
            </p>
            <div className="starters">
              {STARTER_QUESTIONS.map((q) => (
                <button key={q} onClick={() => ask(q)}>
                  {q}
                </button>
              ))}
            </div>
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
            />
          ),
        )}

        {loading && (
          <div className="bubble assistant typing">Checking the handbook…</div>
        )}
        <div ref={bottomRef} />
      </main>

      <div className="dock">
        {/* Always visible, on every screen: the backstop for the backstop. */}
        <div className="help-bar">
          <button className="help-now" onClick={openHelp}>
            Get help now
          </button>
          <span>Crisis, safety, or need a person? Tap here any time.</span>
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
          <input
            id="question"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              awaitingHall
                ? "Type your hall, e.g. Wilson"
                : "e.g. Can I have a mini fridge?"
            }
            maxLength={CONFIG.maxQuestionLength}
            autoComplete="off"
          />
          <button type="submit" disabled={loading || !input.trim()}>
            Ask
          </button>
        </form>
      </div>

      <footer className="footer">
        Anonymous: no login, and questions aren&apos;t tied to you. Please
        don&apos;t include your name or personal details.{" "}
        <strong>In an emergency, call 911.</strong>
      </footer>

      {escalation && (
        <EscalationScreen
          category={escalation}
          onBack={() => setEscalation(null)}
        />
      )}
    </div>
  );
}

function AssistantMessage({
  reply,
  isLatest,
  onReopen,
  onPickHall,
}: {
  reply: AssistantReply;
  isLatest: boolean;
  onReopen: (c: EscalationCategory) => void;
  onPickHall: (hall: Hall) => void;
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
              <p>Here&apos;s how to reach the RA on duty:</p>
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
      return (
        <div className="bubble assistant handoff">
          <p>{reply.note ?? "I couldn't find this in the handbook."}</p>
          <p className="muted small">
            Rather than guess, check with your RA or your hall&apos;s Service
            Center. Tap &ldquo;Reach the RA on duty&rdquo; above for their
            number.
          </p>
        </div>
      );

    case "off_topic":
      return (
        <div className="bubble assistant">
          <p>
            I can only help with MSU housing questions, things like guests,
            quiet hours, lockouts, room changes, or what you can keep in your
            room.
          </p>
        </div>
      );

    case "rate_limited":
      return (
        <div className="bubble assistant handoff">
          <p>
            {reply.reason === "visitor" &&
              "You've asked a lot of questions in a short time. Please wait a minute and try again."}
            {reply.reason === "busy" && "The assistant is very busy right now. Please try again in a minute."}
            {reply.reason === "budget" &&
              "The assistant has reached its limit for today and will be back tomorrow. Your RA and hall Service Center can answer in the meantime."}
          </p>
          <p className="muted small">
            Need a person now? Tap &ldquo;Reach the RA on duty&rdquo; above. If you&apos;re going through something
            hard or anyone is in danger, tap &ldquo;Get help now&rdquo; below.
          </p>
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
              <span className="cite-label">Source</span> {c.source} —{" "}
              <strong>{c.section}</strong>
              {c.pages ? `, ${c.pages}` : ""}
            </summary>
            <blockquote>{c.passage}</blockquote>
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
