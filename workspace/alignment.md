# Alignment-dokument: Agent-native mad app

## Context

Dette er kun et alignment-dokument. Vi planlægger ikke implementering her, og vi forsøger ikke at scope første kodefase. Formålet er at få vision, arkitektur, terminologi, repo-state og arbejdsmetodologi nedfældet ét sted, så vi (user + Claude) har en kanonisk reference når vi senere går i gang med faser.

### Hvorfor kun alignment - og ikke teknisk plan endnu

Claude's default mentale model er træningsdata-gennemsnit. Uden plugins der opgraderer referencerammen scoper jeg teknik som om det var 2020: SaaS-pattern, REST CRUD, frontend-først, monolitisk backend, brugeren operer UI. Det er præcis det vi *ikke* vil bygge. Agent-native, klient-side skills og hosted multi-user MCP er ikke i mit defaults i samme grad som en CRUD-app i Django.

Konsekvens: plugins skal installeres og arbejdes igennem **før** teknisk planlægning, ellers er planen forældet før den skrives. Det er derfor fase 0 (alignment) og fase 1 (plugin/learning) er adskilt fra teknisk planlægning. Mellem fase 1 og fase 2 reviderer vi alignment-doc med det vi har lært, og *så* tager vi teknisk planlægning fase for fase.

Dokumentet er et levende artefakt. Når en sektion ændrer sig (fx fordi vi lærer noget under plugin-fasen), opdateres det.

---

## Vision (kanonisk formulering)

**Premise:** Samme kerne-funktionalitet som SaaS dør i bunken. Samme kerne-funktionalitet som agent-native app overlever. Brugeren installerer ikke en app - de installerer en connector/MCP i deres AI-klient (Claude, ChatGPT).

**Mål:** En agent-native mad-app der hjælper husstande med at spise godt og billigt ved at fjerne friktionen i madplanlægning, logning og indkøb. Agenten gør arbejdet. Brugeren uploader et billede af måltidet eller bare svarer på et spørgsmål - resten er automatisk.

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
| **MCP** | Capabilities. Hvad agenten *kan* udføre. Stateless tools. |
| **Skills** | Klient-side protokoller. *Hvornår* og *hvordan* agenten skal handle. |
| **Backend** | Per-bruger state. Pantry, allergier, præferencer, historik, log. |
| **UI** | Minimal. Read i klient. Write kun til credentials og payment. |

### Den centrale designindsigt om skills

Skills er **ikke** kode i vores app. De er klient-side artefakter (Claude Skills, ChatGPT custom instructions, eller hvad klienten nu bruger). Vi *distribuerer* dem via tool-responser:

- Hvert MCP-tool kan returnere to slags output: (a) data, (b) en eventuel skill-definition klienten skal installere i brugerens miljø.
- Eksempel: Onboarding-tool returnerer brugerens initiale data + en skill der definerer hvordan klienten fremadrettet bruger vores tools.
- Implikation: Vores MCP er platform-agnostisk for skill-mekanikken, men ansvarlig for skill-*indholdet*. Hvilken klient der installerer det, og hvordan, er klientens problem.

### Onboarding er et tool, ikke en prompt

Klienten kalder onboarding-tool på første interaktion. Toolet fortæller klienten hvad der skal ske (skill-oprettelse, auth, payment, første touchpoint). Resultat: konto + initial data i backend.

### UI-princip

Read i klient. Write kun til ting brugeren *skal* udføre selv: credentials, betaling. Resten udfører agenten.

### Backend er moaten

State lever i backend. Klienten er udskiftelig. Brugeren skifter mellem Claude og ChatGPT uden at miste sin pantry eller historik. Det er der differentieringen bygges - ikke i MCP'en (som er tynd) eller UI (som er minimal).

---

## Domæneglossar

- **Klient:** AI-agent brugeren bruger (Claude, ChatGPT, andet). Operer vores MCP og installerer vores skills.
- **MCP tool:** Capability vores server eksponerer. Kalddes af klient på vegne af bruger.
- **Skill:** Klient-side instruktion-sæt der definerer hvornår/hvordan klienten bruger vores tools. Distribueret via tool-responser, installeret i brugerens klient-miljø.
- **Backend:** Hosted database + API der holder per-bruger state. Kilden til sandhed for husstand, pantry, log, præferencer.
- **Husstand:** Den primære domæne-entitet. Indeholder personer, allergier, butikspræferencer, default-portioner.
- **Pantry:** Liste af ingredienser brugeren allerede har. Ekskluderes fra indkøbslister.
- **Touchpoint:** Brugerens første kontakt med appen efter installation. Etablerer baseline-data.

---

## Repo state: TilbudsTrolden MCP

### Hvad findes (cornerstones)

**18 MCP tools** dækker alle 6 vision-kapabiliteter:
- Deals: `search_deals`, `get_store_offers`, `list_stores`, `deals_this_week`
- Recipes: `get_recipes`, `add_recipe`, `remove_recipe`
- Household: `get_household`, `update_household`
- Pantry: `get_pantry`, `update_pantry`
- Log: `log_meal`, `get_meal_history`, `log_spend`, `get_spend_log`
- Planning + shopping: `score_recipes`, `generate_shopping_list`, `plan_and_shop` (one-shot: score → optimize → shopping list)

**3 MCP prompts:** `getting-started`, `meal-plan`, `deal-scout`

**Tjek API integration** (`src/api.ts`): 3-retry exponential backoff, 8s timeout, 4 concurrent requests max, in-memory dealer cache for DK, multi-country (DK/NO/SE/FI), public API uden auth.

**Datamodel** (`src/store.ts`): Zod-valideret schema. Entities: Household (people, dietaryRestrictions, stores, country, defaultServings), Pantry (string[]), Recipe (ingredients, servings, complexity, cuisineType, proteinType), Ingredient (name, quantity, searchTerms, category), MealLogEntry, SpendLogEntry. Atomic read-modify-write via mutex.

**Storage:** Single JSON-fil i `~/.tilbudstrolden.json` (konfigurerbar via `TILBUDSTROLDEN_DATA` env var).

**Build:** TypeScript ES2022, Node ≥18, vitest tests, biome lint, tsx watch dev.

### Hvad mangler vs vision

- **Onboarding tool** - kun en prompt (`getting-started`), ikke et tool klienten kalder
- **Hosted backend** - lokal JSON, ingen cloud, ingen multi-device
- **Multi-user / auth** - single household pr. fil, ingen accounts
- **Skill-creation i tool responses** - tools returnerer kun data, ingen skill-definitioner
- **Payment/billing** - ingen integration, ingen subscription state
- **Scheduled tasks** - ingen job scheduler
- **Image recognition** - ingen billed-analyse af måltider/kvitteringer
- **Notifications** - ingen aktiv alerting

### Repo-strategi (afklares senere)

Vi er pt. i en kopi/fork af `olgasafonova/tilbudstrolden-mcp` på branch `claude/agent-native-food-app-Mb6B3`. Forholdet til original-repo (samarbejde, fork, license, egen rewrite) er ikke afklaret - tages op før vi laver substantielle ændringer.

---

## Arbejdsmetodologi

### Roller
- **User + Claude:** Leads og main. Bevidste beslutninger træffes her.
- **Subagents:** Delegerede arbejdsenheder. Bruges til parallel exploration, isoleret implementering, code review.
- **Disciplin:** Multi-phase projekt, ikke one-shot. Hver fase har klar afgrænsning og verifikation før næste starter.

### Plugins / skills vi anvender

| Plugin | Hvornår | Formål |
|--------|---------|--------|
| MCP-byggeri plugin | Installeres først (fase 1) | Claude lærer MCP-app design grundigt før implementering |
| Neon plugin | Hvis/når Neon vælges som DB | Serverless Postgres modellering, branching, query-mønstre |
| skill-creator plugin | Når vi skriver vores første skills | Skill-distribution mekanik |
| frontend design skill | Når vi rammer UI-laget | Minimal UI komponenter |

Bemærk: DB-valg er åbent. Kandidater:
- **Neon** (serverless Postgres, Supabase-alternativ) - matcher usage-based pricing, branching-per-environment, pay-per-use cold-starts. Hvis vi går denne vej installeres Neon-plugin.
- **SQLite** (embedded SQL) - deployed via Docker, simple ops, men ingen multi-region eller branching.
- **Behold nuværende JSON-fil** + Docker - simpleste vej, men loft tidligt når vi rammer multi-user / concurrency.

Valget tages efter vi har dømt domænemodellen i en senere fase.

**Status quo note:** Repo'en bruger pt. en JSON-fil i `~/.tilbudstrolden.json` med Zod-validation og mutex - det er **ikke** SQLite. Hvis vi vælger SQLite, er det første migration. Hvis vi vælger Neon, er det større migration. Hvis vi beholder JSON, er ændringen mindre men skalerings-loftet kommer hurtigere.

### Context management harness

User's standard metode (verbatim - bruges optional, ikke alle workspaces har brug for alt):

Each workspace of mine may use these optional folders depending on its work pattern. Not every workspace needs all of them. Do not preemptively create empty folders; add a primitive when the work actually calls for it.

- `raw/`: immutable inputs. Whatever the source is in original form: markdown, transcripts, PDFs, images, link dumps. Most raw entries have no frontmatter; provenance lives in the workspace's `log.md`.
- `journal/`: append-only session log. Date-prefixed entries (`## [YYYY-MM-DD HH:MM] {topic}`) so `grep` and `tail` work cleanly. Documents what happened, what was decided in passing, what is open.
- `decisions/`: AgDR-style decision records, one file per decision. Frontmatter: `type: decision`, `agent`, `model`, `timestamp`, `status`. Body: Y-statement (context, concern, decision, goal, tradeoff). Use when a workspace produces decisions that should be auditable later.

**decision template:**

```
---
type: decision
date: YYYY-MM-DD
agent: claude
timestamp: YYYY-MM-DDTHH:MM:SSZ
status: proposed
tags: [decision]
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

If this decision replaces an earlier one, link it: `[[old-decision]]`. If it gets replaced later, update `status: superseded` and link forward.
```

**Anvendelse i dette projekt:** Vi afgør pr. fase om vi tager primitiver i brug. Sandsynligt vi vil have `journal/` (append-only log af sessions og passively-made decisions) og `decisions/` (når vi vælger fx database, skill-distribution mekanik, payment processor). `raw/` kan blive relevant når vi samler brugerresearch eller eksterne inputs.

---

## Faser (skitse, ikke detaljeret plan)

- **Fase 0 (nu):** Alignment-dokument. Bekræft fælles forståelse.
- **Fase 1:** Plugin/learning. User installerer MCP-byggeri plugin. Claude arbejder igennem den for at lære moderne MCP-app design grundigt. Output: opdateret forståelse + eventuelle revisioner af alignment-doc.
- **Fase 2+:** Defineres efter fase 1. Sandsynlige kandidater (i ingen bestemt rækkefølge): skills-mekanik prototype, backend domæne-modellering, repo/business-strategi-afklaring, brugerresearch.

---

## Verifikation af dette alignment-dokument

Dokumentet er valideret når:
1. User læser dokumentet i sin helhed og bekræfter at vision, arkitektur og repo-state er kanonisk korrekt.
2. Harness-sektionen er udfyldt med user's verbatim metode.
3. Vi er eksplicit enige om at fase 1 (plugin/learning) er næste skridt - ikke implementeringskode.

Hvis user bekræfter ovenstående, exit-er vi plan mode og venter på plugin-installation før noget kodearbejde begynder.

---

## Filer

Eneste fil berørt i alignment-fasen:
- `/root/.claude/plans/alright-ideen-er-der-synchronous-balloon.md` (dette dokument)

Ingen ændringer i `/home/user/tilbudstrolden-mcp/` før vi forlader fase 0.
