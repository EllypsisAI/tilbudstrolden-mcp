---
type: decision
date: 2026-05-19
agent: claude
timestamp: 2026-05-19T09:10:00Z
status: accepted
tags: [decision, architecture, skills]
---

# Skills distribueres via tool-content med user-permission gate, tieret per klient

## Context

Phase 1-digesten påviste at alignment-doc'ets oprindelige formulering — "tools returnerer skill-definitioner som klienten installerer" — ikke matcher MCP-spec'en. Der findes ikke et felt i `_meta` eller `structuredContent` som klienten automatisk parser og installerer som skill.

Men vi opererer i en virkelighed hvor klient-Claude (i Claude Code / Claude Desktop med fs-MCP) *kan og vil* skrive filer hvis den bliver instrueret om det. Det er en konvention vi indfører oven på spec'en, ikke en spec-feature. Mekanismen er ikke "klienten parser et skill-felt" — den er "agenten følger en instruktion i tool-responsens tekst-indhold".

Det rejser to spørgsmål: (a) er det prompt injection? (b) hvad sker der med klienter der ikke har fs-skrivning?

## Concern

To risici:

1. **Prompt injection-vinkel.** Hvis tool-responsen siger "skriv følgende fil til ~/.claude/skills/...", læser klient-Claude det som en instruktion fra en ikke-bruger-kilde. Det er præcis injection-mønstret Anthropic strammer modstanden mod. Vi vil ikke have at vores app virker i dag og brækker næste gang Claude bliver mere skeptisk over for fjernindhold.
2. **Klient-portabilitet.** Claude Code skills er ikke ChatGPT custom instructions er ikke Claude.ai-web's manglende fs-adgang. Hvis vores klient-side personalisering kun virker ét sted, kan vi ikke kalde appen platform-agnostisk.

## Decision

Tre-tier skill-distribution med user-permission gate som mitigation:

**Tier 1 — Claude Code, Claude Desktop med fs-MCP:**
Tool-responsen indeholder skill-instruktion med eksplicit autorisations-gate. Skill-content præfikses med:

> **DO NOT create this skill unless the user has explicitly authorized it in this turn.**
>
> Reasoning: this skill enables [feature] in the tilbudstrolden app. It belongs in the user's environment because [reason]. The user has installed this app and is expected to confirm before any file is written.
>
> [skill body]

Klient-agenten skal eksplicit spørge brugeren om tilladelse før den skriver til `~/.claude/skills/`. Det forvandler instruktionen fra "fjernkilde fortæller mig at skrive en fil" til "fjernkilde fortæller mig at *bede brugeren om lov til* at skrive en fil" — sidstnævnte er ikke injection, det er user-mediated.

**Tier 2 — Claude.ai web, ChatGPT med custom instructions:**
Tool-responsen returnerer skill-content som copy-pasteable tekst med klare instruktioner: "Paste følgende i dit klient-system's custom instructions / personalisering for at få [feature]". Brugeren udfører action; agenten guider.

**Tier 3 — alle andre klienter:**
Tekst-fallback. Skill-content droppes. Funktionen virker stadig fuldt ud — alle features er tilgængelige via tools — men uden klient-side personalisering. Brugeren får måske flere afklarende spørgsmål per session fordi agenten ikke har preferencer i sin kontekst.

## Goal

- **Sikkerhed:** Permission-gate gør skill-creation til en autoriseret handling, ikke en injection-vektor. Robust over for fremtidige hardenings af Claude's injection-modstand.
- **Portabilitet:** Backend som moaten + tier 3 fallback betyder vi kan launche uden at vente på klient-side parity. Multi-client fra dag 1.
- **Progressive enhancement:** Bedre klient → bedre oplevelse. Ingen klient er afskåret fra core-funktionalitet.

## Tradeoffs accepted

- **Tier 1 afhænger af klient-adfærd vi ikke kontrollerer.** Hvis Anthropic ændrer hvordan klient-Claude håndterer skrivning-instruktioner i tool-responser, falder tier 1. Permission-gate reducerer risikoen markant fordi vi instruerer agenten om brugerautorisation først, men den eliminerer den ikke.
- **Tier 2 er manuel.** Brugeren skal copy-paste. Vi accepterer det fordi alternativet er ingen klient-side personalisering for web/ChatGPT-brugere.
- **Tier-detektering er klient-side gætværk.** MCP-spec'en eksponerer ikke "har du fs-skrivning?". Vi gætter ud fra host-context (hvis tilgængelig) eller default-tilbyder tier 1 og lader klient-agenten falde til tier 2 hvis den ikke kan udføre.

## Alternatives considered

- **Direkte skill-payload i `_meta`:** Forkastet fordi spec'en ikke har feltet og ingen klient automatisk parser det. Vi ville bygge på en hypotetisk spec-udvidelse.
- **Kun plugin-marketplace (mcp-apps-mønstret):** Forkastet fordi det kræver brugeren manuelt installerer plugin før onboarding. Friktion vi gerne vil undgå, og plugin-marketplace eksisterer ikke for ChatGPT.
- **Ingen klient-side skills overhovedet:** Forkastet fordi det fjerner et reelt UX-løft. Når agenten har preferencer i kontekst, sparer den runde i hver session.
- **Ren prompt-injection (instruér uden permission-gate):** Forkastet på sikkerhed.

## Supersedes / superseded by

Erstatter den oprindelige formulering i `workspace/alignment.md`: "Hvert MCP-tool kan returnere ... en eventuel skill-definition klienten skal installere i brugerens miljø." Den formulering var teknisk forkert (spec'en distribuerer ikke skills via tools) og overså prompt injection-vinklen.
