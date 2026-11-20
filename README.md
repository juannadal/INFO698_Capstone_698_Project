# AI Health Literacy: An Aging & Lifestyle Research Explorer

A web application that helps patients aged 40 and older understand current medical research on aging and lifestyle health. A person types a health question in everyday words, and the app answers in plain language with a citation to each PubMed article it used.

This is the INFO 698 capstone project (University of Arizona, Fall 2026) for the topic *GenAI Web Application for AI Literacy*.

- **Author:** Juan Nadal
- **Mentor:** Dr. Xiao Hu
- **Status:** Working app, live behind a sign-in at https://aging-lifestyle-research-explorer.juannadal.workers.dev

## Features

1. **Patient Search Interface**: a React page designed for readability (large text, high contrast, WCAG 2.1 AA).
2. **PubMed Harvest & Index Pipeline**: 289,093 articles (2016–2026, adults 40+) on aging and lifestyle, common chronic conditions, and from internal and family medicine journals, with full text for the 123,313 that are open access, stored in Cloudflare D1 and Vectorize.
3. **IR Ranking Model**: combines text relevance (BM25 plus embeddings), recency, and U.S. relevance.
4. **RAG Plain-Language Answers**: answers at a 6th–8th grade reading level, generated with Cloudflare Workers AI, each citing its sources.

## Repository layout

- `worker/`: the Cloudflare Worker that answers questions (`POST /api/ask`) and serves the site. See [worker/README.md](worker/README.md).
- `web/`: the React front end (Vite). See [web/README.md](web/README.md).
- `scripts/`: the offline data pipeline: PubMed harvest, full text, loading Cloudflare, spelling word list, question-log export.
  Its data (several GB) is not in the repo; it is kept in Google Drive.
- `eval/`: test questions, the automated test run, and results.
- `docs/`: the proposal and the [code guide](docs/CODE_GUIDE.md).

## Documentation

- [Code guide](docs/CODE_GUIDE.md): how the parts fit together, and a reading order for code review
- [Code review, 2026-10-11](docs/CODE_REVIEW_2026-10-11.md): findings and fixes
- [Project Proposal & Statement of Work](docs/PROPOSAL.md)

## Disclaimer

This application is for education only. It is not medical advice and does not replace a conversation with a doctor.

## AI usage

The application uses a language model to write plain-language answers, as described in the [AI Usage & Disclosure](docs/PROPOSAL.md#6-ai-usage--disclosure) section of the proposal.
