// The About page (/about): where answers come from, how they are made, what the tool cannot do, and privacy.

import * as React from 'react';
import { Button } from '../design/index.jsx';
import { useNavigate } from 'react-router-dom';

const SECTIONS = [
  ['where', 'Where the answers come from',
    'Answers come from articles in PubMed, the database of medical research run by the U.S. National Library of Medicine. Our collection holds articles about middle-aged and older adults, published from 2016 on. It covers exercise, diet, sleep and healthy living, common long-term conditions such as type 2 diabetes, high blood pressure, heart disease, COPD, arthritis, depression and obesity, and research from internal medicine and family medicine journals.'],
  ['rank', 'How articles are chosen',
    'For each question we look for articles that match it closely. Newer articles and articles that apply to people in the United States come first.'],
  ['write', 'How answers are written',
    'An AI model writes each answer using only the articles shown under it. You choose the reading level: grade 6 to 8 (short, plain language), high school (the default: study sizes and results, with medical terms explained) or college level (full study details and statistics). You can ask follow-up questions under any answer. If we do not find research that answers your question, we tell you instead of guessing.'],
];

// Plain text only. The button is a real link to / but uses navigate() so the app does not reload.
export default function AboutPage() {
  const navigate = useNavigate();

  React.useEffect(() => {
    document.title = 'About this tool · Aging & Lifestyle Research Explorer';
  }, []);

  return (
    <>
      <div className="stack-4">
        <h1 className="title-xl">About this tool</h1>
        <p className="lead">
          This tool helps adults understand published research on aging and lifestyle. It explains what the studies found, in plain language or in more detail, and shows where each answer comes from.
        </p>
      </div>

      {SECTIONS.map(([id, title, text]) => (
        <section key={id} aria-labelledby={id} className="stack-2 prose">
          <h2 id={id} className="title-m">{title}</h2>
          <p>{text}</p>
        </section>
      ))}

      <section aria-labelledby="limits" className="stack-2 prose">
        <h2 id="limits" className="title-m">What this tool cannot do</h2>
        <ul className="list">
          <li>It does not give medical advice and cannot diagnose or treat any condition. Talk with your doctor before you change your care.</li>
          <li>An AI model can make mistakes. Use the links to check the articles yourself.</li>
          <li>Medical research has often included fewer women and fewer people from minority groups. An answer may not apply equally to everyone.</li>
          <li>Because U.S. studies come first, research from other countries may appear lower in the list.</li>
        </ul>
      </section>

      <section aria-labelledby="privacy" className="stack-2 prose">
        <h2 id="privacy" className="title-m">Your privacy</h2>
        <p>You do not need an account. Questions are saved for a University of Arizona student research project and to improve this tool. We remove email addresses and U.S. phone numbers from questions, and we do not save your IP address or browser details. Please do not type your name or other personal details.</p>
      </section>

      <section aria-labelledby="who" className="stack-2 prose">
        <h2 id="who" className="title-m">Who it is for</h2>
        <p>This tool is for adults. It was designed for people aged 40 and older, with large text and simple pages.</p>
      </section>

      <div style={{ display: 'flex' }}>
        <Button variant="primary" href="/" onClick={(e) => { e.preventDefault(); navigate('/'); }}>Ask a question</Button>
      </div>
    </>
  );
}
