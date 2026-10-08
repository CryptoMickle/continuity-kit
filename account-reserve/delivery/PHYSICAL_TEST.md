# Fysisk prøve — lokal og offentlig testnetgjenoppretting observert

Prøven gjelder den nye kontoreserven. Tidligere iPhone-bevis for notatgjenoppretting gjelder ikke denne protokollen. Video inngår ikke.

## Offentlig prøve fullført — 8. oktober 2026

Den nye Account Reserve-appen er nå også prøvd med native passkeys på de to godkjente HTTPS-opprinnelsene. B-oppsettet ble bekreftet lagret og uavhengig gjenåpnet. Brukeren rapporterte «veldig mange bekreftelser»; eksakt antall og enhetsfordeling er ukjent.

Primary A svarte HTTP 503 med `PRIMARY_OFFLINE`. Begge gamle oppsettsfaner ble lukket. En fersk B-fane gjenopprettet den opprinnelige kontoen `0x3efc5827c9f2f25f8fd4000C4BF9318154dF1B85` med eksisterende reservenøkkel og fant den utstedte rettigheten. Én godkjent `claim(1)` betalte 0,1 test-MON, og signeringsøkten ble lukket. Begge faste RPC-er bekreftet transaksjonen `0x4e0598a6b6faa3774e7da445257b61fe10357395c93ae7c7d220ae2b507487a5` som finalisert i blokk 69 286 156. Faktisk claim-gebyr var 0,007339716 test-MON.

Primary A er gjenåpnet med samme versjon 3; siden og konfigurasjonsendepunktet er kontrollert med HTTP 200. Bevis: `evidence/native-public-testnet-proof-2026-10-08.json`, `evidence/public-claim-finalized-2026-10-08.json` og `evidence/public-primary-restored-http-2026-10-08.json`.

Dette var en fersk fane i samme nettleser. Separat nettleserprofil, direkte iPhone-nettside og ny native gjenåpning etter denne offentlige utbetalingen er ikke prøvd. Oppsettsfriksjonen består. Resten av dokumentet nedenfor beskriver den tidligere, separate lokale prøven.

## Nøyaktig omfang

- To nye testpasskeys: `continuity-primary.localhost` og `continuity-reserve.localhost`.
- Én disponibel eksempel-EOA. B får samme fulle signeringsmyndighet som A; kontoen har bare verdiløse lokale testenheter.
- Uendret lokal kontrakt på kjede 31337. Ingen Monad-testnet/mainnet-transaksjon, offentlig publisering eller tredjepartskonto.
- Mennesket fullfører native passkey-/biometriprompter. Agenten kan ikke gjøre dette eller attestere antall promper fra API-kall.
- Testserveren startes særskilt med `--physical-approved` først etter konkret godkjenning. Syntetiske credential-endepunkter blir da deaktivert.

## Frosset kjøring

- Mappe: `<local-physical-snapshot>`.
- Snapshot SHA-256: `147db03ebd1c4252ef17192318d3560dc7ebb518b78fc909943f6a6f4dd1a15d`.
- A: `http://continuity-primary.localhost:4873/?model=iris`.
- B: `http://continuity-reserve.localhost:4874/?model=iris`.
- Filene, bygget, runtime-avhengighetene og Node/Anvil-programmene er hashkontrollert. Dette er ikke en signert sikkerhetssertifisering.
- `--verify-only` er tidligere kontrollert. Etter brukerens konkrete godkjenning ble `--physical-approved` startet 8. oktober. Konfigurasjonen viser fysisk modus og lokal kjede 31337; første observerte status har null syntetiske kall, null reserveposter og null kringkastinger via klientens RPC. Native A-opprettelse, B-oppsett og fersk B-gjenoppretting er nå observert. Brukeren rapporterte fem bekreftelser for reserveoppsettet. Primærappen og oppsettsfanen ble lukket, A ble verifisert utilgjengelig med HTTP 503, og fersk B viste samme konto og bekreftet lokal utbetaling. Kjedekvittering, samsvarende hendelse og kontraktstatus er kontrollert lesende: claim(1) lyktes i blokk 3, samme mottaker og claimed=true. Promptantall for gjenoppretting og direkte iPhone-nettside er ikke dokumentert. Se `evidence/physical-run-2026-10-08.json`. Den gamle demoen på 4573/4574 og utviklerdemoen på 4673/4674 beholdes.
- Nettverkssperren gjelder Node/Anvil-prosesstreet. Nettleseren og operativsystemets passkey-leverandør omfattes ikke; eventuell iCloud-/telefonkommunikasjon styres av disse.
- Fysisk kjøring bruker RAM. Ikke restart under prøven; da forsvinner kryptert reserve og lokal kjede. Stopp sletter ikke passkeys fra passordbehandleren.

Kommandoen som allerede er startet etter godkjenning (ikke start på nytt under prøven):

```sh
/opt/homebrew/opt/node@24/bin/node <local-physical-snapshot>/start-physical.mjs --physical-approved
```

## Forløp

1. Åpne primærklienten i Mac-nettleseren. Trykk **Create example account** og bekreft opprettelse av den første testpasskeyen.
2. Trykk **Prepare independent reserve**. I B-vinduet, les at den nye reserven får myndighet for samme konto, og trykk **Prepare this reserve**. Opprett B-passkeyen og fullfør eventuelle påfølgende åpninger. Mera kan utløse flere bekreftelser; ikke avbryt mellom de to åpningene bare fordi de ser like ut.
3. Bare hvis appen viser **Reserve prepared and independently checked**, slå A av med testkontrollen. Agenten kontrollerer at A og A sitt API returnerer 503, og lukker A-fanen.
4. Åpne en fersk B-klient. Velg **eksisterende B-passkey**, aldri en ny nøkkel. Agenten kontrollerer samme adresse og samme allerede opptjente rettighet.
5. Utfør én lokal testbetaling. Kontroller kvittering og at ny lasting viser tidligere betaling uten ny sending.

For sponsorens andre-klient-/enhetskrav må den samme B-passkeyen også brukes fra en separat godkjent nettleserprofil eller fysisk klient. En iPhone brukt som authenticator for Mac-en er ikke automatisk bevis for at nettsiden er åpnet på iPhone. `localhost` på iPhone peker på iPhone; direkte iPhone-nettsideprøve krever senere godkjent HTTPS-publisering eller et eget avklart nettverksoppsett.

## Dokumenter bare det som observeres

Nettleser/versjon, hvilken fysisk enhet som fullførte autentiseringen, faktiske bekreftelser slik de observeres, samme autentiserte konto, oppsettstatus, A sitt bortfall og lokal transaksjonskvittering. Ikke be om passkey-hemmeligheter, Face ID-data, gjenopprettingskoder eller iCloud-passord.

Ved avbrudd: behold eventuell opprettet passkey. En mislykket reserve opprettes ikke automatisk på nytt. Uklar transaksjonsstatus kontrolleres fra den eksisterende billetten. Sletting av testnøkler og nullstilling av tvetydige transaksjonsbilletter inngår ikke automatisk i prøven.

## Ved avbrutt oppsett

Åpne **Open existing example account** i A. Bruk samme A-passkey. Start reserveoppsettet på nytt fra den åpne kontoen, og velg **Continue with existing reserve passkey** i B hvis B-nøkkelen allerede ble opprettet. En eksisterende reserve bekreftes uten ny skriving. Ved uklar skriving velges først **Check existing reserve**; ingen automatisk ny nøkkel, overskriving eller ny transaksjon inngår.
