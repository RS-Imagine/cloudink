"""Archive an existing generated website without reconstructing Markdown.

Usage: python scripts/archive-existing.py /path/to/public /private/archive.json
The output contains article content and belongs in private R2, never in Git.
"""
import base64
import datetime
import html
import json
import pathlib
import re
import sys
import uuid

root = pathlib.Path(sys.argv[1])
output = pathlib.Path(sys.argv[2])
index = (root / 'index.html').read_text()
search = json.loads((root / 'search_index.json').read_text())

def grab(pattern, source):
    match = re.search(pattern, source)
    if not match:
        raise ValueError('Existing website structure did not match the renderer.')
    return html.unescape(match.group(1))

hero = grab(r'<section class="hero">([\s\S]*?)</section>', index)
site = {
    'title': grab(r'<title>(.*?)</title>', index),
    'bigTitle': grab(r'<h1>(.*?)</h1>', hero),
    'subtitle': grab(r'<p>(.*?)</p>', hero),
    'author': grab(r'<span class="tag">(.*?)</span>', hero),
    'description': grab(r'<meta name="description" content="(.*?)">', index),
}
posts = []
for item in search:
    slug = item['slug']
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', slug):
        raise ValueError('Unsafe article path.')
    page = (root / 'posts' / slug / 'index.html').read_text()
    body = re.search(r'<p class="meta">[\s\S]*?</p>\s*<div>([\s\S]*?)</div>\s*<div class="share-container"', page)
    if not body:
        raise ValueError('Cannot find article body: ' + slug)
    date_text = grab(r'<article>\s*<div class="meta">(.*?)</div>', page)
    dates = re.findall(r'\d{4}-\d{2}-\d{2}', date_text)
    matter = {'title': item['title'], 'slug': slug, 'date': dates[0], 'description': item['description'], 'draft': False}
    if len(dates) > 1:
        matter['updated'] = dates[1]
    posts.append({'front_matter': matter, 'body_markdown': '', 'body_html': body.group(1), 'body_plain_text': item['body']})
assets = {}
if (root / 'images').exists():
    for path in (root / 'images').rglob('*'):
        if path.is_file():
            assets[path.relative_to(root).as_posix()] = base64.b64encode(path.read_bytes()).decode()
bundle = {'schema_version': 1, 'id': str(uuid.uuid4()), 'created_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'site': site, 'markdown_posts': {}, 'legacy_posts': posts, 'assets': assets}
if (root / 'about' / 'index.html').exists():
    bundle['about_html'] = (root / 'about' / 'index.html').read_text()
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(bundle, ensure_ascii=False))
print(f'Archived {len(posts)} articles and {len(assets)} local images. Markdown originals were not reconstructed.')
