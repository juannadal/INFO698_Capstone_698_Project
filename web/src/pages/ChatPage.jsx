// The chat page (/chat): the one place to ask questions (since 2026-11-09; it replaced the one-question ask page, and
// old /ask?q=... links forward here, see main.jsx). The reader's messages sit on the right, the answers on the left,
// and the typing box stays at the bottom. Each message is its own /api/ask request: a follow-up is rewritten by the
// Worker into a search that makes sense alone, which finds new articles and writes a cited answer from them
// (worker/src/followup.js). So every reply still cites the research, uncited sentences are still dropped, and each
// message counts toward the rate limit and daily caps. Messages are saved in query_log with source 'chat'.
//
// The Worker remembers nothing between requests: the page keeps the conversation and sends the last 3 exchanges
// with each message (src/pages/conversation.js). Changing the model or reading level applies to the next message,
// so one conversation can compare them.
//
// The start page's question box opens /chat?q=...: the chat starts with that question (&model= and &level= pick the
// menus, &exact=1 skips spelling correction). The question is then removed from the URL so a reload does not ask it
// again; "Copy link" rebuilds the link to the first question for sharing.

import * as React from 'react';
import { useSearchParams } from 'react-router-dom';
import { Citation, SourceCard, ReadingLevel, Button } from '../design/index.jsx';
import { ask, pubmedUrl } from '../api.js';
import { buildHistory, HISTORY_SENT, chatPath } from './conversation.js';
import {
  NotMedicalAdvice, SavedNotice, ModelPicker, MODEL_NAMES, savedModel, toModel, LevelPicker, LEVEL_TARGETS, savedLevel,
  toLevel, usePrintOpensSources,
} from './shared.jsx';

// The longest chat a page holds. Only the last 3 exchanges are sent as context, so a longer chat would not "remember"
// more; the cap keeps a forgotten tab from growing without end.
const MAX_MESSAGES = 20;
const MAX_QUESTION = 300;   // the Worker's limit (MAX_QUESTION in worker/src/index.js)

const STARTERS = [
  'Does walking every day help lower blood pressure?',
  'How much sleep do adults over 65 need?',
  'Can losing weight help control type 2 diabetes?',
];

export default function ChatPage() {
  const [params, setParams] = useSearchParams();
  // Each turn is { question, detail, model, level, status: 'working' | 'answered' | 'no_answer' | 'error', result,
  // limited }. model and level are the ones the turn was asked with.
  const [turns, setTurns] = React.useState([]);
  // A link with a question (/chat?q=...) carries its own menus: chatPath leaves out the defaults, so a missing
  // &model= or &level= means Llama or high school, not this browser's last choice. An empty chat starts at the
  // reader's last choice.
  const fromLink = !!params.get('q');
  const [model, setModel] = React.useState(() => (fromLink ? toModel(params.get('model')) : savedModel()));
  const [level, setLevel] = React.useState(() => (fromLink ? toLevel(params.get('level')) : savedLevel()));
  const [copied, setCopied] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  // The request in flight, so it can be cancelled when the reader starts over or leaves.
  const ctrl = React.useRef(null);
  const endRef = React.useRef(null);
  const inputRef = React.useRef(null);
  const busy = turns.some((t) => t.status === 'working');

  React.useEffect(() => {
    document.title = 'Chat · Aging & Lifestyle Research Explorer';
    return () => ctrl.current?.abort();
  }, []);
  // Printing opens the folded sources of earlier replies, so a printout keeps every study (shared.jsx).
  usePrintOpensSources();

  // Ask turn i, with the turns before it as context, and fill it in when the reply comes.
  const run = React.useCallback((i, turn, earlier) => {
    ctrl.current?.abort();
    ctrl.current = new AbortController();
    ask(turn.question, {
      signal: ctrl.current.signal, model: turn.model, level: turn.level, history: buildHistory(earlier),
      detail: !!turn.detail, exact: !!turn.exact, via: 'chat',
    })
      .then((result) => update(i, result.status === 'answered' ? { status: 'answered', result }
        : { status: 'no_answer', result: { correctedQuestion: result.correctedQuestion, searchedFor: result.searchedFor } }))
      .catch((err) => {
        if (err.name !== 'AbortError') update(i, { status: 'error', limited: err.status === 429 ? err.message : null });
      });
  }, []);

  const update = (i, fields) => setTurns((ts) => ts.map((t, j) => (j === i ? { ...t, ...fields } : t)));

  // Add a message and ask it. detail: true is "More detail" on the last answer; exact: true searches the words as
  // typed, without spelling correction ("Search instead for ...").
  const send = (text, detail = false, exact = false) => {
    const q = text.trim().slice(0, MAX_QUESTION);
    if (!q || busy || turns.length >= MAX_MESSAGES) return;
    const turn = { question: q, detail, exact, model, level, status: 'working' };
    const i = turns.length;
    setTurns((ts) => [...ts, turn]);
    setDraft('');
    run(i, turn, turns);
  };

  // A question in the URL (/chat?q=..., e.g. from a link) starts the chat; it is then removed from the URL so a
  // reload does not ask it again. The first turn is set (not added) and asked on every run of this effect, because
  // React's development mode runs effects twice: the first run's request is cancelled by the cleanup, and the second
  // run must ask again rather than leave the turn "working" forever.
  React.useEffect(() => {
    const q = (params.get('q') || '').trim().slice(0, MAX_QUESTION);
    if (!q) return undefined;
    const turn = { question: q, detail: false, exact: params.get('exact') === '1', model, level, status: 'working' };
    setTurns([turn]);
    run(0, turn, []);
    setParams({}, { replace: true });
    return () => ctrl.current?.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "Search instead for": ask turn i again with the words as typed (exact), replacing its reply, with only the turns
  // before it as context, so the rejected correction is not sent back to the Worker.
  const searchAsTyped = (i) => {
    if (busy) return;
    const turn = { ...turns[i], exact: true, status: 'working', result: undefined, limited: null };
    update(i, turn);
    run(i, turn, turns.slice(0, i));
  };

  // Only when nothing else is working: a retry cancels the request in flight, which would leave that turn stuck.
  const retry = (i) => {
    if (busy) return;
    const turn = { ...turns[i], status: 'working', limited: null };
    update(i, turn);
    run(i, turn, turns.slice(0, i));
  };

  const newChat = () => {
    ctrl.current?.abort();
    setTurns([]);
    setDraft('');
    inputRef.current?.focus();
  };

  // A link that opens the chat with its first question (and the menus it was asked with), for sharing or saving.
  // The clipboard can be blocked (an older browser, or a page not served over https); then the link is shown so it
  // can be copied by hand.
  const copyLink = async () => {
    const first = turns[0];
    if (!first) return;
    const url = window.location.origin + chatPath(first.question, first.model, first.level, first.exact);
    try {
      await navigator.clipboard.writeText(url);
      setCopied('Link copied.');
    } catch {
      setCopied(url);
    }
  };

  // Keep the newest message in view.
  React.useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns]);

  const last = turns[turns.length - 1];
  const full = turns.length >= MAX_MESSAGES;

  return (
    <div className="chat">
      <div className="chat-top stack-3">
        <div className="chat-title-row">
          <h1 className="title-l">Ask about aging and health</h1>
          {turns.length > 0 && (
            <div className="row-3 no-print">
              <Button onClick={() => window.print()}>Print this chat</Button>
              <Button onClick={copyLink}>Copy link</Button>
              <Button onClick={newChat}>New chat</Button>
            </div>
          )}
        </div>
        {copied && <p className="small-muted no-print" role="status" style={{ overflowWrap: 'anywhere' }}>{copied}</p>}
        <div className="chat-menus">
          <LevelPicker value={level} onChange={setLevel} />
          <ModelPicker value={model} onChange={setModel} />
        </div>
        <p className="small-muted">
          Every reply is written from published studies and links to them. The chat uses your last {HISTORY_SENT}{' '}
          questions as context. Changing a menu applies to your next message.
        </p>
        <SavedNotice />
      </div>

      <NotMedicalAdvice text="Replies explain published research to help you learn. Talk with your doctor before you change your care." />

      <ol className="chat-log" aria-label="Conversation" aria-live="polite">
        {turns.length === 0 && (
          <li className="chat-msg chat-msg-bot">
            <div className="chat-bubble stack-3">
              <p>Hi! Ask me about aging and health: exercise, diet, sleep, healthy habits, or long-term conditions. I answer from published research and show you every study I used.</p>
              <div className="stack-1">
                <p className="small-muted">You could start with:</p>
                {STARTERS.map((q) => (
                  <button key={q} type="button" className="chat-starter text-link" onClick={() => send(q)}>{q}</button>
                ))}
              </div>
            </div>
          </li>
        )}
        {turns.map((t, i) => (
          <React.Fragment key={i}>
            <li className="chat-msg chat-msg-you">
              <span className="visually-hidden">You: </span>
              <div className="chat-bubble">{t.detail ? 'More detail, please.' : t.question}</div>
            </li>
            <li className="chat-msg chat-msg-bot">
              <span className="visually-hidden">Answer: </span>
              <Reply
                turn={t}
                i={i}
                onRetry={() => retry(i)}
                // "Search instead for" re-asks the words as typed; only for the latest reply, when nothing is working.
                onSearchAsTyped={i === turns.length - 1 && !busy && !t.exact ? () => searchAsTyped(i) : null}
              />
            </li>
          </React.Fragment>
        ))}
      </ol>
      <div ref={endRef} />

      <div className="chat-compose no-print">
        {full ? (
          <p>This chat has reached its limit. <button type="button" className="text-link chat-starter" onClick={newChat}>Start a new chat</button></p>
        ) : (
          <>
            {last?.status === 'answered' && !last.detail && !busy && (
              <div className="row-3">
                <Button onClick={() => send(last.result.searchedFor || last.result.correctedQuestion || last.question, true)}>
                  Give me more detail
                </Button>
              </div>
            )}
            <form
              className="chat-form"
              onSubmit={(e) => {
                e.preventDefault();
                send(draft);
              }}
            >
              <label htmlFor="chat-input" className="visually-hidden">Your message</label>
              <textarea
                id="chat-input"
                ref={inputRef}
                className="chat-input"
                rows={1}
                maxLength={MAX_QUESTION}
                value={draft}
                placeholder={turns.length ? 'Ask a follow-up question' : 'Ask a question about aging and health'}
                onChange={(e) => setDraft(e.target.value)}
                // Enter sends; Shift+Enter starts a new line, as in most chat apps. An Enter that confirms text typed
                // with an input method (Chinese, Japanese, Korean...) is left alone, so it never sends half a question.
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send(draft);
                  }
                }}
              />
              <Button variant="primary" type="submit" disabled={busy || !draft.trim()}>Send</Button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

// One reply bubble: working, the answer with its sources, no research found, or an error.
// The class names on the bubbles (chat-answer, chat-no-answer, chat-error, chat-limited, chat-corrected) are what the
// automated UI test (eval/ui_test_run.cjs) waits for.
function Reply({ turn, i, onRetry, onSearchAsTyped }) {
  const r = turn.result || {};
  if (turn.status === 'working') {
    return (
      <div className="chat-bubble chat-typing" role="status">
        <span>Searching the research and writing a reply</span>
        <span className="chat-dots" aria-hidden="true"><i /><i /><i /></span>
      </div>
    );
  }
  if (turn.status === 'error') {
    return (
      <div className={'chat-bubble stack-3 ' + (turn.limited ? 'chat-limited' : 'chat-error')}>
        <p>{turn.limited || 'I could not get an answer right now. This is a problem on our side, not with your question.'}</p>
        <div className="row-3"><Button onClick={onRetry}>Try again</Button></div>
      </div>
    );
  }
  // Two notes that can both appear (a misspelled follow-up gets both): the spelling correction, with a way to search
  // the words as typed, and the standalone question a follow-up was rewritten into.
  const searched = (
    <>
      {r.correctedQuestion && !turn.detail && (
        <p className="small-muted chat-corrected">
          Showing results for <strong>{r.correctedQuestion}</strong>
          {onSearchAsTyped && (
            <>
              {' · '}
              <button type="button" className="text-link chat-inline-link" onClick={onSearchAsTyped}>
                Search instead for {turn.question}
              </button>
            </>
          )}
        </p>
      )}
      {r.searchedFor && r.searchedFor !== turn.question && r.searchedFor !== r.correctedQuestion && !turn.detail && (
        <p className="small-muted">I searched for: {r.searchedFor}</p>
      )}
    </>
  );
  if (turn.status === 'no_answer') {
    return (
      <div className="chat-bubble stack-2 chat-no-answer">
        {searched}
        <p>I did not find research in our collection that answers this. I would rather say so than guess. Try asking in a different way, or about one thing at a time.</p>
      </div>
    );
  }
  // Each reply numbers its sources from 1, so card ids include the reply's number to keep citation links unique.
  const sourceId = (n) => `chat-source-${i}-${n}`;
  const target = LEVEL_TARGETS[r.level] || LEVEL_TARGETS.plain;
  // Sources start folded. Clicking a citation number opens this reply's sources and scrolls to that study, since a
  // link to a card inside a closed fold would otherwise go nowhere.
  const openCitation = (e) => {
    const link = e.target.closest('a.hl-cite');
    if (!link) return;
    e.preventDefault();
    const fold = e.currentTarget.querySelector('details.sources-fold');
    if (fold) fold.open = true;
    const card = document.getElementById(link.getAttribute('href').slice(1));
    if (card) requestAnimationFrame(() => card.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  };
  return (
    <div className="chat-bubble stack-3 chat-answer" onClick={openCitation}>
      {searched}
      {r.paragraphs.map((p, k) => (
        <p key={k} className="chat-answer-p">
          {p.sentences.map((s, j) => (
            <React.Fragment key={j}>
              {s.text}
              {s.sources.map((n) => <Citation key={n} n={n} href={'#' + sourceId(n)} />)}
              {' '}
            </React.Fragment>
          ))}
        </p>
      ))}
      <div className="chat-meta">
        {r.grade != null && <ReadingLevel grade={Math.round(r.grade)} min={target[0]} max={target[1]} />}
        {r.model && <span className="small-muted">Written by {MODEL_NAMES[r.model] || r.model}</span>}
      </div>
      {/* Every reply's sources start folded, so the answer stays short; one click (or a citation number) opens them. */}
      <details className="sources-fold">
        <summary className="text-link">
          {r.sources.length} {r.sources.length === 1 ? 'study' : 'studies'} this reply used
          {r.live ? ' (searched PubMed directly)' : ''}
        </summary>
        <div className="stack-3">
          {r.sources.map((s) => (
            <SourceCard
              key={s.pmid}
              id={sourceId(s.n)}
              n={s.n}
              title={s.title}
              journal={s.journal}
              date={s.date}
              pmid={s.pmid}
              href={pubmedUrl(s.pmid)}
              us={s.us}
              studyType={s.studyType || undefined}
              live={s.live}
            />
          ))}
        </div>
      </details>
    </div>
  );
}
