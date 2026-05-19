---
type: decision
date: 2026-05-19
agent: claude
timestamp: 2026-05-19T09:00:00Z
status: accepted
tags: [decision, architecture]
---

# Vi bygger som MCP App, ikke klassisk MCP-server

## Context

Phase 1 (plugin/learning) afdækkede at vores nuværende repo er en "klassisk" MCP-server: 18 tools der returnerer tekst, ingen UI-lag. MCP Apps-paradigmet (stable spec `2026-01-26/apps.mdx`) tilbyder noget mere: tools registreres med `_meta.ui.resourceUri` der peger på en `ui://`-resource, host renderer den i sandboxed iframe, og UI'et kommunikerer bidirectionalt via PostMessageTransport.

Beslutningen er taget i parallel med beslutningen om tre-lags intelligence-arkitektur og skill-distribution.

## Concern

Tekst-only chat dræber mad-apps. Brugeren skal beskrive ingredienser, læse lange forslag, mentalt holde styr på hvilke butikker der er hvor — alt mens agenten taler. Selv en perfekt agent producerer text walls der får brugere til at churn.

Tekst er sekventiel kommunikation: én part taler ad gangen. UI er parallel: brugeren kan se sin pantry mens agenten taler, justere indkøbslisten mens den optimerer, uploade et billede uden at åbne en separat app.

## Decision

Vi bygger som MCP App. Det betyder:

- Tools registreres med UI-metadata (`_meta.ui.resourceUri`) når de har en visuel komponent.
- Vi bundler HTML/JS (App-klasse, PostMessageTransport) til de UI-overflader vi eksponerer.
- Vi deklarerer CSP eksplicit (`connectDomains`, `resourceDomains`, `frameDomains`) — fx for Tjek API-kald fra View.
- Vi designer for graceful degradation: hosts uden UI-kapabilitet får tekst-fallback via `content`-arrayet, og funktionen er stadig komplet (backend er moaten).

**To UI-overflader:**

1. **In-chat UI (MCP App View):** Embedded i agent-konteksten. Til visualisering, billed-upload, pantry-edit, live indkøbsliste, interaktiv bekræftelse.
2. **Out-of-band web UI:** Til ting agenten *ikke kan* udføre — credentials og payment. Brugeren ankommer via signed link.

Vi bygger **ikke**:
- En standalone web-app som primær distribution.
- UI der kan skrive direkte til backend uden om tools (writes går altid gennem tool-kald).

## Goal

- Brugeren ser, justerer og bekræfter parallelt med agentens arbejde i stedet for at læse vægge af tekst.
- Vi rammer det aktuelle MCP Apps-mønster så vi får native rendering i Claude og ChatGPT uden særtilpasninger.
- Backend forbliver moaten: UI er minimum (read + interaktive primitiver), state lever serverside.

## Tradeoffs accepted

- **Større build-overflade:** bundled HTML/JS, Vite-pipeline med `vite-plugin-singlefile`, CSP-deklarationer per UI-resource. Mere kompleksitet end ren tools-bag.
- **Spec-modenhed:** MCP Apps-spec'en er stabil pr. 2026-01-26, men relativt ny. Fil-uploads markeres "not yet implemented" i migration-guide — vi må arbejde uden om for billed-recognition indtil videre.
- **Host-fragmentering:** Ikke alle MCP-hosts vil rendere UI. Tier 3 (tekst-fallback) bliver en realitet, ikke bare en teoretisk failover.

## Alternatives considered

- **Klassisk MCP-server (status quo):** Beholder de 18 tools, returnerer kun tekst. Forkastet fordi det er præcis det mønster der dør i mad-app-bunken; ingen anti-friktion.
- **Standalone web-app + separat MCP:** Splittet attention, dræber agent-native modellen. Brugeren skal skifte kontekst, agenten ser ikke UI-tilstand. Forkastet.
- **Native mobil-app:** Distribution-friktion (App Store), ikke agent-native, mister hele pointen. Forkastet.

## Supersedes / superseded by

Erstatter den implicitte antagelse i `workspace/alignment.md` om at "UI" var en separat ting vi ville bygge senere. UI er nu en kerne-arkitekturel komponent fra dag 1.
