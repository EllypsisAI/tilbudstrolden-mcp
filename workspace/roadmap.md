# Roadmap til launch

Ordnede stationer fra nu til DM-launch. Hver station er en multi-session fase med sin egen co-written spec (`workspace/specs/<station-slug>.md`) lige før eksekvering. Roadmap-poster N+2 og senere holdes som "station + hvorfor" — vi konkretiserer når de bliver næste.

**Launch-kriterium:** En bruger kan installere vores MCP i deres klient, gennemføre onboarding, logge måltider (tekst + billede), få meal-forslag baseret på pantry + deals + historik, generere indkøbsliste, og betale usage-based via Stripe. Backend hosted, multi-user, auth'd.

Rækkefølgen reflekterer afhængigheder. Vi kan parallelisere mellem stationer der ikke direkte afhænger af hinanden, men hver station er som udgangspunkt sit eget spec-låsepunkt.

---

## 1. Hosting model + DB-valg

**Hvad:** Beslut hosting-model (per-bruger lokal vs central hosted vs hybrid). Beslut DB (Neon, SQLite-i-Docker, eller behold JSON+Docker som overgang). Skriv decision-records for begge. Skitser domænemodel-deltaer hvis ikke trivielt fra det eksisterende Zod-skema.

**Hvorfor først:** Hostingbeslutningen driver alt det andet. Central hosted → multi-tenant DB, OAuth, persistent scheduled tasks. Per-bruger lokal → simplere ops, men scheduled tasks dør når container er nede, og payment-integration skal pege på en delt service. Indtil det er låst er resten af roadmap'en betinget.

**Åbne spørgsmål der bør lukkes her:** §1 og §2 fra alignment-doc'ets "Åbne spørgsmål".

**Acceptance:** To decision-records committet. Alignment-doc'et opdateret hvis kerne-antagelser shifter.

---

## 2. Backend domænemodel + migration fra JSON

**Hvad:** Migrér den eksisterende `~/.tilbudstrolden.json`-state til den valgte DB med Zod-skemaet som baseline. Multi-user fra dag 1 (hver husstand er sin egen række/dokument). Bevar atomic read-modify-write semantikken via DB-niveau transactions i stedet for fil-mutex.

**Hvorfor:** Vi kan ikke bygge multi-user, auth eller payment før state-laget kan håndtere flere husstande. Migration først, så bygger vi ovenpå.

**Acceptance:** Eksisterende vitest-suite passerer mod ny backend. Test for multi-husstand-isolation. Data-migration script (eller migration-strategi) dokumenteret.

---

## 3. Auth + multi-user identity

**Hvad:** Hvordan en bruger autentificeres mellem klient og MCP-server. Sandsynlige optioner afhængig af station 1: OAuth via Anthropic/Google, egen identity provider, eller signed connection-tokens (lokal model). Per-bruger isolation i alle tool-kald.

**Hvorfor:** Tool-kald skal kunne identificere hvilken husstand de opererer på. Uden auth kan vi ikke have multi-user backend.

**Acceptance:** Tool-kald validerer auth-token. Test for cross-husstand isolation (tool A's bruger kan ikke læse tool B's data). Auth-flow dokumenteret.

---

## 4. MCP App skeleton + første View

**Hvad:** Prove out hele MCP App-pipelinen med ét simpelt tool + UI. Bundlet HTML/JS via Vite + `vite-plugin-singlefile`, App-klasse, PostMessageTransport, CSP-deklarationer, host context-håndtering. Kandidat: `get_pantry` med checkbox-UI til at se hvad husstanden har — minimalt og verificerbart.

**Hvorfor:** UI-pipelinen er ny for repoet. Vi vil verificere rendering i Claude Desktop og ChatGPT *før* vi bygger ti views der alle er bundet til en pipeline der ikke virker. Tidlig læring om CSP, theme-vars, host-context.

**Acceptance:** Tool registreret med `_meta.ui.resourceUri`. View renderer i Claude Desktop. Tekst-fallback virker i klient uden UI. CSP-deklareret for Tjek API hvis View kalder den.

---

## 5. Tool-konsolidering (lag A/B/C refactor)

**Hvad:** De 18 nuværende tools kollapses til 4-6 model-visible (lag A) + et lille sæt app-only primitiver (lag B). Lag C-funktioner extraheres til rene TypeScript-moduler bag de nye tools. Per `decisions/tool-design-methodology.md`: hvert konsolideret tool får sin arketype (agent-driven, server-beriget, eller server-deterministisk) via dual-POV-walkthrough; vi antager ikke en global model. Eksisterende vitest-tests opdateres til at teste de nye semantiske kapabiliteter.

**Hvorfor:** Tre-lags-arkitekturen er hjørnestenen i agent-native-distinktionen. Indtil refactoren er gjort, eksponerer vi stadig 18 tools til modellen og spilder compounding-værdi. Vi gør den tidligt for at undgå at bygge flere features på toppen af tools-bag-strukturen.

**Acceptance:** ≤6 model-visible tools. Per-tool arketype-begrundelse dokumenteret kort (kode-kommentar eller spec-note). Lag C-moduler unit-tested. Eksisterende integration-tests passerer mod nye tools (semantik bevaret, surface kollapset).

---

## 6. Onboarding-tool med skill-distribution (tier 1-3)

**Hvad:** `start_onboarding` returnerer (a) data nødvendig for første touchpoint (husstand-skabelon, default-præferencer), (b) tekst-instruktioner til agenten om næste skridt (auth, payment, første interaktion), (c) skill-content med permission-gate for tier 1, (d) tekst-fallback for tier 3. Tier-detektering implementeret klient-side via host-context hvis tilgængelig.

**Hvorfor:** Onboarding er brugerens første touchpoint — det er hvor portabiliteten (tier 1/2/3) bliver konkret. Indtil det her virker har vi ingen skill-mekanisme i produktion.

**Re-evaluering:** `claude/agent-native-food-app-9g04a` (sidetrack-branchen) implementerede et `start_onboarding`-tool på den gamle "tools returnerer skill-definitioner"-forståelse. Ved denne station evaluerer vi eksplicit om noget kan cherry-pickes (struktur, parameter-design) eller om vi skriver fra bunden mod den nye permission-gate-konvention.

**Acceptance:** Tier 1-flow testet i Claude Code/Desktop (skill skrives til `~/.claude/skills/` efter user-confirmation). Tier 2-tekst copy-pasteable i Claude.ai web. Tier 3-fallback virker uden skill. Permission-gate-tekst review'et for prompt injection-modstand.

---

## 7. Meal-log: skill + `log_meal` tool

**Hvad:** Skriv meal-log-skill (klient-side protokol: "når brugeren deler et måltidsbillede eller beskriver hvad de spiste, estimér ingredienser via agentens native multimodal, spørg afklarende ved tvivl, spørg portioner, kald derefter `log_meal` med struktureret input"). Implementér `log_meal`-tool med struktureret input-schema (ingredienser, portioner, timestamp). Backend opdaterer atomisk meal-log + pantry-decrement. Optional correction-View som UI-primitiv hvis hurtig brugerretning viser sig værdifuld.

**Hvorfor:** Per `decisions/tool-design-methodology.md`: host-agentens native multimodal + reasoning er kapabilitet vi får gratis. Server-side vision pipeline duplikerer det og introducerer latency. Skill bærer protokollen så agenten reliably gør det rigtige; tool'et er en simpel mutation. Det er den primære anti-friktion-feature i visionen, leveret via skill + simple tool — ikke server-side OCR.

**Acceptance:** Tier 1-skill installeret og virker på Claude Desktop. End-to-end test: bruger sender måltidsbillede → agent estimerer + spørger portioner → `log_meal` kaldes med struktureret input → backend opdaterer meal-log + pantry atomisk. Tier 3-fallback (tekst-baseret beskrivelse uden skill) virker også. Edge cases: ukendte ingredienser, brugerafvisning af gæt, partial pantry-match.

**Forudsætning:** Skill-distribution-infrastruktur fra station 6 skal være på plads før skill-delen virker. Hvis vi vil starte meal-log før onboarding er færdig, kan vi shippe tier-3 først (ren tool + tekst-instruktioner) og lægge skill ovenpå senere.

---

## 8. Suggest_meals: tools + skill via per-tool POV-design

**Hvad:** Design suggestion-flow'et via per-tool POV-walkthrough (`decisions/tool-design-methodology.md`). Sandsynligt resultat — men skal komme ud af analysen, ikke antages: server-beriget kontekst-samling (ét tool returnerer pantry + scored deal-candidates + history-variation-flags fra lag C compounding) + agent-driven reasoning over shortlist + UI-primitiv til præsentation/valg. Modsat tidligere formulering bygger vi *ikke* en server-deterministisk pipeline der returnerer "svaret".

**Hvorfor:** Compounding-værdien (Tjek-cache, embedding-sim, scoring) er reel og hører hjemme i lag C. Men den endelige vurdering (passer dette familien i dag? matcher det stemningen i samtalen?) er reasoning host-agenten gør bedre end vores deterministik. POV-walkthrough vælger den rigtige form for hvert tool i flow'et — arketype låses ikke før analysen er kørt.

**Acceptance:** Per-tool POV-walkthrough dokumenteret for hver tool i suggestion-flow'et (begrundelse for arketype-valg). Lag C-moduler (Tjek-cache, scoring, similarity) unit-tested. End-to-end test: bruger spørger om aftensmadsforslag → agent fetcher beriget kontekst i ét eller få kald → agent ræsonnerer + præsenterer top-N → bruger vælger. Latency-budget overholdt.

---

## 9. Shopping list generation + UI

**Hvad:** Live indkøbsliste som View. Opdaterer mens serveren optimerer (deals × pantry × valgte recipes). Brugeren kan tjekke/justere i UI'et via app-only tools.

**Hvorfor:** Anden hoved-feature efter suggest_meals. Indkøbslisten er det fysiske artefakt brugeren tager med i butikken (eller bruger til online-bestilling).

**Acceptance:** Indkøbsliste-View renderer struktureret data, accepterer ændringer via app-only tool, holder ændringer på tværs af session via `viewUUID` + backend-state.

---

## 10. Payment-integration (Stripe, usage-based)

**Hvad:** Out-of-band web UI for Stripe Checkout. App-only tool `request_payment_session` returnerer signed URL. Webhook fra Stripe opdaterer backend-state. Usage-based pricing matching Tjek-API-prisstruktur med markup.

**Hvorfor:** Vi launcher ikke uden betaling. Holdes sent fordi det kræver hosting + auth + ægte multi-user, men kommer før launch.

**Acceptance:** End-to-end checkout-flow virker. Webhook-håndtering idempotent (gentagne deliveries okay). Usage-måling matcher Tjek-forbrug. Stripe test-mode passing før live-mode.

---

## 11. Pre-launch polering

**Hvad:** Scheduled tasks (hvis MVP kræver — fx ugentligt deals-digest, pantry-expiry-reminders). Observability (logs, error reporting, hosted dashboard). End-to-end test af golden path (onboard → log → suggest → shop → pay). Documentation til DM-onboarding.

**Hvorfor:** Sidste check før produktion. Polering er ikke valgfrit — det er forskellen mellem "appen virker for mig" og "appen virker for vennen jeg sender den til".

**Acceptance:** Golden path testet manuelt med fresh-install bruger. Error-paths logget og monitoreret. Onboarding-DM-skabelon klar.

---

## 12. DM-launch

**Hvad:** Send til første 5-10 brugere fra venner/familie/bekendte. Mål retention (kalder de tools igen efter dag 3? dag 7?), friktion (hvor falder de fra i onboarding?), aktuel forbrug (Tjek-omkostning vs betaling).

**Hvorfor:** Distribution er svær, men vi lærer kun fra rigtige brugere. DM-launch er bevidst lille for at kunne iterere på feedback inden bredere distribution.

**Acceptance:** ≥3 brugere gennemfører onboarding. Mindst 1 bruger genvender efter 7 dage. Retention/friction-data fanget i analytics.

---

## Hvad der bevidst er udeladt fra denne roadmap

- **Skills-creator plugin / frontend design plugin** installation — installeres når de bliver relevante (sandsynligvis station 4 og 6), ikke som egne stationer.
- **Notifications som push** — kræver klient-support der ikke er moden i MCP. Kan tilføjes post-launch når mønsteret findes.
- **Native mobil-app** — ikke i scope. Agent-native via Claude/ChatGPT er distributionen.
- **Multi-region / multi-cloud** — for tidligt at optimere. Single region indtil retention beviser product-market fit.
- **API til third-party integrations** — efter launch.
- **Avancerede features (måltidsabonnement, opskriftsdeling, social)** — efter launch.

---

## Status

- **Station 1 (Hosting + DB): done 2026-05-22.** Spec: `specs/01-hosting-and-db.md`. Decisions: `decisions/hosting-model.md`, `decisions/db-choice.md`. Journal: `journal/2026-05-22.md`.
- **Station 2 (Backend domænemodel + migration fra JSON): næste.** Co-write spec lige før eksekvering.
- Stations 3-12: skitseret, ikke spec'et.

Når en station er done, marker den her med dato og link til spec + decisions + journal-entry.
