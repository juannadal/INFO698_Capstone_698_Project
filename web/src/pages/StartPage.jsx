// The start page (/): the question box, example questions by topic, and a short "How it works".

import * as React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { QuestionBox, Chip } from '../design/index.jsx';
import { NotMedicalAdvice, SavedNotice, ModelPicker, savedModel, LevelPicker, savedLevel } from './shared.jsx';
import { chatPath } from './conversation.js';

// Example questions per topic. These are design suggestions: replace them with questions the collection answers well.
const TOPICS = {
  Exercise: [
    'Does walking every day help lower blood pressure?',
    'How much exercise do adults over 60 need each week?',
    'Is strength training safe to start after 50?',
  ],
  Diet: [
    'Does a Mediterranean diet help people stay healthy as they age?',
    'Do older adults need more protein?',
    'Does eating less salt help lower blood pressure?',
  ],
  Sleep: [
    'How much sleep do adults over 65 need?',
    'Does poor sleep affect memory as we age?',
    'Does exercise help older adults sleep better?',
  ],
  'Long-term conditions': [
    'Can losing weight help control type 2 diabetes?',
    'Which treatments help knee osteoarthritis pain?',
    'Does exercise help with depression in older adults?',
  ],
  'Healthy lifestyle': [
    'Which habits help people live longer and healthier lives?',
    'Can healthy habits lower the risk of memory loss?',
    'Is it too late to change habits after 60?',
  ],
};

const HOW_IT_WORKS = [
  ['We search the research', "We look through published studies on aging and lifestyle from PubMed, the U.S. National Library of Medicine's database."],
  ['We pick the most useful articles', 'Articles that match your question, are recent, and apply to people in the United States come first.'],
  ['We write an answer', 'You get a clear answer with the study details, and a link to every article it used. Pick a reading level: grade 6-8, high school or college. If we find no research, we say so.'],
];

// Asking a question, or picking an example, opens the chat with that question (src/pages/ChatPage.jsx).
export default function StartPage() {
  const navigate = useNavigate();
  const [topic, setTopic] = React.useState('Exercise');
  // Which model will write the answer; starts at the reader's last choice in this browser.
  const [model, setModel] = React.useState(savedModel);
  // The reading level (grade 6-8, high school or college); starts at the reader's last choice in this browser.
  const [level, setLevel] = React.useState(savedLevel);

  React.useEffect(() => {
    document.title = 'Aging & Lifestyle Research Explorer';
  }, []);

  const submit = (q) => {
    if (q.trim()) navigate(chatPath(q, model, level));
  };

  return (
    <>
      <div className="stack-4">
        <h1 className="title-xl">Ask a question about aging and health</h1>
        <p className="lead">
          Get an answer explained clearly, based on published medical research, then keep the conversation going with follow-up questions. Every answer shows the articles it came from.
        </p>
      </div>

      <div className="stack-2">
        <QuestionBox onSubmit={submit} />
        <LevelPicker value={level} onChange={setLevel} />
        <ModelPicker value={model} onChange={setModel} />
        <SavedNotice />
      </div>

      <section aria-labelledby="try" className="stack-3">
        <h2 id="try" className="title-m">Not sure what to ask? Pick a topic</h2>
        <div className="row-3">
          {Object.keys(TOPICS).map((t) => (
            <Chip key={t} selected={t === topic} onClick={() => setTopic(t)}>{t}</Chip>
          ))}
        </div>
        <div className="link-list" aria-live="polite">
          {TOPICS[topic].map((q) => (
            <Link key={q} to={chatPath(q, model, level)} className="block-link">{q}</Link>
          ))}
        </div>
      </section>

      <section aria-labelledby="how" className="stack-4">
        <h2 id="how" className="title-m">How it works</h2>
        <ol className="how-steps">
          {HOW_IT_WORKS.map(([name, text], i) => (
            <li key={name} className="how-step">
              <span className="how-step-n">Step {i + 1}</span>
              <span className="how-step-name">{name}</span>
              <span className="how-step-text">{text}</span>
            </li>
          ))}
        </ol>
      </section>

      <NotMedicalAdvice text="This tool explains published research to help you learn. Talk with your doctor before you change your care." />
    </>
  );
}
