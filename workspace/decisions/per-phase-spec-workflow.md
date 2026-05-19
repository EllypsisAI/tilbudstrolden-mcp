---
type: decision
date: 2026-05-19
agent: claude
timestamp: 2026-05-19T09:30:00Z
status: accepted
tags: [decision, methodology, workflow]
---

# Hybrid workflow: lightweight spec-driven, per-fase

## Context

User + Claude er leads. Subagents delegerede arbejdsenheder. Multi-fase projekt, ikke one-shot. Claude-sessioner er stateless mellem hinanden — hver ny session skal kunne orientere sig hurtigt på det vi tidligere har fastlagt, ellers gentager vi analyser eller mister beslutninger til drift.

Vi har set konkret hvad der sker når en parallel session mangler kontekst: `claude/agent-native-food-app-9g04a` implementerede et `start_onboarding`-tool uden at have læst alignment-doc, journal eller CLAUDE.md. Det springer både fase 1 (plugin-læring) og reglen "spørg før nyt tool" over.

## Concern

Tre workflow-ekstremer er alle dårlige:

1. **Pure spec-driven (BDUF):** Skriv detaljeret teknisk spec for alt på forhånd. Forkastet — vi opdager mønstre i implementering der gør forhåndsskrevne specs forældede. Spec'en bliver et museum, vi spec'er detaljer vi ikke har viden til at spec'e endnu.
2. **Bare PRD + roadmap, ingen specs:** Forkastet — Claude-sessioner mister beslutninger til drift, og parallelle sessioner gentager analyser eller springer beslutninger over.
3. **Pure feature-driven sprint:** Forkastet — uden roadmap bygger vi noget der ikke passer ind i en bredere plan, og vi mister overblikket over launch-stationerne.

Vi har brug for en mellemvej: nok struktur til at en ny Claude-session kan orientere sig i 10 minutter, ikke så meget struktur at vi spec'er om gæt.

## Decision

Hybrid workflow med fem primitiver:

| Primitive | Rolle | Hvornår opdateres |
|-----------|-------|--------------------|
| `workspace/alignment.md` | PRD-ækvivalent. Vision, arkitektur, terminologi, harness, repo-state. | Når kerne-antagelser ændrer sig. Aldrig uden user. |
| `workspace/roadmap.md` | Ordnede stationer til launch + hvorfor. Ikke detaljeret feature-spec. | Når en station er afsluttet eller rækkefølgen ændrer sig. |
| `workspace/decisions/<slug>.md` | Auditerbare beslutninger med tradeoffs og alternativer. En fil pr. beslutning. | Når en beslutning *låses*, ikke når den foreslås. |
| `workspace/specs/<phase>.md` | Per-fase co-written spec. 1-2 sider. Scope, deliverable, ud-af-scope, acceptance, åbne spørgsmål. | Lige før fasen starter. Frosset under eksekvering. |
| `workspace/journal/YYYY-MM-DD.md` | Daglig session-log. H2-sektioner per session. Hvad skete, beslutninger i forbifarten, åbne items. | Hver session-end. Ikke retroaktivt. |

**Workflow per fase:**

1. **Co-write fase-spec** (user + Claude). Spec'en låser hvad fasen leverer, hvad den *ikke* leverer, og hvad acceptance ser ud som. Det er låsepunktet — efter spec'en er låst, eksekverer vi.
2. **Execute.** Kode + delegerede subagents (exploration, parallel implementation, code review). Beslutninger der dukker op undervejs fanges som `decisions/<slug>.md`. Daglig progress i `journal/`.
3. **Wrap.** Verificer mod spec-acceptance. Opdater `alignment.md` hvis kerne-antagelser shiftede. Marker fasen done i roadmap. Journal-entry der opsummerer.
4. **Næste fase.** Læs alignment + roadmap + decisions. Co-write næste spec. Loop.

**Session-start (ny Claude):**
Læs `workspace/alignment.md` + seneste 3-5 dages `journal/` + alle `decisions/` + nuværende `specs/<phase>.md` hvis en fase er under eksekvering. Det er ~10 minutters læsning og giver fuld orientering.

## Goal

- **Stateless-resistens:** Ny Claude orienteret på 10 minutter via dokumenterne, ikke på 30 minutter via at læse koden og gætte.
- **Beslutninger overlever sessionsskifte:** Decisions-records er auditerbare, dateres, har tradeoffs. Vi gentager dem ikke.
- **Læring føder spec'en, ikke omvendt:** Spec skrives når vi ved nok til at låse fasen, ikke når vi gætter detaljer for en fjern fase.
- **Verificerbarhed:** Hver fase har eksplicit acceptance. Vi sluder ikke om hvornår noget er "done".

## Tradeoffs accepted

- **Front-load ceremoni per fase:** 1-2 sessioner med spec-skrivning før kode-commits. Det føles måske unødvendigt, men det er hvad der gør at fase N+1 ikke ender som tredje gang en Claude-session prøver at gætte arkitekturen ud fra koden.
- **Mindre detalje for fjerne faser:** Roadmap-poster N+2 og senere er bare "stations + hvorfor". Vi accepterer at gøre dem konkrete senere.
- **Disciplin kræves:** Hvis vi ikke skriver decisions undervejs, ryger systemet. Det er sværere end "bare commit".

## Alternatives considered

- **Pure feature-sprint:** Hurtigere learning, men har vist sig at skabe parallel sessions der ikke kender beslutninger. Forkastet.
- **Pure spec-driven:** For tungt for nye mønstre. Forkastet.
- **Bare alignment + journal (ingen decisions, ingen specs):** Forsøgt før denne beslutning — beslutninger drukner i journal-prosa, ny Claude finder dem ikke. Forkastet.
- **Notion / ekstern projektstyring:** Forkastet — al state skal commit'es med koden, så fremtidige Claude-sessioner kan læse det fra repo'en.

## Supersedes / superseded by

Konkretiserer "Arbejdsmetodologi"-sektionen i `workspace/alignment.md` der tidligere var skitse-niveau. Fastlægger journal-per-dag-konventionen som blev introduceret i commit `a54f577`.
