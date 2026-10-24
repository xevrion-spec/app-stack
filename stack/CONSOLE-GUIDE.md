# Xevrion Stack Console (Dify) – guide

Open http://localhost:8080 → Studio → **Xevrion Stack Console**.
Before using it: `.\start.ps1 dify up`, `.\start.ps1 bridge up`, keep the FreeLLMAPI desktop app open. Start Langfuse/Steel/Temporal only when needed (max two Docker apps besides Dify).
Destructive, public or email-sending actions (deletes, publishing posts, deploys, sending Loops email/events) only run after you say "yes, confirm" in the chat.

| App | Example prompts |
|---|---|
| GitHub | "List the branches of xevrion-spec/app-stack." · "Show open issues." · "Draft an issue titled X" (creating it needs confirm) |
| Cloudflare | "List my Workers scripts." · "List Pages projects and their latest deployments." · "List DNS records for zone <id>." |
| Coolify | "What Coolify version am I on?" · "List my projects and applications." · "Deploy app <uuid>" (needs confirm) |
| Daytona | "List my sandboxes." · "Create a Python sandbox called test-box." · "Stop sandbox X." |
| Steel (start steel first) | "Check Steel health / list sessions." · "Scrape https://example.com as markdown." · "Screenshot https://xevrion.com." |
| Postiz | "List my connected social channels." · "Draft a post for channel X saying …" (scheduling/publishing needs confirm) |
| Loops | "Check the Loops API key." · "Find contact jane@x.com." · "Add contact …" · sending email/events needs confirm |
| Kapa | "Ask Kapa: how do I get started?" (needs a valid KAPA_PROJECT_ID) |
| Langfuse (start langfuse) | "List the latest traces/observations." · "List prompts." · "Create a prompt named outreach-v1 with text …" |
| Temporal (start temporal) | "Start workflow <Type> on task queue <q> with args …" · "Describe workflow <id>." |
| Crawl4AI | "Crawl https://example.com and summarise it." |
| CrewAI | "Run the research crew on topic 'AI agents for SMB sales'." |
| Local apps | "Which containers are running?" · "Start steel." · "Stop temporal." (stopping Dify needs confirm) |
| Anything else | "Call the Coolify API GET /servers" – the stack-admin `serviceApi` tool reaches any documented endpoint. |

Re-sync tools after changing keys in .env: `bridge\.venv\Scripts\python.exe difysetup.py tools`.
Test all tools without the LLM: `difysetup.py toolstest`.
App API: `POST http://localhost:8080/v1/chat-messages` with `Authorization: Bearer $DIFY_API_KEY`.
