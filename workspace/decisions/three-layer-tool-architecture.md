---
type: decision
date: 2026-05-19
agent: claude
timestamp: 2026-05-19T09:20:00Z
status: accepted
tags: [decision, architecture, tools]
---

# Tre-lags tool-arkitektur: model-visible, app-only, internal

## Context

Vores nuværende repo eksponerer 18 MCP-tools, alle synlige for modellen. Agenten skal vælge mellem `search_deals`, `get_store_offers`, `list_stores`, `deals_this_week`, `get_recipes`, `add_recipe`, ... osv. Det er en tools-bag: hvert tool er et atomart trin, og agenten bærer kompleksiteten med at orkestrere dem korrekt.

Phase 1 afdækkede MCP-mønstret `visibility: ["app"]` — tools der er skjult fra modellen men kaldbare fra UI. Det åbnede en bredere indsigt: vi har faktisk *tre* steder at placere logik, ikke ét.

## Concern

Tools-bag-mønstret skalerer dårligt for to årsager:

1. **Agent-side fejl:** Jo flere tools agenten ser, jo flere måder kan den vælge forkert, glemme et trin, eller præsentere intermediate state. Hver tool-kald er en chance for at slude.
2. **Compounding værdi mistes:** Vores reelle aktiver — Tjek dealer-cache, retry-logik, scoring-pipeline, multi-step optimering — bliver fragmenter fordelt på flere tools i stedet for samlet til én kapabilitet. Hver tool-kald betaler latency-omkostning på cache-miss; flere tool-kald = flere cache-misses.

En agent-native app skal præsentere få, semantisk rige kapabiliteter for modellen og holde orchestrationen serverside.

## Decision

Tre lag, klart adskilte:

**Lag A — Model-visible tools (`visibility: ["app", "model"]`, default):**
Få, semantisk rige, high-level. 4-6 stykker. Modellen ser dem. Hver svarer til en hel intention, ikke et trin.

Eksempler:
- `start_onboarding` — registrerer husstand, henter første touchpoint, returnerer skill-content
- `suggest_meals` — én aftensmad eller en uges plan; serveren orkestrerer pantry + deals + scoring + historik
- `log_meal` — registrér hvad der blev spist (evt. fra billede); serveren opdaterer pantry, historik, spend
- `plan_shopping` — fuld pipeline: scoring → optimering → indkøbsliste
- `manage_household` — alle CRUD-handlinger på husstand/pantry/præferencer bag ét tool med intent-flag

**Lag B — App-only tools (`visibility: ["app"]`):**
Kaldbare kun fra UI'et. Polling, chunking, billed-upload-håndtering, interaktive primitiver. Modellen ser dem ikke og kan ikke kalde dem.

Eksempler:
- `poll_image_analysis` — UI poller mens billed-recognition kører i baggrunden
- `get_recipe_chunk` — UI henter næste batch af alternativer ved scroll
- `confirm_pantry_changes` — UI commit'er ændringer brugeren har tjekket af
- `request_payment_session` — UI initierer Stripe-flow

**Lag C — Internt serverside:**
Ren TypeScript. Ingen MCP-eksponering. Tjek-cache, dealer-lookup, embedding-similarity, retry-wrappers, scoring-funktioner, optimeringspipeline, billed-OCR. Reuses på tværs af lag A og B.

Eksempler (delvist eksisterende):
- `src/api.ts` (Tjek-integration med retry/timeout/concurrency/cache)
- Embedding similarity for recipe-matching
- Multi-criteria scoring (pris, tid, variation, historik)
- Optimering: hvilke deals dækker hvilke ingredienser med mindst overlap

## Goal

- **Agenten vælger mellem 4-6 kapabiliteter**, ikke 18 trin. Færre måder at fejle.
- **Orchestration er serverside.** Vi kan ændre orkestrerings-logik uden at agenten skal lære nye sekvenser.
- **Compounding værdi.** Tjek-cache, scoring-pipeline, embedding-search ligger i lag C og bruges af både model-visible og app-only tools. Investering i lag C giver afkast hver gang et lag A/B-tool kalder den.
- **UI får sine egne primitiver** uden at forurene modellens tool-overflade med ting den ikke skal vælge mellem.

## Tradeoffs accepted

- **Refactor:** De 18 eksisterende tools skal konsolideres ned til ~5 model-visible + UI-primitives. Det er en større ændring end add-only feature-arbejde.
- **Internt API:** Lag C bliver et de-facto internt API som lag A og B kalder. Vi bærer disciplinen med at holde det rent — det er ikke MCP, det er TypeScript-funktioner.
- **Sværere debugging:** Når noget går galt i en lag-A-pipeline der internt kalder 8 lag-C-funktioner, er stack-tracen vores ven, ikke MCP's tool-call-log. Vi skal logge bevidst.
- **Sværere at give agenten "fingerspids-kontrol".** Hvis brugeren beder om noget meget specifikt (fx "vis mig kun tilbud der ender på onsdag i Føtex"), kan vi ikke længere give agenten et lavt-niveau tool. Det skal håndteres som parametre på et høj-niveau tool, eller ikke understøttes som path.

## Alternatives considered

- **Behold tools-bag (status quo):** Forkastet — det er præcis det mønster vi ikke vil bygge. 18 atomare tools dræber agent-oplevelsen og spilder compounding-værdi.
- **To lag (model-visible + internal):** Forkastet — uden app-only-laget mister vi UI-primitiver. Hvis UI'et skal hente alternativer via lag A-tools, ser modellen kaldene og bliver forvirret.
- **Mange lag-A-tools (8-12):** Forkastet — vi har set tools-bag-fælden. 4-6 er det realistiske loft for "semantisk rige" tools agenten kan vælge mellem uden at slude.

## Supersedes / superseded by

Bemærker eksplicit at `claude/agent-native-food-app-9g04a`-branchen (med `start_onboarding`-tool implementeret før denne beslutning) ikke nødvendigvis matcher tre-lags-modellen. Den evalueres separat (se roadmap-stage "tool-konsolidering") og cherry-pickes, omskrives eller droppes baseret på fit.
