// Aging & Lifestyle Research Explorer: components.
// Styles are in ../bundle.css (classes start with hl-); every colour, space and radius is a token from tokens.css.
import * as React from 'react';

function cx(...parts) {
  return parts.filter(Boolean).join(' ');
}

const CheckIcon = (props) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    <path d="M3 8.5l3.2 3.2L13 5" />
  </svg>
);

const InfoIcon = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v6" />
    <path d="M12 7.5v.5" />
  </svg>
);

const SearchOffIcon = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M15.5 15.5L20 20" />
    <path d="M8 10.5h5" />
  </svg>
);

/** Quiet by default. Primary (brand fill) once per view: the Ask button. Pass href to render a link that looks like a button. */
export function Button({ variant = 'quiet', href, className, children, ...rest }) {
  const cls = cx('hl-btn', 'hl-btn-' + variant, className);
  if (href) {
    return <a {...rest} href={href} className={cls}>{children}</a>;
  }
  return <button type="button" {...rest} className={cls}>{children}</button>;
}

/** Where a person types a health question in their own words. Has a visible label, a hint, and the Ask button. */
export function QuestionBox({
  label = 'Your question',
  hint = 'Use your own words. You do not need medical terms.',
  placeholder = '',
  buttonLabel = 'Ask',
  name = 'q',
  id = 'hl-question',
  value,
  defaultValue,
  onChange,
  onSubmit,
  className,
}) {
  const input = { id, name, type: 'text', className: 'hl-question-input', placeholder, autoComplete: 'off', spellCheck: true, 'aria-describedby': hint ? id + '-hint' : undefined };
  if (value !== undefined) {
    input.value = value;
    input.onChange = (e) => onChange && onChange(e.target.value);
    if (!onChange) input.readOnly = true;
  } else {
    if (defaultValue !== undefined) input.defaultValue = defaultValue;
    if (onChange) input.onChange = (e) => onChange(e.target.value);
  }
  return (
    <form
      className={cx('hl-question', className)}
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        if (onSubmit) onSubmit(e.currentTarget.elements[name].value);
      }}
    >
      <label className="hl-question-label" htmlFor={id}>{label}</label>
      <div className="hl-question-row">
        <input {...input} />
        <Button variant="primary" type="submit">{buttonLabel}</Button>
      </div>
      {hint ? <div className="hl-question-hint" id={id + '-hint'}>{hint}</div> : null}
    </form>
  );
}

/** A toggle for a topic or a study type. Selected shows a check mark as well as a tint. */
export function Chip({ selected = false, className, children, ...rest }) {
  return (
    <button type="button" {...rest} className={cx('hl-chip', className)} aria-pressed={selected ? 'true' : 'false'}>
      <CheckIcon className="hl-chip-check" />
      <span>{children}</span>
    </button>
  );
}

/** The plain-language answer. It comes first on the page, before the sources. Children are the answer's paragraphs, then an optional AnswerFooter. */
export function AnswerCard({ title = 'The short answer', className, children, ...rest }) {
  return (
    <section {...rest} className={cx('hl-answer', className)}>
      <h2 className="hl-answer-title">{title}</h2>
      {children}
    </section>
  );
}

/** The row under an answer, after a hairline: the reading level, a print button. Use it as the last child of AnswerCard. */
export function AnswerFooter({ className, children, ...rest }) {
  return <div {...rest} className={cx('hl-answer-foot', className)}>{children}</div>;
}

/** The numbered marker after a statement in an answer. It links to the matching source card. */
export function Citation({ n, href, className }) {
  // The word joiner keeps the marker on the same line as the full stop before it.
  return (
    <React.Fragment>
      {'\u2060'}
      <a className={cx('hl-cite', className)} href={href || '#source-' + n} aria-label={'Source ' + n}>{n}</a>
    </React.Fragment>
  );
}

/** One source article: its number, title (linked to PubMed), journal, date and PubMed ID. `live` marks an article
 *  found by a live PubMed search rather than in the saved collection. */
export function SourceCard({ n, title, journal, date, pmid, href, us = false, studyType, live = false, id, className }) {
  const meta = [journal, date ? 'Published ' + date : null].filter(Boolean).join(' · ');
  return (
    <article className={cx('hl-source', className)} id={id || (n !== undefined ? 'source-' + n : undefined)}>
      <div className="hl-source-n" aria-label={n !== undefined ? 'Source ' + n : undefined}>{n}</div>
      <div>
        <h3 className="hl-source-title">
          {href ? <a href={href} target="_blank" rel="noopener noreferrer">{title}</a> : title}
        </h3>
        {meta ? <p className="hl-source-meta">{meta}</p> : null}
        <div className="hl-source-foot">
          {us ? <span className="hl-tag">U.S. study</span> : null}
          {studyType ? <span className="hl-tag">{studyType}</span> : null}
          {live ? <span className="hl-tag">Found in a live PubMed search</span> : null}
          {pmid ? <span className="hl-source-pmid">PMID {pmid}</span> : null}
          {href ? <a className="hl-link" href={href} target="_blank" rel="noopener noreferrer">Read it on PubMed {'↗'}</a> : null}
        </div>
      </div>
    </article>
  );
}

/** A calm, always-visible note: "not medical advice", or "no research found". */
export function Notice({ tone = 'info', title, className, children, ...rest }) {
  const Icon = tone === 'empty' ? SearchOffIcon : InfoIcon;
  return (
    <div role="note" {...rest} className={cx('hl-notice', 'hl-notice-' + tone, className)}>
      <Icon className="hl-notice-icon" />
      <div className="hl-notice-body">
        {title ? <p className="hl-notice-title">{title}</p> : null}
        {children}
      </div>
    </div>
  );
}

/** The answer's Flesch-Kincaid grade, beside the target range. */
export function ReadingLevel({ grade, min = 6, max = 8, className }) {
  const n = Number(grade);
  let verdict = null;
  if (Number.isFinite(n)) verdict = n > max ? 'above the target' : n < min ? 'below the target' : 'within the target';
  return (
    <span className={cx('hl-level', className)}>
      <span>Reading level:</span>
      <span className="hl-level-value">grade {grade}</span>
      <span>{verdict ? '(' + verdict + ' of grade ' + min + ' to ' + max + ')' : '(target: grade ' + min + ' to ' + max + ')'}</span>
    </span>
  );
}

/** What is happening while an answer is prepared. One step is current; earlier ones are done. */
export function ProgressSteps({ steps = [], current = 0, className, ...rest }) {
  return (
    <ol {...rest} className={cx('hl-steps', className)} aria-live="polite">
      {steps.map((label, i) => {
        const state = i < current ? 'done' : i === current ? 'current' : 'waiting';
        return (
          <li key={i} className={cx('hl-step', 'hl-step-' + state)} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="hl-step-mark">{state === 'done' ? <CheckIcon /> : null}</span>
            <span>
              {label}
              {state === 'done' ? <span className="hl-sr"> (done)</span> : null}
              {state === 'current' ? <span className="hl-step-status"> {'…'}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
