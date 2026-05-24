---
type: decision
date: 2026-05-24
agent: claude
timestamp: 2026-05-24T18:30:00Z
status: accepted
tags: [decision, auth, oauth, workos, gdpr]
---

# Auth provider: WorkOS AuthKit (managed), accepting US-only data hosting as a known tradeoff to revisit

## Context

Roadmap-station 3 (auth + multi-user identity) skal vælge hvordan brugere autentificerer sig mod vores remote MCP-server. Constraints fra alignment + tidligere decisions:

- **Central-hosted multi-tenant backend** ([[hosting-model]]) → vi behøver en authorization server (AS) for at uddele per-request identity til vores tools.
- **Multi-tenant DB med RLS-chokepoint** ([[db-choice]] + `src/db/with-tenant.ts`) → auth-flow'en skal producere et `household_id` der kan sættes som session-var i hver request-transaktion.
- **MCP App vs classic server** ([[mcp-app-vs-classic-server.md]]) → vi bygger som MCP App, hostet remote (HTTP transport), ikke stdio-lokal. Det udløser MCP 2025-03-26 auth-spec: vores server SKAL eksponere OAuth 2.1 endpoints (`/authorize`, `/token`, RFC 8414 metadata), og burde understøtte enten Dynamic Client Registration (RFC 7591) eller dets nyere efterfølger Client ID Metadata Documents (CIMD, Nov 2025).
- **User-krav:** social login (Google + Microsoft), OAuth-flow ikke API-keys, brugeren logger ind én gang og refresh-tokens håndterer fornyelse stille.
- **Skala:** 5-10 brugere ved DM-launch, sigte mod ~100-1000 hvis retention beviser product-market fit. Solo / lille team — ops-byrde er en faktor.

Sonnet-research-agenten 2026-05-24 evaluerede WorkOS AuthKit, Auth0, Clerk, Stytch, Descope, Supabase Auth, Better Auth, Ory Hydra, Keycloak. To kandidater fittede konstratet "fungerer som OAuth-AS for tredjeparts MCP-clients OG har Google+Microsoft social login OG er produktion-klar nu": **WorkOS AuthKit** (managed) og **Better Auth** (self-hosted lib). Descope kom som tredje legitime option. De øvrige var enten incompatible (Clerk's `client_uri`-validering, Auth0's DCR-vs-social-login restriction), kommercielt usikre (Stytch post-Twilio-acquisition), eller stadig beta (Supabase Auth's OAuth-server).

## Concern

Tre forskellige typer "rigtigt valg" trækker i forskellige retninger:

1. **Hurtigst vej til launch:** Managed service betyder vi skriver minimal kode, ingen ansvar for key rotation / token revocation / sikkerhedsopdateringer, ingen on-call for auth-outages.
2. **Lavest cost / mindst lock-in:** Self-hosted (Better Auth) — koden lever i vores repo, ingen månedlig regning, ingen vendor risk, native Drizzle-integration der matcher vores stack præcist.
3. **EU / GDPR-renest:** Vi er en dansk/nordisk app der målretter EU-husstande. WorkOS har **ingen EMEA hosting region** (alt subscriber personal data leaving EEA stores i USA under SCCs + EU-US Data Privacy Framework). Better Auth (self-hosted i EU) og Descope (Frankfurt region) holder identitetsdata i EU.

Konflikten er reel: option (1) peger WorkOS, option (3) peger Descope eller Better Auth. Vi kan ikke optimere alle tre samtidigt.

## Decision

**WorkOS AuthKit, US-hostet, med EU data residency anerkendt som åbent koncern der genåbnes hvis appen får signifikant traction.**

Konkret:
- WorkOS er authorization server. Vores MCP-server validerer JWTs WorkOS udsteder; vi implementerer ikke OAuth-AS-endpoints selv.
- Google + Microsoft konfigureret som social login providers i WorkOS dashboard.
- Dynamic Client Registration + CIMD aktiveret så MCP-clients (Claude Desktop, ChatGPT, Cursor) kan auto-registrere uden manuel client_id-uddeling.
- WorkOS' returnerede `sub` (Google/Microsoft subject ID) mappes til vores eget `household_id` via en `users` tabel; første gang vi ser en `sub` → create household + link, returnerende user → lookup.
- `app.household_id` i RLS-session-var sættes fra den udledte household ID, ikke fra WorkOS' subject direkte — så auth-providers kan ændres uden at flytte data.

**Vi vælger eksplicit IKKE:**
- Better Auth (self-hosted) — sparker self-hosting + key rotation ansvar til os; vi har én lead som primært bygger features, ikke auth-ops.
- Descope — havde været det rigtige valg hvis EU-data-residency var blockern; det er det ikke ved 5-10 user launch via DM.
- Auth0 — DCR-vs-social-login restriction er konkret friction.
- Stytch — post-Twilio-acquisition pricing usikkerhed.
- Clerk — DCR-`client_uri`-validering-bug bryder eksisterende MCP-clients.
- Supabase Auth's OAuth-server — stadig public beta, GA slipped.

## Goal

- **Brugeren oplever én login-flow:** klik "Sign in with Google" / "Sign in with Microsoft", consent screen, browser lukker, MCP-klienten siger "Connected". Refresh tokens fornyer stille i månedsvis.
- **Vores server gør minimalt:** validerer JWT, mapper `sub` → `household_id`, sætter RLS-context. Auth-protokol-kompleksiteten (DCR, CIMD, OAuth 2.1 AS, token introspection) bor hos WorkOS.
- **WorkOS' 1M MAU free tier** dækker enhver realistic skala vi vil ramme før vi alligevel er tvunget til arkitektur-ændringer. Vi betaler aldrig for auth ved launch.
- **EU-data-residency er løsbar når den bliver et reelt problem** — enten ved at vente på WorkOS' planlagte regional hosting (på roadmap), eller migrere til Descope (samme primitives, EU region), eller flytte til Better Auth self-hosted i EU. Migration cost er afgrænset fordi vi kun har email + provider sub i WorkOS — vores faktiske app-data (recipes, pantry, meal log, household profile) lever allerede i EU-region Postgres som vi kontrollerer.

## Tradeoffs accepted

- **EU bruger-data lever i USA under SCCs + EU-US DPF.** Standard transfer-mekanisme (samme som Stripe, GitHub, Vercel, Google Analytics bruger). Legalt tilstrækkeligt under nuværende EU-lov (maj 2026). **Schrems III er en teoretisk risk** — hvis EU-domstolen invaliderer DPF som de gjorde med Privacy Shield, så skal vi migrere. Vi accepterer denne risk fordi den er industri-bred og ikke specifik for os.
- **Vendor dependency på WorkOS.** Hvis de discontinuer free tier, ændrer pricing markant, eller bliver acquired (sml Stytch), så skal vi migrere. Mitigation: vi mapper `sub` → vores eget `household_id` så data-modellen er auth-provider-agnostisk; migration er at re-link `sub` til samme `household_id` mod ny provider.
- **EU-bruger-friction når vi laver public launch.** Privacy-aware EU-brugere kan have indvendinger mod US-processing af deres login-data. Mitigation: ren privacy policy der disclose'r WorkOS som processor + DPF/SCCs som transfer-mekanisme + clear "delete my account"-flow. Acceptabelt for DM-launch til venner/familie; revisit ved bredere launch.
- **Vi får ikke ejet auth-koden.** Hvis vi senere vil have custom flows (magic links, passwordless, MFA-policies), kan WorkOS' opinionated approach kollidere. Mitigation: ikke et reelt issue for vores use-case (Google/Microsoft social login dækker brugen 100%).

## Revisit triggers

Genåbn denne decision aktivt hvis EN af følgende sker:

1. **Apps når >100 DAU** med EU-targeting — så skala-overvejelser + GDPR-eksponering bliver materielt nok til at retfærdiggøre migration-omkostning til EU-hostet alternativ.
2. **Schrems III invaliderer EU-US DPF** — så er SCCs alene tilstrækkelige men marginalere; mange EU-apps migrerer på det tidspunkt.
3. **WorkOS pricing ændres** væk fra 1M MAU free, eller vi rammer free tier limit.
4. **WorkOS bliver acquired** af en større aktør (Twilio/Stytch-mønster), som typisk udløser pricing-konsolidering.
5. **En regulated industry-customer** (B2B SaaS i fx fintech/healthcare) viser sig at ville bruge appen — disse customers kræver typisk EU-hosting.
6. **WorkOS shipper deres planlagte EU regional hosting** — så er den oplagte move at switche til den uden at skifte vendor.

## Alternatives considered

Se Sonnet-research-rapport (journal 2026-05-24) for fuld evaluering. Kort version:

- **Better Auth (self-hosted lib):** Eneste seriøse self-hosted alternative. Drizzle-native, MIT-licens, OAuth 2.1 AS plugin med DCR + PKCE. Forkastet for nu fordi self-host-ops-byrden (key rotation, token revocation, security upgrades) ikke matcher vores "solo dev + small team" reality ved DM-launch. Stadig den rigtige fallback hvis vi migrerer fra WorkOS senere og vil eje stakken.
- **Descope:** Managed med EU region (Frankfurt), MCP-spec-clean. Free tier 7.5k MAU (mindre end WorkOS' 1M men ikke en bottleneck for os). Forkastet for nu kun fordi WorkOS har mere production-ready MCP eksempel-økosystem (`mcp-use/mcp-oauth-workos-template`) som accelererer integration. Hvis EU-residency bliver dealbreaker → switch til Descope er den oplagte move (samme arkitektoniske mønster).
- **Auth0:** DCR-registered clients kan ikke bruge social login providers. Direct conflict med vores Google+Microsoft krav. Forkastet.
- **Stytch:** Var teknisk den bedste MCP-option gennem 2025, men Twilio-acquisition Nov 2025 har skabt pricing-uncertainty (rapporter om 2-4x bill increases for nye customers). Forkastet pga vendor risk.
- **Clerk:** Tilføjede DCR i 2025, men strict `client_uri` validation bryder eksisterende MCP-clients ([inspector issue #710](https://github.com/modelcontextprotocol/inspector/issues/710)). Forkastet pga konkret interop-bug.
- **Supabase Auth's OAuth server:** Ville være arkitektonisk perfekt (matcher vores Postgres-stack direkte), men stadig public beta, GA slipped. For risikabelt at bygge production-auth på.
- **Ory Hydra / Keycloak:** Headless OAuth-AS, kræver separat tooling til Google/Microsoft social login UI. Ops-kompleksitet ikke retfærdiggjort vs WorkOS/Descope.

## Supersedes / superseded by

Bygger på [[hosting-model]] (central-hosted muliggør shared AS) og [[db-choice]] (Postgres + RLS giver vi mappes til household_id efter auth). Forudsætning for at låse roadmap-station 3 spec (auth + multi-user identity) og station 10 (Stripe payment-integration der bruger samme auth-context). Komplementerer [[three-layer-tool-architecture]] (auth er ikke et tool — det er request-context der konsumeres af alle tools via RLS-chokepoint).
