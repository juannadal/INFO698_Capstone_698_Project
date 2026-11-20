"""Print what scripts/harvest_and_chunk.py makes of a PubMed XML file, as JSON, for worker/test/chunk.test.js.

The test compares it with the Worker's JavaScript port (src/pubmed.js parseArticles + src/chunk.js), so the weekly
refresh stores new articles exactly like the harvest stored the collection.

Usage: python3 worker/test/harvest_reference.py worker/test/fixture_pubmed.xml
"""
import json, os, re, sys
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'scripts'))
import harvest_and_chunk as h

doc = re.sub(r'<\?xml[^>]*\?>|<!DOCTYPE[^>]*>', '', open(sys.argv[1], encoding='utf-8').read()).strip()
out = []
for pa in ET.fromstring(doc).iter('PubmedArticle'):
    a = h.parse_article(pa)
    # The same articles chunk() keeps.
    kept = bool(a['abstract_sections']) and not (h.DROP_TYPES & set(a['pub_types']))
    a['kept'] = kept
    a['abstract_tokens'] = h.n_tokens(a['title'] + '\n' + ' '.join(s['text'] for s in a['abstract_sections']))
    a['chunks'] = h.chunk_article(a) if kept else []
    out.append(a)
print(json.dumps(out))
