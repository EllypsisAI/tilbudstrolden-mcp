# Alignment-dokument: Agent-native mad app

## Context

Dette er det kanoniske alignment-dokument for projektet — vision, arkitektur, terminologi, repo-state og arbejdsmetodologi ét sted. Det er PRD-ækvivalenten i vores hybrid spec-driven workflow (se `decisions/per-phase-spec-workflow.md`).

Dokumentet er et levende artefakt. Når en sektion ændrer sig (fordi vi har lært noget eller låst en beslutning), opdateres den. Beslutninger der er auditerbare (skill-mekanisme, DB-valg, arkitekturlag) får deres egne filer i `workspace/decisions/` med tradeoffs og alternativer — alignment-doc'et opsummerer outputtet.

### Hvor vi er

- **Fase 0 (alignment): done.** Vision + arkitektur-skitse lagt fast 2026-05-18.
- **Fase 1 (plugin/learning): done.** mcp-apps-marketplace gennemlæst direkte (plugin loadede ikke som Agent Skills). Digest i `workspace/raw/mcp-apps-docs-digest.md`. To kerne-antagelser i alignment-doc'et blev korrigeret som følge.
- **Station 1 (hosting + DB): done 2026-05-22.** Spec: `workspace/specs/01-hosting-and-db.md`. Decisions: `decisions/hosting-model.md` (central-hosted multi-tenant), `decisions/db-choice.md` (Postgres everywhere — Neon prod, docker-compose lokalt).
- **Tool-design metodologi: locked 2026-05-24.** `decisions/tool-design-methodology.md` — hver tool designes via dual POV (operating agent + end user); arketype (agent-driven / server-beriget / server-deterministisk) emerger pr tool, ikke som global default. Påvirker roadmap-stations 5, 7 og 8 (meal-log og suggest_meals omformuleret).
- **Station 2 (backend domain + migration): done 2026-05-24.** Drizzle + RLS + JSONB-for-bounded-embeds, JSON-importer one-off.
- **Station 3 (auth + multi-user identity): done 2026-05-24.** WorkOS AuthKit som authorization server (`decisions/auth-provider.md`); vi som resource server validerer JWTs (jose, RFC 8707 audience). Identity → tenant via `users` table, race-safe atomic seed-or-lookup. Per-request tenant scope via `AsyncLocalStorage` så de eksisterende store-funktioner virker uændret. Streamable HTTP runner stateless (fresh transport per request). 273 tests passing.
- **Næste:** Roadmap-station 4 (MCP App skeleton + første View). Co-writes som spec lige før eksekvering.

---

## Vision (kanonisk formulering)

**Premise:** Samme kerne-funktionalitet som SaaS dør i bunken. Samme kerne-funktionalitet som agent-native app overlever. Brugeren installerer ikke en app — de installerer en connector/MCP i deres AI-klient (Claude, ChatGPT).

**Mål:** En agent-native mad-app der hjælper husstande med at spise godt og billigt ved at fjerne friktionen i madplanlægning, logning og indkøb. Agenten gør arbejdet. Brugeren uploader et billede af måltidet eller bare svarer på et spørgsmål — resten er automatisk.

**Hvorfor mad-apps fejler i dag:** Manglende menneskelig disciplin pga. høj friktion. Manuel logning, manuel pantry-opdatering, manuel ingrediens-indtastning. Agent-native fjerner det friktion-bjerg.

**Eksempel-flow:**
- Bruger uploader billede af måltid → agent gætter ingredienser → spørger hvor mange spiste → logger til backend → opdaterer pantry.
- Agent finder tilbud i brugerens top-3 butikker → krydsrefererer med pantry → forslår måltider → genererer indkøbsliste.

**Distribution:** Lille start. DM til venner, familie, bekendte. Distribution er svær, men ikke sværere end andre apps.

**Pricing:** Forbrugsbaseret, ikke abonnement. Matcher Tjek API. Markup ovenpå pr. forbrug.

**Retention:** Appen lærer husstanden. På sigt kører scheduled tasks det meste af arbejdet automatisk.

---

## Arkitekturprincipper

### Fire lag

| Lag | Ansvar |
|-----|--------|
| **MCP** | Capabilities. Hvad agenten *kan* udføre. Stateless tools (model-visible og app-only). |
| **Skills** | Klient-side protokoller. *Hvornår* og *hvordan* agenten skal handle. Distribueret tieret via tool-content (Tier 1-3, se `decisions/skill-distribution-tiered.md`). |
| **Backend** | Per-bruger state. Pantry, allergier, præferencer, historik, log. Moaten. |
| **UI** | To overflader: in-chat MCP App View (read + interaktive primitiver) og out-of-band web UI (kun til credentials og payment). |

### Vi er en MCP App, ikke en klassisk MCP-server

Beslutning: `decisions/mcp-app-vs-classic-server.md`.

Tekst-only chat dræber mad-apps — text walls får brugere til at churne. Tekst er sekventiel kommunikation (én part taler ad gangen); UI er parallel (brugeren ser sin pantry mens agenten taler). Vi bygger derfor som MCP App: tools registreres med `_meta.ui.resourceUri` der peger på en `ui://`-resource, host renderer i sandboxed iframe, View'et kommunikerer bidirektionalt via PostMessageTransport.

Konkrete UI-anvendelser:
- Billed-upload (måltid, kvittering) vises og bekræftes mens agenten analyserer.
- Pantry-edit (tjek/uncheck ingredienser) uden tekst-beskrivelse.
- Indkøbsliste som live UI-element der opdaterer mens serveren optimerer.
- Interaktiv bekræftelse af forslag (én round-trip i stedet for tekst-ping-pong).

Graceful degradation er obligatorisk: hosts uden UI-kapabilitet får tekst-fallback via `content`-arrayet, og funktionen er stadig komplet.

### To UI-overflader

1. **In-chat MCP App View.** Embedded i agent-konteksten. Til visualisering, billed-upload, pantry-edit, live indkøbsliste, interaktiv bekræftelse. Bundlet HTML/JS via Vite + `vite-plugin-singlefile`. CSP-deklareret per resource.
2. **Out-of-band web UI.** Brugeren ankommer via signed link. Kun til ting agenten ikke kan udføre selv: credentials og payment. Holdes minimal — én side per intent.

UI skriver aldrig direkte til backend. Alle writes går gennem tool-kald (model-visible eller app-only).

### Intelligence-laget: tre tools-niveauer

Beslutning: `decisions/three-layer-tool-architecture.md`.

| Lag | Synlighed | Brug | Eksempler |
|-----|-----------|------|-----------|
| **A — Model-visible** (`visibility: ["app","model"]`) | Agenten + UI | Få (4-6), semantisk rige kapabiliteter | `start_onboarding`, `suggest_meals`, `log_meal`, `plan_shopping`, `manage_household` |
| **B — App-only** (`visibility: ["app"]`) | Kun UI | Polling, chunking, interaktive primitiver | `poll_image_analysis`, `get_recipe_chunk`, `confirm_pantry_changes`, `request_payment_session` |
| **C — Internt** | Ingen MCP-eksponering | Ren TypeScript-orchestration | Tjek-cache, embedding-similarity, scoring-pipeline, retry-logik, optimering |

Det er hvad der skiller en agent-native app fra en tools-bag. I dag har vi 18 model-visible tools — agenten vælger trin for trin og kan slude. Efter konsolidering vælger agenten mellem 4-6 kapabiliteter; serveren leverer data, compounding og orkestrering hvor det giver mening — men *hvor reasoning bor* afgøres pr tool, ikke globalt. Compounding-værdi (Tjek-cache, scoring) bor i lag C og høster afkast hver gang lag A/B kalder den.

**Hvor reasoning bor pr tool.** Tre-lags-modellen besvarer "hvilke tools ser hvem?" Den besvarer ikke "hvor bor reasoning?". Det gør `decisions/tool-design-methodology.md`: hver tool designes via dual POV (operating agent + end user) før vi vælger arketype — **agent-driven** (tool er dum sink/source; agenten ræsonnerer via skill + native capabilities), **server-beriget** (tool returnerer rig scoret kontekst som agenten ræsonnerer over), eller **server-deterministisk** (tool returnerer "svaret"; sjælden, kræver eksplicit begrundelse). Hybrid er den emergente form af systemet, ikke en strategi vi vælger. Eksemplerne i tabellen ovenfor (`suggest_meals`, `log_meal`, m.fl.) er kapabilitets-navne — deres faktiske model afgøres ved tool-design, ikke her.

### Skill-distribution: tieret med user-permission gate

Beslutning: `decisions/skill-distribution-tiered.md`.

MCP-spec'en har ikke et felt der automatisk distribuerer skills via tool-responser. Vi bygger derfor en *konvention* oven på spec'en: tool-responsens tekst-indhold kan indeholde skill-instruktion som klient-agenten følger — men kun efter eksplicit brugerautorisation.

| Tier | Klient | Mekanisme |
|------|--------|-----------|
| 1 | Claude Code, Claude Desktop m. fs-MCP | Tool returnerer skill-content med fed-tekst permission-gate ("DO NOT create this skill unless the user has explicitly authorized it") + reasoning. Klient-agenten spørger bruger, skriver derefter til `~/.claude/skills/...`. |
| 2 | Claude.ai web, ChatGPT med custom instructions | Tool returnerer copy-pasteable tekst. Brugeren udfører action, agenten guider. |
| 3 | Alt andet | Tekst-fallback. Ingen klient-side personalisering. Funktionen virker fuldt ud via tools. |

Permission-gate er **mitigation for prompt injection**: instruktionen "skriv en fil" bliver til "bed brugeren om lov til at skrive en fil". Sidstnævnte er user-mediated handling, ikke fjernkilde-injection. Det gør konstruktionen robust over for fremtidige hardenings af klient-Claude's injection-modstand.

### Onboarding er et tool, ikke en prompt

Klienten kalder `start_onboarding` på første interaktion. Toolet returnerer: (a) data nødvendig for første touchpoint (husstand-skabelon, default-præferencer), (b) tekst-instruktioner til agenten om næste skridt (auth, payment, første interaktion), (c) skill-content med permission-gate hvis klienten er tier 1.

Det er *ikke* en skill-payload spec'en parser automatisk — det er konvention via tool-content. Se skill-decision for detaljer.

### Backend er moaten

State lever i backend. Klienten er udskiftelig. Brugeren skifter mellem Claude og ChatGPT uden at miste sin pantry eller historik.

**Portabilitet kommer fra:** stateless tools + tekst-fallback (tier 3) + backend som sandhedskilde. **Ikke fra** tool-returnerede skill-definitioner (det misforstod alignment-doc'et oprindeligt — se phase-1-digest §6c).

Skills i tier 1/2 er enhancement, ikke krav. Tier 3 har fuld funktionalitet — bare med flere afklarende spørgsmål per session fordi agenten ikke har præferencer i sin kontekst.

---

## Domæneglossar

- **Klient:** AI-agent brugeren bruger (Claude, ChatGPT, andet). Operer vores MCP og installerer evt. vores skills.
- **MCP-server:** Vores server der eksponerer tools. Det vi koder.
- **MCP App:** En MCP-server der eksponerer tools med UI-metadata (`_meta.ui.resourceUri`). Det vi bygger.
- **View:** UI'et der renderes i klient-host'ens sandboxed iframe. Bundled HTML/JS med App-klasse og PostMessageTransport.
- **Tool, model-visible:** Tool agenten ser og kan kalde. Lag A i tre-lags-modellen.
- **App-only tool:** Tool med `visibility: ["app"]` — skjult fra modellen, kun kaldbart fra View. Lag B.
- **Skill:** Klient-side instruktion-sæt der definerer hvornår/hvordan klienten bruger vores tools. Distribueret tieret via tool-content med permission-gate.
- **Backend:** Hosted database + API der holder per-bruger state. Kilden til sandhed.
- **Husstand:** Den primære domæne-entitet. Personer, allergier, butikspræferencer, default-portioner.
- **Pantry:** Liste af ingredienser brugeren allerede har. Ekskluderes fra indkøbslister.
- **Touchpoint:** Brugerens første kontakt med appen efter installation. Etablerer baseline-data.

---

## Repo state: TilbudsTrolden MCP

### Hvad findes (cornerstones)

**18 MCP tools** dækker alle 6 vision-kapabiliteter, men alle som klassisk MCP — ingen UI-lag, alle model-visible:
- Deals: `search_deals`, `get_store_offers`, `list_stores`, `deals_this_week`
- Recipes: `get_recipes`, `add_recipe`, `remove_recipe`
- Household: `get_household`, `update_household`
- Pantry: `get_pantry`, `update_pantry`
- Log: `log_meal`, `get_meal_history`, `log_spend`, `get_spend_log`
- Planning + shopping: `score_recipes`, `generate_shopping_list`, `plan_and_shop`

**3 MCP prompts:** `getting-started`, `meal-plan`, `deal-scout`.

**Tjek API integration** (`src/api.ts`): 3-retry exponential backoff, 8s timeout, 4 concurrent requests max, in-memory dealer cache for DK, multi-country (DK/NO/SE/FI), public API uden auth. **Det her er candidate-kode for lag C** i den nye arkitektur.

**Datamodel** (`src/store.ts`): Zod-valideret schema. Entities: Household, Pantry, Recipe, Ingredient, MealLogEntry, SpendLogEntry. Atomic read-modify-write via mutex.

**Storage:** Single JSON-fil i `~/.tilbudstrolden.json` (konfigurerbar via `TILBUDSTROLDEN_DATA` env var). Ikke SQLite. Migration når DB-valg er truffet.

**Build:** TypeScript ES2022, Node ≥18, vitest tests, biome lint, tsx watch dev.

### Hvad mangler vs vision (post-fase-1)

| Gap | Kategori |
|-----|----------|
| MCP App-arkitektur | Hele UI-laget. Bundled HTML/JS, App-klasse, PostMessageTransport, CSP-deklarationer. |
| Tre-lags tool-konsolidering | De 18 tools skal kollapse til 4-6 model-visible + app-only primitiver. Lag C bygges som internt TypeScript. |
| Onboarding-tool | Kun en prompt (`getting-started`) i dag. Skal være tool der returnerer data + skill-content (tier 1) + tekst-instruktioner. |
| Hosted backend | Lokal JSON i dag. Ingen cloud, ingen multi-device. DB-valg åbent. |
| Multi-user / auth | Single husstand pr. fil. Ingen accounts. |
| Skill-distribution mekanisme | Tools returnerer kun data i dag. Tier 1/2/3 + permission-gate skal implementeres. |
| Payment/billing | Ingen Stripe-integration, ingen subscription/usage state. |
| Scheduled tasks | Ingen job scheduler. Hvor de lever afhænger af hosting-model. |
| Image recognition | Ingen billed-analyse. Spec-noten "file-uploads not yet implemented" gør pattern usikkert. |
| Notifications | Ingen aktiv alerting. |

### Repo-strategi (åbent)

Vi er pt. i en kopi/fork af `olgasafonova/tilbudstrolden-mcp` på branch `claude/agent-native-food-app-Mb6B3`. Forholdet til original-repo (samarbejde, fork, license, egen rewrite) er ikke afklaret — tages op før vi laver substantielle ændringer.

**Sidetracks at huske:**
- `claude/agent-native-food-app-9g04a` (remote): én commit der implementerede `start_onboarding`-tool i parallel session uden alignment-baseline. Evalueres separat ved roadmap-stage "onboarding-tool" — cherry-pick, omskriv eller drop.

---

## Arbejdsmetodologi

### Roller

- **User + Claude:** Leads og main. Bevidste beslutninger træffes her.
- **Subagents:** Delegerede arbejdsenheder. Bruges til parallel exploration, isoleret implementering, code review.
- **Disciplin:** Multi-fase projekt, ikke one-shot. Hver fase har klar afgrænsning og verifikation før næste starter.

### Hybrid workflow: spec per fase

Beslutning: `decisions/per-phase-spec-workflow.md`.

Fem primitiver — alle versioneret med koden:

| Primitive | Rolle |
|-----------|-------|
| `workspace/alignment.md` | Dette dokument. PRD-ækvivalent. |
| `workspace/roadmap.md` | Ordnede stationer til launch + hvorfor. |
| `workspace/decisions/<slug>.md` | Auditerbare beslutninger med tradeoffs og alternativer. |
| `workspace/specs/<phase>.md` | Per-fase co-written spec. 1-2 sider. Frosset under eksekvering. |
| `workspace/journal/YYYY-MM-DD.md` | Daglig session-log. H2 per session. |

**Workflow per fase:**
1. **Co-write fase-spec** (user + Claude). Låsepunktet.
2. **Execute.** Kode + delegerede subagents. Beslutninger der dukker op fanges i `decisions/`. Daglig progress i `journal/`.
3. **Wrap.** Verificer mod spec-acceptance. Opdater `alignment.md` hvis kerne-antagelser shiftede. Marker fasen done i roadmap.
4. **Næste fase.**

**Session-start (ny Claude):**
Læs alignment + seneste 3-5 dages journal + alle decisions + nuværende spec hvis en fase er under eksekvering. ~10 minutter til fuld orientering.

### Plugins / skills vi anvender

| Plugin | Status | Formål |
|--------|--------|--------|
| mcp-apps (modelcontextprotocol/ext-apps) | Konsulteret (fase 1) | Plugin loadede ikke som Agent Skills. Marketplace-docs læst direkte. Digest: `workspace/raw/mcp-apps-docs-digest.md`. |
| Neon plugin | Pending | Installeres hvis/når Neon vælges som DB. Serverless Postgres-mønstre, branching, queries. |
| skill-creator plugin | Pending | Når vi skriver vores første skills. Skill-distributions mekanik. |
| frontend design skill | Pending | Når UI-laget rammer Vite-pipeline. Minimal UI komponenter. |

**DB-valg: locked 2026-05-22 — Postgres everywhere.** Neon serverless Postgres i prod, docker-compose Postgres lokalt. Rationale, tradeoffs og forkastede alternativer (SQLite-in-Docker, behold JSON+Docker, Supabase, PlanetScale, NoSQL) i `decisions/db-choice.md`.

### Workspace primitiver

Per user's harness — alle primitiver er optional, vi tilføjer dem når arbejdet kalder på det. Tom mappe oprettes ikke preemptively.

- **`raw/`:** Immutable inputs. Markdown, transkripter, PDFs, link dumps. Provenance i tilhørende journal-entry.
- **`journal/`:** En markdown-fil per dag, navngivet `YYYY-MM-DD.md` (ISO-format så `ls` sorterer kronologisk). Sessions inden for samme dag er H2-sektioner: `## [HH:MM] {topic}`. Hvis flere distincte sessions samme dag har brug for separat reference, suffix med `-{topic}` (fx `2026-05-19-ui-quirks.md`). Andre docs kan pege på en bestemt dato for kontekst.
- **`decisions/`:** AgDR-style records, en fil per beslutning. Frontmatter + body. Bruges når en beslutning skal være auditerbar senere.
- **`specs/`:** Per-fase specs. Oprettes når vi går i gang med en roadmap-station.

**Decision template:**

```
---
type: decision
date: YYYY-MM-DD
agent: claude
timestamp: YYYY-MM-DDTHH:MM:SSZ
status: proposed | accepted | superseded
tags: [decision, ...]
---

# {Decision title}

## Context

What situation prompted this decision? What constraints, signals, or events made it necessary?

## Concern

What problem or risk are we trying to address?

## Decision

What we are deciding to do, and what we are deciding NOT to do.

## Goal

What we expect this decision to achieve.

## Tradeoffs accepted

What we are giving up by choosing this option.

## Alternatives considered

- {Option A}: why not chosen.
- {Option B}: why not chosen.

## Supersedes / superseded by

If this decision replaces an earlier one, link it. If it gets replaced later, update `status: superseded` and link forward.
```

---

## Faser

- **Fase 0 (done, 2026-05-18):** Alignment-dokument. Vision + arkitektur-skitse låst.
- **Fase 1 (done, 2026-05-18):** Plugin/learning. mcp-apps-docs gennemlæst direkte. To kerne-antagelser korrigeret (skill-distribution + tre-lags arkitektur identificeret). Digest i `raw/`.
- **Fase 2+:** Defineret af `workspace/roadmap.md`. Hver station co-writes som spec lige før eksekvering.

---

## Åbne spørgsmål (post-fase-1)

Fanget fra phase-1-digesten. Bliver afklaret som de bliver relevante for roadmap-stationer:

1. ~~**Multi-bruger hosting**~~ — **lukket 2026-05-22** med `decisions/hosting-model.md`: central-hosted multi-tenant.
2. ~~**Scheduled tasks placement**~~ — **lukket 2026-05-22** som side-effect af hosting-beslutningen: scheduled tasks lever på vores server. Konkret scheduler-mekanisme (Neon scheduled queries / external cron / agent-poll) udskudt til roadmap-station 8 eller 11.
3. ~~**Image recognition:**~~ — **lukket 2026-05-24** med `decisions/tool-design-methodology.md`: meal-log-pathen løses ved host-multimodal + skill-protokol, ikke server-side vision pipeline. mcp-apps file-uploads-gap er derfor moot for denne use-case. Forbliver åbent kun hvis fremtidige use-cases (fx kvittering-OCR) kræver billedbytes server-side.
4. **Repo-strategi vs upstream.** Fork, license, samarbejde med `olgasafonova/tilbudstrolden-mcp`. Afklares før substantielle ændringer.
5. **CSP for Tjek API:** Hvis View kalder Tjek direkte, må domænet declares i `connectDomains`. Sandsynligvis bedre at View kalder server-tool der kalder Tjek (lag C cache + retry).
6. **Payment-flow:** UI initierer Stripe-session via app-only tool → server returnerer signed checkout URL → bruger gennemfører i out-of-band web UI → webhook opdaterer backend-state.
7. **Skill-tier-detektering:** Klient-side gætværk (host-context hvis tilgængelig, ellers default tier 1 og lad agenten falde til tier 2/3).

---

## Verifikation

Dokumentet er valideret når:

1. User læser dokumentet i sin helhed og bekræfter at vision, arkitektur og repo-state er kanonisk korrekt.
2. De fire låste decisions (`decisions/mcp-app-vs-classic-server.md`, `decisions/skill-distribution-tiered.md`, `decisions/three-layer-tool-architecture.md`, `decisions/per-phase-spec-workflow.md`) er gennemlæst og enige om.
3. Roadmap-rækkefølgen i `workspace/roadmap.md` matcher hvad user vil launche først.

Når ovenstående er enigt, går vi til roadmap-station 1 og co-writer dens spec.
