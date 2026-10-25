# Document parser snapshot for Daytona. Build/register only when PDF/XLSX parsing is needed (snapshot storage may cost credit).
FROM python:3.12-slim@sha256:REPLACE_WITH_PINNED_DIGEST
RUN useradd -m parser
COPY requirements-parser.txt /tmp/
RUN pip install --no-cache-dir -r /tmp/requirements-parser.txt && rm /tmp/requirements-parser.txt
USER parser
WORKDIR /home/parser
