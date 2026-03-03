#!/usr/bin/env python3
"""
Refactor: Split index.html into style.css and app.js
- Zero logic changes
- Uses raw bytes to preserve UTF-8 emoji characters (448+ in this file)
"""
import sys

HTML_PATH = '/home/runner/work/Neximap/Neximap/index.html'
CSS_PATH  = '/home/runner/work/Neximap/Neximap/style.css'
JS_PATH   = '/home/runner/work/Neximap/Neximap/app.js'

# Read as raw bytes to preserve all UTF-8 characters
with open(HTML_PATH, 'rb') as f:
    raw = f.read()

# Split into lines (split on \n, losing the delimiter — we'll re-join later)
lines = raw.split(b'\n')
print(f'Total lines: {len(lines)}')

# ── Verify expected tags at expected line positions (1-indexed) ─────────────
# Style block
assert lines[31]   == b'  <style>',    f"Line 32:   expected '  <style>',   got: {lines[31]!r}"
assert lines[5603] == b'  </style>',   f"Line 5604: expected '  </style>',  got: {lines[5603]!r}"
# Script block 1
assert lines[9756]  == b'<script>',    f"Line 9757:  expected '<script>',   got: {lines[9756]!r}"
assert lines[52099] == b'</script>',   f"Line 52100: expected '</script>',  got: {lines[52099]!r}"
# Script block 2
assert lines[53024] == b'<script>',    f"Line 53025: expected '<script>',   got: {lines[53024]!r}"
assert lines[53174] == b'</script>',   f"Line 53175: expected '</script>',  got: {lines[53174]!r}"
# Script block 3
assert lines[54173] == b'<script>',    f"Line 54174: expected '<script>',   got: {lines[54173]!r}"
assert lines[55909] == b'</script>',   f"Line 55910: expected '</script>',  got: {lines[55909]!r}"
# Script block 4
assert lines[55910] == b'<script>',    f"Line 55911: expected '<script>',   got: {lines[55910]!r}"
assert lines[55954] == b'</script>',   f"Line 55955: expected '</script>',  got: {lines[55954]!r}"
# Closing tags
assert lines[55955] == b'</body>',     f"Line 55956: expected '</body>',    got: {lines[55955]!r}"
assert lines[55956] == b'</html>',     f"Line 55957: expected '</html>',    got: {lines[55956]!r}"

print("All structural assertions passed.")

# ── Extract CSS ──────────────────────────────────────────────────────────────
# Lines 33–5603 (0-indexed: 32–5602) are the CSS content
css_lines   = lines[32:5603]
css_content = b'\n'.join(css_lines) + b'\n'

with open(CSS_PATH, 'wb') as f:
    f.write(css_content)
print(f'Written style.css : {len(css_content):>10,} bytes  ({len(css_lines)} lines)')

# ── Extract JS (4 blocks) ────────────────────────────────────────────────────
# Block 1 content: lines 9758–52099  (0-idx 9757–52098)
js_block1 = lines[9757:52099]
# Block 2 content: lines 53026–53174 (0-idx 53025–53173)
js_block2 = lines[53025:53174]
# Block 3 content: lines 54175–55909 (0-idx 54174–55908)
js_block3 = lines[54174:55909]
# Block 4 content: lines 55912–55954 (0-idx 55911–55953)
js_block4 = lines[55911:55954]

# Concatenate with a blank line between each block
all_js     = js_block1 + [b''] + js_block2 + [b''] + js_block3 + [b''] + js_block4
js_content = b'\n'.join(all_js) + b'\n'

with open(JS_PATH, 'wb') as f:
    f.write(js_content)
print(f'Written app.js    : {len(js_content):>10,} bytes')
print(f'  Block 1: {len(js_block1)} lines')
print(f'  Block 2: {len(js_block2)} lines')
print(f'  Block 3: {len(js_block3)} lines')
print(f'  Block 4: {len(js_block4)} lines')

# ── Build new index.html ─────────────────────────────────────────────────────
#
#  Keep:  lines[0:31]          lines 1–31    (preamble, before <style>)
#  Add:   link tag                           (replaces entire style block)
#  Keep:  lines[5604:9756]     lines 5605–9756  (</head> + body HTML until script 1)
#  (skip script block 1: lines 9757–52100)
#  Keep:  lines[52100:53024]   lines 52101–53024 (Financial Settings Modal)
#  (skip script block 2: lines 53025–53175)
#  Keep:  lines[53175:54173]   lines 53176–54173 (Cable Visor Panel + About Modal)
#  (skip script blocks 3 & 4: lines 54174–55955)
#  Add:   <script src="app.js"></script>
#  Keep:  lines[55955:]        lines 55956+  (</body>, </html>)

new_lines = (
    lines[0:31]
    + [b'  <link rel="stylesheet" href="style.css">']
    + lines[5604:9756]
    + lines[52100:53024]
    + lines[53175:54173]
    + [b'<script src="app.js"></script>']
    + lines[55955:]
)

new_content = b'\n'.join(new_lines)

# ── Sanity checks ────────────────────────────────────────────────────────────
# 1. No standalone <style> block remaining
assert b'  <style>' not in new_content, \
    'ERROR: standalone <style> block still found in new index.html!'
# 2. External CSS link present
assert b'<link rel="stylesheet" href="style.css">' in new_content, \
    'ERROR: CSS link tag not found in new index.html!'
# 3. External JS script present
assert b'<script src="app.js"></script>' in new_content, \
    'ERROR: app.js script tag not found in new index.html!'
# 4. No inline <script> blocks (only <script src=...> allowed)
# Count occurrences of standalone <script> (not <script src= or <script type=)
import re
inline_script_tags = re.findall(rb'<script>(?!\s*</script>)', new_content)
assert len(inline_script_tags) == 0, \
    f'ERROR: {len(inline_script_tags)} inline <script> blocks found!'
# 5. File should be shorter (removed CSS + JS content)
assert len(new_content) < len(raw), \
    f'ERROR: new file ({len(new_content)}) is not smaller than original ({len(raw)})!'

print("All sanity checks passed.")
print(f'Original index.html : {len(raw):>10,} bytes')
print(f'New      index.html : {len(new_content):>10,} bytes')

# ── Write new index.html ─────────────────────────────────────────────────────
with open(HTML_PATH, 'wb') as f:
    f.write(new_content)

print('Written new index.html successfully.')
print('Done!')
