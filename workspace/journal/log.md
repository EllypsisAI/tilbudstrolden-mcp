# Journal

## [2026-05-18 22:35] Fase 1 plugin-læring: mcp-apps docs konsulteret, alignment-kontradiktion fundet

**Skete:**
- Branch konsolideret: arbejder nu på `claude/agent-native-food-app-Mb6B3`. `claude/organize-and-setup-G534x` slettet (lokalt + remote, sidstnævnte auto via proxy).
- Opdaget tredje branch `origin/claude/agent-native-food-app-9g04a` med ét commit (`feat: add start_onboarding skill-tool`) lavet i parallel session uden alignment-baseline. Bevaret som-er; ingen handling besluttet endnu.
- Verificeret at `mcp-apps` plugin-marketplace er downloaded (`/root/.claude/plugins/marketplaces/mcp-apps/`) men plugin-skills ikke aktive som Agent Skills i denne session. Docs konsulteret direkte fra filsystemet.
- Explore-subagent læste hele plugin: `CLAUDE.md`, `README.md`, `AGENTS.md`, alle `docs/`-filer (overview, quickstart, agent-skills, patterns, authorization, csp-cors, migrate_from_openai_apps, testing-mcp-apps), de fire `SKILL.md` (create-mcp-app, add-app-to-server, convert-web-app, migrate-oai-app), `specification/` og `examples/`.
- Digest skrevet til `workspace/raw/mcp-apps-docs-digest.md` (7 sektioner, ~2300 ord). User holder på alignment-revisionen indtil digesten er læst.

**I forbifarten besluttet / opdaget:**
- **Central kontradiktion mod alignment.md:** Antagelsen "hvert MCP-tool kan returnere data + skill-definition klienten installerer" er forkert. Skills i MCP-paradigmet er Agent Skills installeret én gang via plugin-marketplace, ikke pr. tool-response. Tools returnerer `content` (tekst-fallback), `structuredContent` (data til UI), og `_meta` (fx `viewUUID`). Skills er klient-specifikke (Claude Code skills ≠ ChatGPT custom instructions), så portabiliteten kommer fra stateless tools + backend-state + tekst-fallback, ikke fra tool-returnerede skills.
- **MCP App ≠ MCP-server:** En MCP App er et tool + UI-resource par med `_meta.ui.resourceUri` der peger på en `ui://`-resource hosted renderer i sandboxed iframe (PostMessageTransport, App-class bundle). Vores nuværende repo er en klassisk MCP-server uden UI-lag.
- **`visibility: ["app"]`-mønsteret** er det officielle MCP-mønster for tools UI'et kalder direkte uden modellen ser dem — sandsynlig kandidat til at erstatte vores "skill-styret kald"-ide.
- "Backend som moaten" og "minimal UI" og "klienten er udskiftelig" er **bekræftet** af docs — men via stateless tools + tekst-fallback, ikke via tool-returnerede skills.

**Åbent / næste session:**
- User læser `workspace/raw/mcp-apps-docs-digest.md` og beslutter hvordan alignment.md revideres. Foreslåede sektioner der skal opdateres: "Den centrale designindsigt om skills" + glossar (skill-definition). Decision-record (`workspace/decisions/skills-are-not-tool-payloads.md`) er forslået men ikke skrevet.
- Beslutning om `claude/agent-native-food-app-9g04a`-branchen (lad ligge / slet remote / cherry-pick til reference) — pt. "lad ligge".
- De 7 åbne spørgsmål fra digestens §7 (skill-distribution multi-klient, onboarding-tool form, app-only tools, CSP for Tjek, payment, multi-user hosting, scheduled tasks, image recognition) er endnu ikke adresseret. Tages efter alignment-revision.
- Fase 1 er strengt taget ikke "afsluttet" — Explore-agenten dækkede docs grundigt, men hands-on med `create-mcp-app` / `add-app-to-server` skill kunne være en gangbar fase 1b hvis vi vil føle paradigmet før vi reviderer alignment.

## [2026-05-18 22:17] Alignment-fase afsluttet, plugin-config klar til fase 1

**Skete:**
- Skrev `workspace/alignment.md` (vision, arkitektur-principper, repo-state map, harness, fase 0/1 skitse) baseret på user's idé-dokument og afklaringer i denne session.
- Konfigurerede `mcp-apps` plugin i `.claude/settings.json` på projekt-scope (marketplace: `modelcontextprotocol/ext-apps`).

**I forbifarten besluttet:**
- "Neo" tolkning afklaret: User mente **Neon** (serverless Postgres, Supabase-alternativ), ikke Neo4j (graf-DB). Alignment-doc rettet.
- Nuværende state-storage er **JSON-fil** (`~/.tilbudstrolden.json`), ikke SQLite. Vigtigt at huske ved fremtidig DB-migration scoping.
- Model identifier fjernet fra decision template (per user: ikke nødvendigt for audit trail) - kun `agent: claude` nu.
- Workspace-rod: `/workspace` i repo, så alignment + senere journal/decisions/raw lever sammen og committes.

**Åbent / næste session:**
- Plugin aktiverer først ved ny session. **Næste model skal arbejde mcp-apps plugin-dokumentationen grundigt igennem før teknisk planlægning starter** (fase 1 mål per user).
- Efter plugin-læring: revider `workspace/alignment.md` med nye indsigter, og vælg fase 2 startpunkt. Kandidater: skills-mekanik prototype, backend domænemodel, repo/business-strategi-afklaring, brugerresearch.
- DB-valg er åbent (Neon vs SQLite vs JSON+Docker) - tages efter domænemodel er klar.
- Forhold til original repo (`olgasafonova/tilbudstrolden-mcp`) - fork strategi, license, samarbejde - er ikke afklaret.
- User's "skill-creator plugin" og "frontend design skill" forventes installeret i senere faser når de bliver relevante.
