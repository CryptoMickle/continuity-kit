# Oppsettsretting publisert

Status: **godkjent og publisert på de to eksisterende demosidene**. 8. oktober 2026. Fysisk utprøving av det forbedrede oppsettet er fortsatt ikke utført.

## Endring

Førstegangsoppsettet gjenbruker resultatet fra opprettelsen av reservenøkkelen én gang. Dermed fjernes ett gjentatt passnøkkelkall i både hovedappen og utviklerpakken. Det midlertidige materialet er bundet til samme nøkkel og konfigurasjon, har høyst fem minutters levetid og lukkes ved avbrudd eller bruk.

| Syntetisk måling for nytt B-oppsett | Før | Etter |
| --- | --- | --- |
| Opprettelsen leverer PRF-resultat | 1 opprettelse + 4 assertions | 1 opprettelse + 3 assertions |
| Plattformen trenger ekstra PRF-kall etter opprettelsen | 1 opprettelse + 5 assertions | 1 opprettelse + 4 assertions |
| Fersk gjenoppretting | 2 assertions | 2 assertions |

Dette måler nettleserens nøkkelkall. Faktisk antall systembekreftelser må observeres separat; rettingen lover ikke én bekreftelse eller friksjonsfritt oppsett.

## Beholdte kontroller

Lagringsformat, appidentitet og nøkkelavledning er bevart. Oppsettet må fortsatt lese tilbake identiske lagrede bytes, åpne reserven gjennom den offentlige gjenopprettingsfunksjonen og verifisere en ny signatur fra samme opprinnelige konto. Vanlig gjenoppretting bruker ingen mellomlagret oppsettsinformasjon. Fortsettelse med eksisterende nøkkel har sin tidligere kontrollvei.

318 lokale tester bestod, fordelt på fire testsuiter, sammen med appbygg og begge Worker-bygg. Testene dekker feil nøkkel ved fallback, avbrudd, sent svar, utløp, engangsbruk, feil konfigurasjon, endret lagring og mislykket uavhengig kontroll. En separat kodegjennomgang fant ingen blokkeringer. Den rene utviklerpakken installeres, typesjekkes, bygges og gjenoppretter via sin egen lokale HTTP-tjeneste mens A er utilgjengelig.

## Fullført publisering

Den frosne pakken i `artifacts/enrollment-reuse-review-2026-10-08/` er publisert på de eksisterende **Account Primary**- og **Account Reserve**-sidene. Primary er versjon 4 med miljørevisjon 2; Reserve er versjon 3 med miljørevisjon 1. Sites rapporterte begge publiseringene som vellykkede. Eksisterende domener, serverbindinger, lagring, kontrakt, gebyrgrenser og utløpsdato er bevart. Ingen ny passkey, konto, testnet-transaksjon eller oppsettskode er opprettet. SDK-/GitHub-/npm-kildepublisering, konkurranseinnsending og video inngikk ikke.

Brukeren svarte «Ja» på forespørselen om denne avgrensede publiseringen. Godkjenningen er lagret separat i `artifacts/enrollment-reuse-review-2026-10-08/user-approval.json`; den frosne gjennomgangspakken er bevart som øyeblikksbildet før godkjenning. Den tidligere native prøven på Primary 3 / Reserve 2 dokumenterer fortsatt gjenoppretting og innløsning. Den dokumenterer ikke færre systembekreftelser med det nye førstegangsoppsettet. Eksisterende reserver er beholdt.

Bevis: `evidence/enrollment-reuse-publication-2026-10-08.json`, `evidence/enrollment-reuse-2026-10-08.json`, `evidence/verification.json` og den frosne pakkens `review.json`.
