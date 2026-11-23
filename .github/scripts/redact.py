"""Print FILE with secrets and account-identifying values redacted (D-37).

Usage: redact.py FILE VALUE... > OUT
For https:// URLs the bare hostname is redacted too. Never modifies FILE
(tool outputs may be owned by another user). Exits non-zero on any error, so
callers can refuse to publish anything when redaction didn't happen.
"""

import sys

path, *raw = sys.argv[1:]
values = set()
for value in raw:
    value = value.strip()
    if not value:
        continue
    values.add(value)
    if value.startswith("https://"):
        values.add(value[len("https://") :].split("/", 1)[0])

with open(path, encoding="utf-8") as f:
    text = f.read()
for value in sorted(values, key=len, reverse=True):
    text = text.replace(value, "[redacted]")
sys.stdout.write(text)
