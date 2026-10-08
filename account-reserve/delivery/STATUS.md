# Account reserve — leveransestatus

Publication update, 8 October 2026: the owner approved the reviewed account-reserve source release to `CryptoMickle/continuity-kit/account-reserve` with MIT for original code and preserved dependency notices. The package remains unpublished on npm. Portal submission and video are separate. Earlier pending-license/publication statements below are retained as historical preparation records, not current license status.

Oppdatert 8. oktober 2026. Dette er den nye kontoreserven, ikke den tidligere publiserte notatbackupen. Video er uttrykkelig utsatt.

**Den avgrensede offentlige prøven er fullført på Monad testnet.** Mens Primary A svarte HTTP 503, gjenopprettet en fersk B-fane den opprinnelige kontoen med eksisterende fysisk passkey og innløste rettighet 1 én gang. Begge faste RPC-er bekreftet samme vellykkede transaksjon, mottaker og sluttstatus. A ble deretter gjenåpnet og kontrollert med HTTP 200. Samlet native bevis fra Primary 3 / Reserve 2: `evidence/native-public-testnet-proof-2026-10-08.json`. En etterfølgende godkjent oppsettsretting er nå publisert som Primary 4 / Reserve 3, uten nye nøkler eller transaksjoner. Rettingen er lokalt verifisert med 318 tester; faktisk reduksjon i systembekreftelser er ikke målt. Dette dokumenterer én fungerende reserveflyt, ikke generell etterspørsel, produksjonssikkerhet eller premieutsikter.

## Implementert og prøvd lokalt

- Et eget SDK for forberedelse og gjenfinning av en kryptert reserve med Mera. En fersk B-klient finner reserven fra den eksisterende B-legitimasjonen, uten innlimt kontoadresse eller eksportfil.
- To selvstendig skrevne referansemodeller: direkte PRF-konto og ett utvalgt BIP39/BIP32-kontoblad. SDK-pakken er installert og prøvd i to rene lokale forbrukerprosjekter. Dette er ikke eksterne integrasjoner.
- En betalingsrettighet opprettes før reserven. Etter at A er utilgjengelig, finner B samme konto og utfører den allerede opptjente rettigheten. En annen konto avvises. Native overføring er prøvd på disponibel lokal EVM-kjede.
- Nettleserflyten er prøvd for begge modellene. Etter betaling og omlasting tilbyr klienten kontroll av samme transaksjon, ikke en ny sending. Signeringsøkten lukkes etter bekreftelse.
- SDK-, kontrakt-, handoff-, transaksjons-, HTTP- og Redis-kontroller. Redis-testene bruker en faktisk disponibel Redis-prosess; testnet-klienten prøves med kontrollerte RPC-svar. Samlet bevis og kildehasher ligger i `evidence/verification.json` og tilhørende logger.

Siste samlede kjøring etter oppsettsrettingen: **318 beståtte tester, 0 feil, 0 hoppet over** (135 kjerne/pakke, 71 utviklerpakke, 6 HTTP og 106 publiseringskandidat-tester). Alle seks stadier bestod, inkludert faktisk Redis-Lua-prøve. Nettverket var begrenset til loopback på OS-nivå. Kjøringen omfatter gjenbruk av opprettelsesresultatet og nettleserens delte kø mot de to faste testnettilbyderne. Dette er lokal, syntetisk verifikasjon; publisering og den tidligere offentlige native prøven er dokumentert separat nedenfor. Kjøringene på 290 og 303 tester er historiske.

Den automatiserte testpakken bruker syntetisk autentisering; den separate native prøven er beskrevet nedenfor. Fysiske system-/Face ID-bekreftelser er ikke utledet fra antall API-kall. Den nye utformingen er kontrollert i nettleseren ved 320, 390 og 1280 px, uten horisontal overflyt. Fysisk iPhone-prøve er fortsatt uprøvd for denne nye klienten. Se `evidence/design-review.json` for lokal flyt og omfang.

Det valgte Prism-designet er integrert i hovedappen og utviklerpakken: store gjennomgående fargelinjer, avrundede flater og egen reserveillustrasjon. Hovedhandlingen kommer før illustrasjonen på mobil. Tidligere visuell kontroll er dokumentert i `evidence/prism-integration.json`. Demokontroller er samlet under **Demo controls**. Tilgang, flere mulige passkey-bekreftelser og demoens slettedato er forklart ved handlingen; de skjules ikke av den nye utformingen.

## Ny utviklerpakke — 8. oktober

- TypeScript-deklarasjoner for kjernen og egne `/browser`, `/http-store` og `/preflight`-innganger. Ingen protokollendring.
- Oppsettskontroller for A/B med kontroll av konto, domene, vindu og engangsverdi; avbrudd og usikker lagring gir ikke falsk klarmelding.
- Ferdig HTTP-lagringsadapter med avgrensede svar, én skriveprøve per tillatelse og ingen automatisk gjentakelse.
- Lokal startpakke genereres med `npm run create:starter -- /absolutt/tom-mappe`. Krever Node/npm, men ingen databasekonto, Foundry, midler eller kjede. Forbrukeren bruker bare installerte, dokumenterte pakkeinnganger.
- Ren mappe ble generert, pakken installert offline, TypeScript inkludert deklarasjonene kontrollert, nettsiden bygget og samme konto gjenopprettet etter A503. Ingen interne testhjelpere kopieres. Automatisert kjøretid er ikke målt menneskelig onboardingtid.
- Den genererte pakken ble også prøvd i nettleseren: A-konto, separat B-oppsett, A av, A-fane lukket, fersk B, samme konto, signert lokal utfordring og lukket signeringsøkt. Ingen transaksjon inngår i startpakken. Visningsbredder 320, 390 og 1280 px hadde ingen horisontal overflyt; ingen konsollfeil ble sett.
- Veiledning: `starter/README.md`. Automatisk bevis: `evidence/onboarding.txt`; separat nettleserbevis: `evidence/onboarding-browser.json`.

Startpakkens visning er deretter bearbeidet med varmere flater, en egen reserveillustrasjon, én tydelig handlingsflate og sammenfoldede tekniske detaljer. Tekst og instruksjoner følger nå oppsettets faktiske status; etter gjenoppretting står det at signeringsøkten er lukket. Synlig merking av syntetisk prøve, RAM-lagring og signeringsmyndighet er bevart. Gjenoppretting av samme eksempelkonto er kontrollert på nytt etter endringen. Visningen er inspisert på skrivebord og ved 390 og 320 px uten horisontal overflyt. Se `evidence/starter-design-review.json`; den tidligere komplette bortfallsprøven er fortsatt separat historisk bevis.

Startpakken er fortsatt lokal og eksperimentell. Den er ikke publisert på npm og har ingen valgt redistribusjonslisens. Native lokal prøve og en separat offentlig B-gjenoppretting med A-bortfall og testnetinnløsning er dokumentert nedenfor. Startpakkens RAM-server og syntetiske autentisering skal aldri publiseres.

## Feilretting og fysisk testpakke — 8. oktober

- Native forespørsler får en tidsgrense og avbrudd helt ned til nettleserens passkey-grensesnitt. Forsinkede resultater etter avbrudd forkastes; kontrollerte nøkkelbuffere nullstilles. Dette er ikke en påstand om garantert sletting av alle JavaScript-minnekopier eller validert støtte på alle enheter.
- A kan åpnes igjen med eksisterende nøkkel. B har en eksplisitt handling for videreføring med eksisterende reservenøkkel. En allerede lagret reserve bekreftes lesende; uklar lagring overskrives eller gjentas ikke automatisk.
- Feil under lesekontroll før signering låser ikke betalingsforsøket. Etter signering bevares forsøket, og stopp før sending skilles fra en sendt transaksjon uten kvittering.
- Separat fysisk testpakke: `<local-physical-snapshot>`. Fil- og programhasher er kontrollert med `--verify-only`. Serveren er deretter **godkjent og startet** i fysisk modus; native opprettelse og reserveklargjøring er observert. Brukeren rapporterte fem bekreftelser under reserveoppsettet. Fersk B har nå gjenopprettet samme konto etter verifisert A-bortfall, og klienten viste bekreftet lokal utbetaling og lukket signeringsøkt. Kjedekvittering og kontraktstatus er kontrollert lesende: vellykket claim(1), blokk 3, samme mottaker, 0,001 lokale testenheter og claimed=true. Én reserveskriving og én kringkastingsprøve; begge syntetiske tellere er null. Se `evidence/physical-run-2026-10-08.json`, `evidence/physical-preparation.json` og `PHYSICAL_TEST.md`.
- Nettleserprøve på separat port 4973/4974: avbrutt oppsett, samme A åpnet igjen, ny reserve, deretter videreføring med eksisterende B uten ekstra skriving. A returnerte 503, gamle prøvefaner ble lukket, fersk B gjenopprettet samme konto og hentet eksisterende betaling. Etter omlasting var tellingen fortsatt én reserveskriving og én sending; samme kvittering og lukket signeringsøkt. Se `evidence/prephysical-browser.json`.
- Eksisterende RAM-demoer på 4573/4574 og 4673/4674 er ikke startet på nytt.

## Ferdigstilt lokal operatør- og friksjonsblokk — 8. oktober

- Operatøren håndterer deploy, gass til mottaker og utstedelse separat. Den krever et eksakt transaksjonsforslag og en eksplisitt godkjenning før signeringsfilen åpnes. Forsøket lagres før signering, og transaksjonshashen før én sending. Etter tapt svar kontrolleres samme hash uten ny signering eller sending.
- Den opprinnelige blokken hadde 32 beståtte operatørtester. Etter en offentlig RPC-feil med HTTP 429 er operatøren utvidet med kø per tilbyder, minst 250 ms mellom forespørsler, lesende forhåndskontroll og begrenset feildiagnostikk. Ingen automatisk gjentakelse eller alternativ RPC er lagt til. Én eksplisitt `resume-unsigned` kan videreføre et intakt usignert journalforsøk med samme forslag, reserverte gassgrense og en egen uforanderlig revisjonspost; eksisterende signert forsøk kan bare kontrolleres. **41/41 avgrensede operatørtester bestod**, inkludert feil før signering, uendret journal, avvist ny videreføring og hash lagret før sending. Se `deploy/operator-validation.json` for lokal kjedeprøve. To klienter mot én lokal kjede beviser ikke uavhengige offentlige tilbydere.
- Reserveoppsett og gjenoppretting viser nå faktisk fremdrift og tydelig stoppstatus. Fullførte trinn foldes sammen. En konto kan åpnes før den offentlige kontrakten er på plass; brukeren kan kontrollere betalingsberedskap uten å miste den eksisterende nøkkelen. Antall native bekreftelser er ikke redusert eller lovet redusert.
- Den oppdaterte klienten er prøvd med syntetiske nøkler: separat reserve, A utilgjengelig, fersk B, samme konto, bekreftet lokal utbetaling og lukket signeringsøkt. Mobilvisning ved 320 og 390 px hadde ikke horisontal overflyt. Se `evidence/setup-progress-browser.json`. Den frosne fysiske prøven på 4873/4874 er urørt.
- Kildeeksporten bruker en eksplisitt bevisliste og utelater rå driftslogger, private innstillinger og transaksjonsjournaler. Personlige maskinstier erstattes bare i eksportkopier av leveransedokumentene. `npm run prepare:approval -- /ny/tom/mappe` fryser kildearkiv og deaktiverte klientpakker etter kontroll av test- og filhasher; dette oppretter ingen offentlig ressurs eller godkjenning.

## Klargjort leveranse og fullført kjedeprøve

- Separate Primary- og Reserve-Worker-pakker for Sites, med deaktivert standardprofil. De konkrete Primary- og Reserve-versjonene er nå offentlig publisert med de godkjente bindingene på B.
- Kryptert reserve-API med engangskapasitet for innmelding, atomisk opprettelse, 16-posters kvote og 64 KiB per post. Ny Redis-namespace holdes atskilt fra tidligere ContinuityKit-data. Utløp sletter den nye reserven; dette er synlig i klienten.
- Fastlåst Monad-testnetklient og separat Paris-kompilert kontrakt. De fire godkjente transaksjonene deploy, testgass, opptjent rettighet og innløsning er finalisert. Den avgrensede offentlige reserveprøven og kvitteringene står nedenfor.
- Innleveringstekst i `ENTRY_DRAFT.md`, dommerveiledning i `JUDGE_GUIDE.md`, fysisk prøve i `PHYSICAL_TEST.md` og konkret releasebeskrivelse i `PUBLIC_RELEASE_CANDIDATE.md`.
- Lokal kildepakke og filhasher bygges med `npm run pack:candidate`. Ingen lisens, npm-publisering eller GitHub-kildepublisering er valgt/utført gjennom denne leveransen. Opplasting av de avgrensede Sites-kildene er dokumentert nedenfor.

## Godkjent publisering fullført — 8. oktober

- **Primary er offentlig publisert:** https://continuitykit-account-primary.cryptomickle.chatgpt.site — versjon 4, miljørevisjon 2, vellykket deployment `appgdep_6ac7ec8f2088819193469b47065a5876`, kilderevisjon `b0d29fda812348698ed2e8906935d398b2b22dae`. Dette er den særskilt godkjente oppsettsrettingen. Den tidligere gjenåpningen etter bortfallsprøven og HTTP 200-kontrollen kl. 15:08:15 UTC gjaldt versjon 3.
- **Reserve er offentlig publisert:** https://continuitykit-account-reserve.cryptomickle.chatgpt.site — versjon 3, vellykket deployment `appgdep_6ac7ecdd01248191a425276773d938c5`, kilderevisjon `07989371b6dcb1e41aa028c81f1d06701f83dd26`. Miljørevisjon 1 er uendret med de tre avtalte `RESERVE_*`-bindingene; Redis-token og innmeldingshasher er hemmelige serververdier. Tidligere publiseringsversjoner er bevart som historisk bevis. Nytt publiseringsbevis: `evidence/enrollment-reuse-publication-2026-10-08.json`.
- Første Primary-deploy stoppet fordi Worker-klokken var null ved moduloppstart. Profilkontrollen kjøres nå ved forespørselen; 45-dagersgrensen, vertskontrollen og utløp er bevart. Hele den lokale verifikasjonen er kjørt på nytt, med resultatet ovenfor.
- **Én forespørsel til den offisielle gratis testnet-fauceten er utført.** Begge faste RPC-er bekreftet senere **5 test-MON** til ny issuer `0xda66935B528737205acf44bd347123a2FdD86916` i lesekontrollen 8. oktober kl. 13:27:40 UTC. Den tidligere HTTP-feilen hos den andre RPC-en gjelder faucet-øyeblikksbildet. Ingen automatisk ny faucet-forespørsel skal sendes.
- Den godkjente nye lagringsdelen er `account-reserve-660a8c6ea140bb95da482829aa5b2b1e`, med sletting **10. november 2026 kl. 01:00 norsk tid**, én klargjort engangstillatelse og teknisk kvote 16 poster à 64 KiB. Serverbindingen er fullført gjennom den godkjente innloggede Vercel-visningen og en minnebasert localhost-overføring; databasetokenet ble ikke skrevet til hemmelighetsfiler eller chat. Tidligere Sites, lagringsdel og den frosne fysiske prøven er urørt.
- **Ny offentlig A-konto er observert klar etter brukerens bekreftelse.** Mottaker er `0x3efc5827c9f2f25f8fd4000C4BF9318154dF1B85`; enhet og antall systembekreftelser er ikke dokumentert. B-oppsettet er nå observert fullført og uavhengig kontrollert for samme mottaker; brukeren rapporterte svært mange bekreftelser, uten eksakt antall. Kontrakten `0x738F3a0E2376a8e9AFf6A4440B0dBC77c22e6B4A` er nå deployert og finalisert; øvrig transaksjonsstatus står nedenfor.

Den første godkjenningen omfattet de to nye offentlige Sites, den avgrensede serverbindingen, to nye eksempelpasskeys og én separat gratis faucet-forespørsel. Mikkel har deretter svart **«jeg godtar»** på det konkrete firetransaksjonsforslaget og midlertidig bortfall/gjenåpning av bare nye Primary A. Denne separate godkjenningen er dokumentert i `artifacts/public-transactions-2026-10-08/user-approval.json`. Ingen ekstra konto, ekstra transaksjon, ekte penger, kildepublisering eller innlevering inngår. `artifacts/public-preparation-2026-10-08/phase-one-review.json` er bevart uendret som historisk øyeblikksbilde før godkjenningen; feltene der er ikke nåstatus.

Publiseringsbevis: `evidence/publication-2026-10-08.json`. A-kontoen er dokumentert i `artifacts/public-transactions-2026-10-08/review.json`. Det godkjente eksakte firetransaksjonsforslaget er `proposal.json` i samme mappe, SHA-256 `3606cb6606fa3f9ed1d2032c7251148180643c4b2bceae9836552cb824be4dd2`; `approval.json` er den avgrensede operatørbindingen. `readonly-preflight.json` viste ved kl. 13:27:40 UTC samsvar mellom begge RPC-er: issuer hadde 5 test-MON; mottaker og kontrakt null saldo; alle tre nonce 0 og tom kode. Innledende deploy-estimat var 379 811 gass, 455 774 med 20 % margin. Dette er et historisk øyeblikksbilde før utførelse; alle trinn kontrolleres ferskt før signering.

Første deploy-forsøk stoppet etter reservering og før journalført signert hash. En separat lesende reproduksjon viste HTTP 429 fra sekundær-RPC-en. Originaljournalen ble bevart; etter retting og lokale tester ble samme godkjente deploy videreført én gang med opprinnelig gassgrense. Se `readonly-sequence-diagnostic.json`, `paced-readonly-preflight.json`, `deploy-resume-result.json` og `deploy-finalized.json` i transaksjonsmappen. Den senere offentlige bortfalls-, gjenopprettings- og innløsningsprøven er nå fullført.

### Offentlig kjedestatus — 8. oktober kl. 15:07:59 UTC

| Godkjent trinn | Verifisert status | Bevis |
| --- | --- | --- |
| Deploy | Finalisert, blokk 69 270 636 | `artifacts/public-transactions-2026-10-08/deploy-finalized.json` |
| 0,06 test-MON til mottakers gass | Finalisert, blokk 69 270 839 | `artifacts/public-transactions-2026-10-08/fund-finalized.json` |
| Lås rettighet 1 med 0,10 test-MON | Finalisert, blokk 69 271 058 | `artifacts/public-transactions-2026-10-08/issue-finalized.json` |
| Innløsning etter fersk B-gjenoppretting | Finalisert, blokk 69 286 156 | `evidence/public-claim-finalized-2026-10-08.json` |

Begge faste RPC-er har bekreftet alle fire transaksjoner og tilhørende kontrakttilstand. Målt operatørgebyr er **0,062471634 test-MON**, claim-gebyr **0,007339716 test-MON**, samlet **0,069811350 test-MON**. Ingen ekte penger inngår. Innløsningen er `0x4e0598a6b6faa3774e7da445257b61fe10357395c93ae7c7d220ae2b507487a5`: rettighet 1, samme opprinnelige mottaker, 0,10 test-MON og `claimed=true`. Klienten viste **Payment collected** og lukket signeringsøkt. Bevis: `evidence/public-testnet-setup-2026-10-08.json`, `evidence/public-claim-finalized-2026-10-08.json` og `evidence/public-claim-success-2026-10-08.jpg`. To samsvarende RPC-er er bekreftelse fra to konfigurerte tilbydere, ikke en lettklient som selv verifiserer konsensus.

## Gjenstående før innleveringsklart bidrag

1. **Oppsettfriksjon og avgrensning:** rettingen som fjerner ett gjentatt WebAuthn-kall under nytt reserveoppsett er publisert som Primary 4 / Reserve 3. 318 tester og seks kontrolltrinn bestod; det forbedrede oppsettet er ikke fysisk prøvd. Mange native bekreftelser ble rapportert for den tidligere publiserte flyten; ny prompttelling og bred enhetsstøtte er ikke dokumentert. Den ferske B-fanen i den offentlige prøven beviser ikke gjenoppretting fra en annen nettleserprofil eller direkte iPhone-side. Ikke lov ett trykk, produksjonssikkerhet eller generell brukervennlighet.
2. **Kildepakke og konkurransepåstand:** dommertekst og innleveringsutkast er oppdatert, det offentlige beviset er samlet i `evidence/public-proof.json`, og gjeldende portal-, track- og sponsorvilkår er lest. Se `REQUIREMENTS_2026-10-08.md`. Logoen er klargjort i korrekt format. Ekstern etterspørsel, reell tredjepartsintegrasjon og premiepassform er fortsatt ikke bevist.
3. **Kildepublisering og innlevering:** velg lisens og innhent avgrenset godkjenning for gjennomgått kildepublisering og endelig innsending. Ingen ny GitHub-/npm-publisering eller konkurranseinnsending er utført. Video gjøres separat til slutt.

## Konkurransepåstanden må holdes smal

Den dokumenterte fordelen i den lokale og denne offentlige testnetprøven er filfri gjenfinning av en forberedt reserve for samme eksisterende konto, med bruk av en allerede utstedt rettighet etter A-bortfall. En korrekt beholdt kryptert eksport virker også. Denne løsningen krever mer oppsett, egen reserveklient og tilgjengelig lagring; generell brukervennlighet, etterspørsel, bedre sikkerhet og betalingsvilje er ikke bevist.

Many Keys er en sponsorhypotese, ikke en godkjent premiekategori for dette prosjektet. Hvis dommeren vurderer dette som bare wallet-backup/signering, er passformen svak. Ikke skjul at den bevarte hemmeligheten er en kontonøkkel. Ingen premie eller minsteutbetaling på USD 2500 er garantert.

Den nye portalkontrollen bekrefter at Many Keys krever samme native passkey på en annen enhet eller i en fersk nettleserprofil. Den observerte ferske fanen oppfyller ikke dette beviskravet. Den alternative Mera-UX-premien krever én passkey-seremoni under onboarding; dette er ikke dokumentert for kontoreserven. Trust-sporet vekter marked og traction samlet 45 %, og interne testresultater erstatter ikke disse delene.

## Kilde- og innleveringskontroll — 8. oktober

`ENTRY_DRAFT.md` og `JUDGE_GUIDE.md` beskriver nå den nye kontoreserven og skiller den native prøven på Primary 3 / Reserve 2 fra den senere oppsettsrettingen på Primary 4 / Reserve 3. En kontrollert logo på 1024 × 1024 px / 249 425 byte og deklarasjon av AI-assistanse er lagt til. De opprinnelige driftsbevisene er bevart; den offentlige bevisfilen inneholder bare utvalgte, etterprøvbare opplysninger.

Eksportverktøyet stopper ved manglende obligatorisk bevis, mistenkelige hemmelighetsfiler og symbolske/harde lenker. **8 egne eksporttester bestod**, i tillegg til den oppdaterte samlede kjøringen med **318 tester og seks beståtte stadier**. Dette er en begrenset eksportkontroll, ikke en garanti for at vilkårlig kildekode er uten hemmeligheter.

Portalen viste innlevering **0/5**, mens dashboardets **3/5** gjaldt profil/team/prosjekt. Fristen var **14. oktober kl. 05.59 norsk tid**. Regelverket krever offentlig GitHub-kode med åpen lisens, attribusjon og reell byggehistorikk, selv om skjemahjelpen også nevner privat deling. Lisens, offentlig kildepublisering og lagring av oppdatert bidrag er gjenstående handlinger. Ingen av disse er utført i denne lokale klargjøringen. Video er fortsatt utsatt.

B gjenoppretter full EOA-myndighet. A tilbakekalles ikke, kopierte nøkler kan ikke ugyldiggjøres av denne protokollen, og testresultater fjerner ikke personlig juridisk ansvar. Ingen ekte midler eller mainnet inngår.

## Nettleserretting — lokal klargjøringshistorikk 8. oktober

`release/paced-rpc.mjs` samordner appens lesekontroller og claim-klient i én kø per fast RPC på samme side, med minst 250 ms mellom forespørsler. Ingen automatisk ny sending eller alternativ tilbyder er lagt til. Dette reduserer appens egne forespørselsutbrudd, men garanterer ikke fravær av HTTP 429 på tvers av faner eller ved belastning hos tilbyderen. Feil etter signering beholder sperren mot ny sending. Den lokale klargjøringen er dokumentert i `evidence/browser-pacing-fix-2026-10-08.json`; publiseringen og prøven fulgte som beskrevet nedenfor.

Brukerens rapport om svært mange native bekreftelser er registrert som uløst friksjon. Fersk B-gjenoppretting har to WebAuthn-operasjoner; faktisk antall systembekreftelser varierer. Den separate forbedringen nedenfor unngår å hente det samme PRF-resultatet på nytt under førstegangsoppsett. Den ble publisert etter egen godkjenning og inngikk ikke i den tidligere nettverksrettingen.

## Offentlig nettverksretting og fullført bortfallsprøve

Brukeren godkjente den avgrensede rettingen med «ja». Primary versjon 3 og Reserve versjon 2 ble publisert; samme opprinnelser, nøkler, lagringsdel, kontrakt og grenser ble bevart. Under den godkjente midlertidige utkoblingen svarte A med HTTP 503 / `PRIMARY_OFFLINE`. Gamle oppsettsfaner ble lukket; fersk B-fane 10 gjenopprettet opprinnelig mottaker med eksisterende fysisk nøkkel og sendte den ene godkjente innløsningen. B viste **Payment collected** og lukket signeringsøkt. Deretter ble bare A-utkoblingsbindingen fjernet og samme versjon 3 gjenåpnet med miljørevisjon 2. HTTP 200 på både forsiden og konfigurasjonen bekreftet gjenåpningen kl. 15:08:15 UTC. Se `evidence/browser-pacing-publication-2026-10-08.json`, `evidence/public-outage-2026-10-08.json`, `evidence/public-claim-finalized-2026-10-08.json` og `evidence/public-primary-restored-http-2026-10-08.json`. Utkoblingsfilens felter om ventende gjenoppretting og claim er et historisk øyeblikksbilde før fullføringen.

## Redusert oppsettsarbeid — godkjent og publisert

`createReserveCredential` bruker opprettelsens PRF-resultat til å avlede midlertidig oppslags- og krypteringsmateriale. Det eksakte engangsobjektet kan brukes til forberedelsen innen samme avgrensede oppsett. Rå PRF-buffere nullstilles; avbrudd, utløp og feil stopper videre bruk. Hovedappen og utviklerpakken benytter denne veien. Eksisterende nøkkel fortsetter gjennom den tidligere kontrollveien.

Nytt B-oppsett bruker **én opprettelse og tre assertion-kall**, eller **én opprettelse og fire assertion-kall** når plattformen ikke leverer PRF-resultatet direkte ved opprettelsen. Begge variantene sparer ett assertion-kall fra tidligere fullstendig oppsett. Uavhengig kontroll etter lagring og fersk gjenoppretting er beholdt; sistnevnte bruker to assertion-kall. Dette er målte API-kall i syntetiske tester, ikke observerte Face ID-/systembekreftelser.

318 tester bestod: 135 kjernetester, 71 onboardingtester, 6 HTTP-kontroller og 106 release-tester, i tillegg til appbygg og begge Worker-bygg. Kodegjennomgang fant ingen blokkeringer. Etter brukerens «Ja» rapporterte Sites vellykket publisering av Primary 4 / Reserve 3 med uendrede miljørevisjoner 2 / 1. Se `evidence/verification.json`, `evidence/enrollment-reuse-2026-10-08.json`, `evidence/enrollment-reuse-publication-2026-10-08.json` og `delivery/ENROLLMENT_REUSE_REVIEW.md`. Den frosne gjennomgangspakken er bevart. Ingen ny fysisk nøkkel, fysisk oppsettsprøve eller offentlig transaksjon er utført for denne rettingen; SDK-en er fortsatt ikke publisert på npm.
