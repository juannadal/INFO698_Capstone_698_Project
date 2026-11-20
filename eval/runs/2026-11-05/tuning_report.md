# Ranking weight tuning: eval/runs/2026-11-05

25 questions, 1771 weight mixes (similarity / keywords / recency / U.S.). Judgments: `eval/judgments.csv`.
Rule: the most recency + U.S. weight whose mean condensed nDCG@10 is within 0.01 of the best.
Check: re-ranking offline with the current weights gives the Worker's top 10 for every question.

| Mix | Weights | nDCG@10 | Condensed nDCG@10 | P@10 | Unrated in top 10 (mean) | Last 5 years | U.S. authors |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Current | 0.50 / 0.25 / 0.15 / 0.10 | 0.807 | 0.807 | 0.880 | 0.0 | 61% | 30% |
| Best for relevance only | 0.85 / 0.00 / 0.15 / 0.00 | 0.843 | 0.843 | 0.924 | 0.0 | 52% | 18% |
| Chosen by the rule | 0.70 / 0.00 / 0.25 / 0.05 | 0.831 | 0.837 | 0.900 | 0.1 | 62% | 22% |

Sensitivity to the tolerance:

| Tolerance | Chosen weights | Condensed nDCG@10 | Last 5 years | U.S. authors |
| --- | --- | --- | --- | --- |
| 0.005 | 0.75 / 0.00 / 0.25 / 0.00 | 0.841 | 60% | 18% |
| 0.01 | 0.70 / 0.00 / 0.25 / 0.05 | 0.837 | 62% | 22% |
| 0.02 | 0.60 / 0.00 / 0.35 / 0.05 | 0.828 | 76% | 23% |

## Leave-one-question-out check

Weights chosen on 24 questions, scored on the 25th (condensed nDCG@10, mean over the 25 held-out questions):

- current weights: 0.807
- the rule: 0.835 (picked the same mix as on all questions in 24 of 25 folds)
- best for relevance only: 0.826

| Held-out question | Rule's weights | Rule | Current |
| --- | --- | --- | --- |
| 1 | 0.60 / 0.00 / 0.35 / 0.05 | 0.775 | 0.817 |
| 3 | 0.70 / 0.00 / 0.25 / 0.05 | 0.913 | 0.771 |
| 4 | 0.70 / 0.00 / 0.25 / 0.05 | 0.926 | 0.930 |
| 5 | 0.70 / 0.00 / 0.25 / 0.05 | 0.953 | 0.873 |
| 6 | 0.70 / 0.00 / 0.25 / 0.05 | 0.953 | 0.926 |
| 8 | 0.70 / 0.00 / 0.25 / 0.05 | 1.000 | 1.000 |
| 9 | 0.70 / 0.00 / 0.25 / 0.05 | 0.531 | 0.531 |
| 10 | 0.70 / 0.00 / 0.25 / 0.05 | 0.855 | 0.763 |
| 11 | 0.70 / 0.00 / 0.25 / 0.05 | 0.921 | 0.888 |
| 12 | 0.70 / 0.00 / 0.25 / 0.05 | 0.889 | 0.884 |
| 14 | 0.70 / 0.00 / 0.25 / 0.05 | 0.897 | 0.814 |
| 15 | 0.70 / 0.00 / 0.25 / 0.05 | 0.910 | 0.902 |
| 16 | 0.70 / 0.00 / 0.25 / 0.05 | 0.704 | 0.723 |
| 17 | 0.70 / 0.00 / 0.25 / 0.05 | 0.819 | 0.826 |
| 18 | 0.70 / 0.00 / 0.25 / 0.05 | 0.899 | 0.899 |
| 19 | 0.70 / 0.00 / 0.25 / 0.05 | 1.000 | 1.000 |
| 22 | 0.70 / 0.00 / 0.25 / 0.05 | 1.000 | 0.967 |
| 25 | 0.70 / 0.00 / 0.25 / 0.05 | 0.580 | 0.559 |
| 26 | 0.70 / 0.00 / 0.25 / 0.05 | 0.786 | 0.789 |
| 27 | 0.70 / 0.00 / 0.25 / 0.05 | 0.930 | 0.782 |
| 28 | 0.70 / 0.00 / 0.25 / 0.05 | 0.738 | 0.695 |
| 31 | 0.70 / 0.00 / 0.25 / 0.05 | 0.857 | 0.778 |
| 32 | 0.70 / 0.00 / 0.25 / 0.05 | 0.683 | 0.676 |
| 33 | 0.70 / 0.00 / 0.25 / 0.05 | 0.766 | 0.721 |
| 34 | 0.70 / 0.00 / 0.25 / 0.05 | 0.578 | 0.658 |

Unrated articles in the top 10 of these mixes: 15 (to_rate.csv). Rate them, then run this again.
