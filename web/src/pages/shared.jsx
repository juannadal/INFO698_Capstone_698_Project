// Small pieces used on more than one page: the not-medical-advice notice, the note that questions are saved, and the
// "Answer written by" menu that picks the answer model.

import * as React from 'react';
import { Notice } from '../design/index.jsx';

/** The notice under every answer (and on the start page). It cannot be dismissed. */
export function NotMedicalAdvice({ text = 'This answer explains published research to help you learn. Talk with your doctor before you change your care.' }) {
  return (
    <Notice title="This is not medical advice.">
      <p>{text}</p>
      <p>If you have a medical emergency, call 911.</p>
    </Notice>
  );
}

// The Worker's settings from /api/config, fetched once per page load: whether it saves questions (LOG_QUESTIONS) and
// which answer models it offers. Only an explicit "false" hides the saved-questions notice; if the request fails or
// the reply is odd, the notice stays, because questions may still be saved, and only Llama is offered.
let logQuestions = null;
let models = ['llama'];
const loaded = fetch('/api/config').then((r) => r.json()).then((c) => {
  logQuestions = c.logQuestions !== false;
  if (Array.isArray(c.models) && c.models.length) models = c.models;
}).catch(() => { logQuestions = true; });

/** Under the question box, only when questions are saved: they are saved without anything that identifies the reader.
 *  Shown until /api/config says saving is off, so a question asked straight from a link (/chat?q=...) is never saved
 *  before the notice appears. */
export function SavedNotice() {
  const [show, setShow] = React.useState(logQuestions ?? true);
  React.useEffect(() => { loaded.then(() => setShow(logQuestions)); }, []);
  if (!show) return null;
  return <p className="small-muted">We save questions, without anything that identifies you, for university research and to improve this tool.</p>;
}

// The answer models, in the words the menu shows. Llama is first because it is the default.
export const MODEL_NAMES = {
  llama: 'Llama 3.3 (Meta, on Cloudflare)',
  claude: 'Claude (Anthropic)',
  grok: 'Grok (xAI)',
};
// Every model name the page knows; anything else in a link or in storage means Llama.
export function toModel(m) {
  return m in MODEL_NAMES ? m : 'llama';
}

// The reader's last choice in the menu, kept in this browser only, so the start page remembers it. Storage can be
// blocked (private windows), so every read and write is wrapped and the default is Llama.
export function savedModel() {
  try { return toModel(localStorage.getItem('answerModel')); } catch { return 'llama'; }
}
function saveModel(model) {
  try { localStorage.setItem('answerModel', model); } catch { /* not saved; the menu still works */ }
}

// The reading levels, easiest first, in the words the "Reading level" menu shows (rules in worker/src/levels.js).
// High school ('detailed') is the page's default since 2026-11-06, after Dr. Hu's feedback that answers should be
// more complex; grade 6-8 (the proposal's original target) and college level are one click away.
export const LEVEL_NAMES = {
  plain: 'Grade 6-8 (plain language, short)',
  detailed: 'High school (more detail, terms explained)',
  college: 'College level (full study details and statistics)',
};
// The grade range each level aims for, for the reading-level badge under the answer.
export const LEVEL_TARGETS = { plain: [6, 8], detailed: [10, 12], college: [13, 16] };
export const DEFAULT_LEVEL = 'detailed';
// A level from a URL or storage, or the default when it is missing or unknown.
export function toLevel(v) {
  return Object.hasOwn(LEVEL_NAMES, v || '') ? v : DEFAULT_LEVEL;
}

// The reader's last "Reading level" choice, kept in this browser only (like the model menu).
export function savedLevel() {
  try { return toLevel(localStorage.getItem('answerLevel')); } catch { return DEFAULT_LEVEL; }
}
function saveLevel(level) {
  try { localStorage.setItem('answerLevel', level); } catch { /* not saved; the menu still works */ }
}

/** "Reading level": grade 6-8, high school (the default) or college level. Always shown, since every level works
 *  with either model. value is 'plain', 'detailed' or 'college'; onChange gets the new value. */
export function LevelPicker({ value, onChange }) {
  return (
    <div className="model-picker">
      <label htmlFor="answer-level" className="model-picker-label">Reading level</label>
      <select
        id="answer-level"
        className="model-picker-select"
        value={toLevel(value)}
        onChange={(e) => { saveLevel(e.target.value); onChange(e.target.value); }}
      >
        {Object.entries(LEVEL_NAMES).map(([k, name]) => <option key={k} value={k}>{name}</option>)}
      </select>
    </div>
  );
}

/** "Answer written by": a menu to pick which AI model writes the answer. Shown only when the site offers more than
 *  one model (Claude and Grok need their API keys on the Worker). value is 'llama', 'claude' or 'grok'; onChange gets the new value. */
export function ModelPicker({ value, onChange }) {
  const [offered, setOffered] = React.useState(models);
  React.useEffect(() => { loaded.then(() => setOffered(models)); }, []);
  if (offered.length < 2) return null;
  return (
    <div className="model-picker">
      <label htmlFor="answer-model" className="model-picker-label">Answer written by</label>
      <select
        id="answer-model"
        className="model-picker-select"
        value={offered.includes(value) ? value : 'llama'}
        onChange={(e) => { saveModel(e.target.value); onChange(e.target.value); }}
      >
        {offered.map((m) => <option key={m} value={m}>{MODEL_NAMES[m] || m}</option>)}
      </select>
    </div>
  );
}

// Earlier answers' sources are folded away (<details class="sources-fold">), and a browser does not print a closed
// one. This opens them all while printing, so a printout has every answer with its sources, then closes the ones that
// were closed. Used by the chat page.
export function usePrintOpensSources() {
  React.useEffect(() => {
    let opened = [];
    const before = () => {
      opened = [...document.querySelectorAll('details.sources-fold:not([open])')];
      opened.forEach((d) => { d.open = true; });
    };
    const after = () => opened.forEach((d) => { d.open = false; });
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
    return () => {
      window.removeEventListener('beforeprint', before);
      window.removeEventListener('afterprint', after);
    };
  }, []);
}
