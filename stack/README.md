# Xevrion app stack wiring

Copy this folder next to `services\` (see C:\Users\henry\app-stack), fill `.env` from `.env.example` (never commit `.env`).

- `start.ps1 <dify|langfuse|postiz|temporal|steel|daytona|bridge|freellmapi> up|stop` - run one or two at a time (about 5.7 GB for Docker).
- FreeLLMAPI (only LLM): FreeLLMAPI desktop app at http://127.0.0.1:31415/v1 (Dify: http://host.docker.internal:31415/v1 - desktop binds 127.0.0.1 only, see notes), OpenAI-compatible, model `auto`.
- Bridge (FastAPI, port 8765, `Authorization: Bearer $BRIDGE_TOKEN`): `/health`, `/llm`, `/crawl` (Crawl4AI), `/crew/run` (CrewAI on FreeLLMAPI), `/temporal/start`, `/temporal/describe/{id}`. Each call is traced to Langfuse.
- `dify-tools/*.json`: OpenAPI 3 specs to import as Dify Custom Tools (Steel, Daytona, Coolify, Postiz, Kapa, Loops, Cloudflare, GitHub, Temporal trigger via bridge). Dify runs in Docker, so local services use `host.docker.internal`.
- Aider: `.aider.conf.yml` points at FreeLLMAPI through `OPENAI_API_BASE`/`OPENAI_API_KEY` in `.env`.
- Not API-connected: Relume (Figma/Webflow export), Bolt (via this GitHub repo).
