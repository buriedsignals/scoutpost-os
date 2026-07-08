/**
 * Email UI strings for 12 languages. Port of backend/app/services/email_translations.py.
 *
 * Phase 1 ports the static string dict only. The legacy module also did LLM-based
 * batch title translation via OpenRouter; that is deferred — article titles in
 * Beat Scout emails render in their source language until phase 2 lands.
 *
 * "Smart Scout" → "Beat Scout" rename: applied in every locale. DB `scout.type`
 * enum stays `beat` — only the user-facing label changes.
 */

type StringMap = Record<string, string>;

export const SUPPORTED_LANGUAGES = [
  "en",
  "no",
  "de",
  "fr",
  "es",
  "it",
  "pt",
  "nl",
  "sv",
  "da",
  "fi",
  "pl",
] as const;

export type SupportedLanguage = typeof SUPPORTED_LANGUAGES[number];

export const EMAIL_STRINGS: Record<string, StringMap> = {
  en: {
    archived_evidence: "Archived evidence",
    view_archived_snapshot: "View archived snapshot",
    scout_alert: "Scout Alert!",
    top_stories: "Top Stories",
    matching_results: "Matching Results",
    key_findings: "Key Findings:",
    your_criteria: "Your Criteria",
    view_in_cojournalist: "View in coJournalist",
    view_source: "View source",
    and_more: "... and {count} more matching records",
    monitoring_url: "Monitoring URL",
    criteria: "Criteria",
    page_scout: "Page Scout",
    beat_scout: "Beat Scout",
    civic_scout: "Civic Scout",
    social_scout: "Social Scout Update",
    new_posts: "New Posts",
    removed_posts: "Removed Posts",
    removed_label: "Removed:",
    profile_label: "Profile",
    government_municipal: "Government & Municipal",
    civic_digest: "Civic Digest",
    promise_due_today_singular: "{count} promise due today",
    promise_due_today_plural: "{count} promises due today",
    due_label: "due",
    scout_paused: "Scout Paused",
    scout_health: "Scout Health",
    scout_type: "Scout Type",
    consecutive_failures: "Consecutive Failures",
    scout_paused_summary:
      "**{name}** was paused after {count} consecutive failures. Re-enable it in the dashboard once the issue is resolved.",
    see_what_matched: "See what matched",
    email_disclaimer:
      "This email contains AI-processed content. coJournalist is a research assistant, not a news source. Always verify with original sources before publication.",
    page_scout_cue:
      "AI detected changes matching your criteria \u2014 review the page directly.",
    beat_scout_cue:
      "Facts were automatically extracted \u2014 click through to original articles.",
    civic_scout_cue:
      "Extracted by AI \u2014 verify against original council documents.",
    social_scout_cue:
      "Social data scraped from platform \u2014 may be incomplete.",
  },
  no: {
    archived_evidence: "Arkivert bevis",
    view_archived_snapshot: "Vis arkivert øyeblikksbilde",
    scout_alert: "Scout-varsling!",
    top_stories: "Toppsaker",
    matching_results: "Treff",
    key_findings: "Hovedfunn:",
    your_criteria: "Dine kriterier",
    view_in_cojournalist: "Se i coJournalist",
    view_source: "Se kilde",
    and_more: "... og {count} flere treff",
    monitoring_url: "Overv\u00e5ker URL",
    criteria: "Kriterier",
    page_scout: "Page Scout",
    beat_scout: "Beat Scout",
    civic_scout: "Civic Scout",
    social_scout: "Social Scout-oppdatering",
    new_posts: "Nye innlegg",
    removed_posts: "Fjernede innlegg",
    removed_label: "Fjernet:",
    profile_label: "Profil",
    government_municipal: "Kommunalt og offentlig",
    civic_digest: "Civic Digest",
    promise_due_today_singular: "{count} l\u00f8fte forfaller i dag",
    promise_due_today_plural: "{count} l\u00f8fter forfaller i dag",
    due_label: "forfaller",
    scout_paused: "Scout satt p\u00e5 pause",
    scout_health: "Scout-helse",
    scout_type: "Scout-type",
    consecutive_failures: "Sammenhengende feil",
    scout_paused_summary:
      "**{name}** ble satt p\u00e5 pause etter {count} sammenhengende feil. Aktiver den igjen i dashbordet n\u00e5r problemet er l\u00f8st.",
    see_what_matched: "Se hva som matchet",
    email_disclaimer:
      "Denne e-posten inneholder AI-behandlet innhold. coJournalist er en forskningsassistent, ikke en nyhetskilde. Verifiser alltid med originalkildene.",
    page_scout_cue:
      "AI oppdaget endringer som samsvarer med kriteriene dine \u2014 gjennomg\u00e5 siden direkte.",
    beat_scout_cue:
      "Fakta ble automatisk hentet ut \u2014 klikk videre til originalartiklene.",
    civic_scout_cue:
      "Hentet ut av AI \u2014 verifiser mot originale kommunedokumenter.",
    social_scout_cue:
      "Sosiale data hentet fra plattformen \u2014 kan v\u00e6re ufullstendige.",
  },
  de: {
    archived_evidence: "Archivierte Beweise",
    view_archived_snapshot: "Archivierte Momentaufnahme ansehen",
    scout_alert: "Scout-Alarm!",
    top_stories: "Top-Meldungen",
    matching_results: "Passende Ergebnisse",
    key_findings: "Wichtige Erkenntnisse:",
    your_criteria: "Ihre Kriterien",
    view_in_cojournalist: "In coJournalist ansehen",
    view_source: "Quelle ansehen",
    and_more: "... und {count} weitere Treffer",
    monitoring_url: "\u00dcberwachte URL",
    criteria: "Kriterien",
    page_scout: "Page Scout",
    beat_scout: "Beat Scout",
    civic_scout: "Civic Scout",
    social_scout: "Social Scout-Update",
    new_posts: "Neue Beitr\u00e4ge",
    removed_posts: "Entfernte Beitr\u00e4ge",
    removed_label: "Entfernt:",
    profile_label: "Profil",
    government_municipal: "Kommunalpolitik & Beh\u00f6rden",
    civic_digest: "Civic Digest",
    promise_due_today_singular: "{count} Zusage ist heute f\u00e4llig",
    promise_due_today_plural: "{count} Zusagen sind heute f\u00e4llig",
    due_label: "f\u00e4llig",
    scout_paused: "Scout pausiert",
    scout_health: "Scout-Zustand",
    scout_type: "Scout-Typ",
    consecutive_failures: "Aufeinanderfolgende Fehler",
    scout_paused_summary:
      "**{name}** wurde nach {count} aufeinanderfolgenden Fehlern pausiert. Aktivieren Sie den Scout im Dashboard erneut, sobald das Problem behoben ist.",
    see_what_matched: "Treffer ansehen",
    email_disclaimer:
      "Diese E-Mail enth\u00e4lt KI-verarbeitete Inhalte. coJournalist ist ein Recherche-Assistent, keine Nachrichtenquelle. \u00dcberpr\u00fcfen Sie Informationen immer anhand der Originalquellen.",
    page_scout_cue:
      "KI hat \u00c4nderungen erkannt, die Ihren Kriterien entsprechen \u2014 \u00fcberpr\u00fcfen Sie die Seite direkt.",
    beat_scout_cue:
      "Fakten wurden automatisch extrahiert \u2014 klicken Sie auf die Originalartikel.",
    civic_scout_cue:
      "Von KI extrahiert \u2014 \u00fcberpr\u00fcfen Sie anhand der Original-Ratsdokumente.",
    social_scout_cue:
      "Soziale Daten von der Plattform abgerufen \u2014 m\u00f6glicherweise unvollst\u00e4ndig.",
  },
  fr: {
    archived_evidence: "Preuve archivée",
    view_archived_snapshot: "Voir l'instantané archivé",
    scout_alert: "Alerte Scout !",
    top_stories: "\u00c0 la une",
    matching_results: "R\u00e9sultats correspondants",
    key_findings: "Principales d\u00e9couvertes :",
    your_criteria: "Vos crit\u00e8res",
    view_in_cojournalist: "Voir dans coJournalist",
    view_source: "Voir la source",
    and_more: "... et {count} autres r\u00e9sultats",
    monitoring_url: "URL surveill\u00e9e",
    criteria: "Crit\u00e8res",
    page_scout: "Page Scout",
    beat_scout: "Beat Scout",
    civic_scout: "Civic Scout",
    social_scout: "Mise \u00e0 jour Social Scout",
    new_posts: "Nouveaux posts",
    removed_posts: "Posts supprim\u00e9s",
    removed_label: "Supprim\u00e9 :",
    profile_label: "Profil",
    government_municipal: "Gouvernement & Municipalit\u00e9",
    civic_digest: "Digest Civic",
    promise_due_today_singular:
      "{count} promesse arrive \u00e0 \u00e9ch\u00e9ance aujourd'hui",
    promise_due_today_plural:
      "{count} promesses arrivent \u00e0 \u00e9ch\u00e9ance aujourd'hui",
    due_label: "\u00e9ch\u00e9ance",
    scout_paused: "Scout en pause",
    scout_health: "Sant\u00e9 du Scout",
    scout_type: "Type de Scout",
    consecutive_failures: "\u00c9checs cons\u00e9cutifs",
    scout_paused_summary:
      "**{name}** a \u00e9t\u00e9 mis en pause apr\u00e8s {count} \u00e9checs cons\u00e9cutifs. R\u00e9activez-le dans le tableau de bord une fois le probl\u00e8me r\u00e9solu.",
    see_what_matched: "Voir le r\u00e9sultat",
    email_disclaimer:
      "Cet e-mail contient du contenu trait\u00e9 par IA. coJournalist est un assistant de recherche, pas une source d'information. V\u00e9rifiez toujours aupr\u00e8s des sources originales.",
    page_scout_cue:
      "L'IA a d\u00e9tect\u00e9 des changements correspondant \u00e0 vos crit\u00e8res \u2014 consultez la page directement.",
    beat_scout_cue:
      "Les faits ont \u00e9t\u00e9 extraits automatiquement \u2014 cliquez pour acc\u00e9der aux articles originaux.",
    civic_scout_cue:
      "Extrait par IA \u2014 v\u00e9rifiez avec les documents originaux du conseil.",
    social_scout_cue:
      "Donn\u00e9es sociales extraites de la plateforme \u2014 peuvent \u00eatre incompl\u00e8tes.",
  },
  es: {
    archived_evidence: "Evidencia archivada",
    view_archived_snapshot: "Ver la instantánea archivada",
    scout_alert: "\u00a1Alerta de Scout!",
    top_stories: "Noticias destacadas",
    matching_results: "Resultados coincidentes",
    key_findings: "Hallazgos clave:",
    your_criteria: "Sus criterios",
    view_in_cojournalist: "Ver en coJournalist",
    view_source: "Ver fuente",
    and_more: "... y {count} resultados m\u00e1s",
    monitoring_url: "URL monitoreada",
    criteria: "Criterios",
    page_scout: "Page Scout",
    beat_scout: "Beat Scout",
    civic_scout: "Civic Scout",
    social_scout: "Actualizaci\u00f3n de Social Scout",
    new_posts: "Nuevas publicaciones",
    removed_posts: "Publicaciones eliminadas",
    removed_label: "Eliminado:",
    profile_label: "Perfil",
    government_municipal: "Gobierno y Municipio",
    civic_digest: "Resumen Civic",
    promise_due_today_singular: "{count} promesa vence hoy",
    promise_due_today_plural: "{count} promesas vencen hoy",
    due_label: "vence",
    scout_paused: "Scout en pausa",
    scout_health: "Estado del Scout",
    scout_type: "Tipo de Scout",
    consecutive_failures: "Fallos consecutivos",
    scout_paused_summary:
      "**{name}** se paus\u00f3 despu\u00e9s de {count} fallos consecutivos. Vuelva a activarlo en el panel cuando el problema est\u00e9 resuelto.",
    see_what_matched: "Ver el resultado",
    email_disclaimer:
      "Este correo contiene contenido procesado por IA. coJournalist es un asistente de investigaci\u00f3n, no una fuente de noticias. Verifique siempre con las fuentes originales.",
    page_scout_cue:
      "La IA detect\u00f3 cambios que coinciden con sus criterios \u2014 revise la p\u00e1gina directamente.",
    beat_scout_cue:
      "Los hechos fueron extra\u00eddos autom\u00e1ticamente \u2014 haga clic en los art\u00edculos originales.",
    civic_scout_cue:
      "Extra\u00eddo por IA \u2014 verifique con los documentos originales del consejo.",
    social_scout_cue:
      "Datos sociales obtenidos de la plataforma \u2014 pueden estar incompletos.",
  },
  it: {
    archived_evidence: "Prova archiviata",
    view_archived_snapshot: "Vedi l'istantanea archiviata",
    scout_alert: "Avviso Scout!",
    top_stories: "Notizie principali",
    matching_results: "Risultati corrispondenti",
    key_findings: "Risultati chiave:",
    your_criteria: "I tuoi criteri",
    view_in_cojournalist: "Visualizza in coJournalist",
    view_source: "Vedi fonte",
    and_more: "... e altri {count} risultati",
    monitoring_url: "URL monitorato",
    criteria: "Criteri",
    page_scout: "Page Scout",
    beat_scout: "Beat Scout",
    civic_scout: "Civic Scout",
    social_scout: "Aggiornamento Social Scout",
    new_posts: "Nuovi post",
    removed_posts: "Post rimossi",
    removed_label: "Rimosso:",
    profile_label: "Profilo",
    government_municipal: "Governo e Municipio",
    civic_digest: "Digest Civic",
    promise_due_today_singular: "{count} promessa in scadenza oggi",
    promise_due_today_plural: "{count} promesse in scadenza oggi",
    due_label: "scadenza",
    scout_paused: "Scout in pausa",
    scout_health: "Stato Scout",
    scout_type: "Tipo di Scout",
    consecutive_failures: "Errori consecutivi",
    scout_paused_summary:
      "**{name}** \u00e8 stato messo in pausa dopo {count} errori consecutivi. Riattivalo nella dashboard quando il problema sar\u00e0 risolto.",
    see_what_matched: "Vedi il risultato",
    email_disclaimer:
      "Questa email contiene contenuti elaborati dall'IA. coJournalist \u00e8 un assistente di ricerca, non una fonte di notizie. Verificare sempre con le fonti originali.",
    page_scout_cue:
      "L'IA ha rilevato modifiche corrispondenti ai tuoi criteri \u2014 controlla la pagina direttamente.",
    beat_scout_cue:
      "I fatti sono stati estratti automaticamente \u2014 clicca per leggere gli articoli originali.",
    civic_scout_cue:
      "Estratto dall'IA \u2014 verificare con i documenti originali del consiglio.",
    social_scout_cue:
      "Dati social estratti dalla piattaforma \u2014 potrebbero essere incompleti.",
  },
  pt: {
    archived_evidence: "Evidência arquivada",
    view_archived_snapshot: "Ver instantâneo arquivado",
    scout_alert: "Alerta de Scout!",
    top_stories: "Principais not\u00edcias",
    matching_results: "Resultados correspondentes",
    key_findings: "Principais descobertas:",
    your_criteria: "Seus crit\u00e9rios",
    view_in_cojournalist: "Ver no coJournalist",
    view_source: "Ver fonte",
    and_more: "... e mais {count} resultados",
    monitoring_url: "URL monitorada",
    criteria: "Crit\u00e9rios",
    page_scout: "Page Scout",
    beat_scout: "Beat Scout",
    civic_scout: "Civic Scout",
    social_scout: "Atualiza\u00e7\u00e3o do Social Scout",
    new_posts: "Novas publica\u00e7\u00f5es",
    removed_posts: "Publica\u00e7\u00f5es removidas",
    removed_label: "Removido:",
    profile_label: "Perfil",
    government_municipal: "Governo e Munic\u00edpio",
    civic_digest: "Digest Civic",
    promise_due_today_singular: "{count} promessa vence hoje",
    promise_due_today_plural: "{count} promessas vencem hoje",
    due_label: "vence",
    scout_paused: "Scout em pausa",
    scout_health: "Sa\u00fade do Scout",
    scout_type: "Tipo de Scout",
    consecutive_failures: "Falhas consecutivas",
    scout_paused_summary:
      "**{name}** foi colocado em pausa ap\u00f3s {count} falhas consecutivas. Reative-o no painel quando o problema estiver resolvido.",
    see_what_matched: "Ver o resultado",
    email_disclaimer:
      "Este email cont\u00e9m conte\u00fado processado por IA. coJournalist \u00e9 um assistente de pesquisa, n\u00e3o uma fonte de not\u00edcias. Verifique sempre com as fontes originais.",
    page_scout_cue:
      "A IA detectou altera\u00e7\u00f5es que correspondem aos seus crit\u00e9rios \u2014 revise a p\u00e1gina diretamente.",
    beat_scout_cue:
      "Os factos foram extra\u00eddos automaticamente \u2014 clique nos artigos originais.",
    civic_scout_cue:
      "Extra\u00eddo por IA \u2014 verifique com os documentos originais do conselho.",
    social_scout_cue:
      "Dados sociais extra\u00eddos da plataforma \u2014 podem estar incompletos.",
  },
  nl: {
    archived_evidence: "Gearchiveerd bewijs",
    view_archived_snapshot: "Gearchiveerde momentopname bekijken",
    scout_alert: "Scout-melding!",
    top_stories: "Topverhalen",
    matching_results: "Overeenkomende resultaten",
    key_findings: "Belangrijkste bevindingen:",
    your_criteria: "Uw criteria",
    view_in_cojournalist: "Bekijk in coJournalist",
    view_source: "Bekijk bron",
    and_more: "... en nog {count} resultaten",
    monitoring_url: "Gemonitorde URL",
    criteria: "Criteria",
    page_scout: "Page Scout",
    beat_scout: "Beat Scout",
    civic_scout: "Civic Scout",
    social_scout: "Social Scout-update",
    new_posts: "Nieuwe berichten",
    removed_posts: "Verwijderde berichten",
    removed_label: "Verwijderd:",
    profile_label: "Profiel",
    government_municipal: "Overheid & Gemeente",
    civic_digest: "Civic Digest",
    promise_due_today_singular: "{count} belofte moet vandaag worden nagekomen",
    promise_due_today_plural:
      "{count} beloftes moeten vandaag worden nagekomen",
    due_label: "vervalt",
    scout_paused: "Scout gepauzeerd",
    scout_health: "Scout-status",
    scout_type: "Scout-type",
    consecutive_failures: "Opeenvolgende fouten",
    scout_paused_summary:
      "**{name}** is gepauzeerd na {count} opeenvolgende fouten. Activeer de scout opnieuw in het dashboard zodra het probleem is opgelost.",
    see_what_matched: "Bekijk het resultaat",
    email_disclaimer:
      "Deze e-mail bevat door AI verwerkte inhoud. coJournalist is een onderzoeksassistent, geen nieuwsbron. Controleer altijd bij de originele bronnen.",
    page_scout_cue:
      "AI heeft wijzigingen gedetecteerd die overeenkomen met uw criteria \u2014 bekijk de pagina direct.",
    beat_scout_cue:
      "Feiten zijn automatisch ge\u00ebxtraheerd \u2014 klik door naar de originele artikelen.",
    civic_scout_cue:
      "Ge\u00ebxtraheerd door AI \u2014 verifieer met de originele raadsdocumenten.",
    social_scout_cue:
      "Sociale gegevens verzameld van platform \u2014 mogelijk onvolledig.",
  },
  sv: {
    archived_evidence: "Arkiverat bevis",
    view_archived_snapshot: "Visa arkiverad ögonblicksbild",
    scout_alert: "Scout-varning!",
    top_stories: "Toppnyheter",
    matching_results: "Matchande resultat",
    key_findings: "Viktiga fynd:",
    your_criteria: "Dina kriterier",
    view_in_cojournalist: "Visa i coJournalist",
    view_source: "Visa k\u00e4lla",
    and_more: "... och {count} fler tr\u00e4ffar",
    monitoring_url: "\u00d6vervakad URL",
    criteria: "Kriterier",
    page_scout: "Page Scout",
    beat_scout: "Beat Scout",
    civic_scout: "Civic Scout",
    social_scout: "Social Scout-uppdatering",
    new_posts: "Nya inl\u00e4gg",
    removed_posts: "Borttagna inl\u00e4gg",
    removed_label: "Borttaget:",
    profile_label: "Profil",
    government_municipal: "Kommunalt & Offentligt",
    civic_digest: "Civic Digest",
    promise_due_today_singular: "{count} l\u00f6fte f\u00f6rfaller idag",
    promise_due_today_plural: "{count} l\u00f6ften f\u00f6rfaller idag",
    due_label: "f\u00f6rfaller",
    scout_paused: "Scout pausad",
    scout_health: "Scout-h\u00e4lsa",
    scout_type: "Scout-typ",
    consecutive_failures: "Fel i rad",
    scout_paused_summary:
      "**{name}** pausades efter {count} fel i rad. Aktivera den igen i instrumentpanelen n\u00e4r problemet \u00e4r l\u00f6st.",
    see_what_matched: "Se tr\u00e4ffen",
    email_disclaimer:
      "Detta e-postmeddelande inneh\u00e5ller AI-bearbetat inneh\u00e5ll. coJournalist \u00e4r en forskningsassistent, inte en nyhetsk\u00e4lla. Verifiera alltid med originalk\u00e4llorna.",
    page_scout_cue:
      "AI uppt\u00e4ckte \u00e4ndringar som matchar dina kriterier \u2014 granska sidan direkt.",
    beat_scout_cue:
      "Fakta extraherades automatiskt \u2014 klicka vidare till originalartiklarna.",
    civic_scout_cue:
      "Extraherat av AI \u2014 verifiera mot originalhandlingar fr\u00e5n kommunen.",
    social_scout_cue:
      "Sociala data h\u00e4mtade fr\u00e5n plattformen \u2014 kan vara ofullst\u00e4ndiga.",
  },
  da: {
    archived_evidence: "Arkiveret bevis",
    view_archived_snapshot: "Se arkiveret øjebliksbillede",
    scout_alert: "Scout-advarsel!",
    top_stories: "Tophistorier",
    matching_results: "Matchende resultater",
    key_findings: "Vigtige fund:",
    your_criteria: "Dine kriterier",
    view_in_cojournalist: "Se i coJournalist",
    view_source: "Se kilde",
    and_more: "... og {count} flere resultater",
    monitoring_url: "Overv\u00e5get URL",
    criteria: "Kriterier",
    page_scout: "Page Scout",
    beat_scout: "Beat Scout",
    civic_scout: "Civic Scout",
    social_scout: "Social Scout-opdatering",
    new_posts: "Nye opslag",
    removed_posts: "Fjernede opslag",
    removed_label: "Fjernet:",
    profile_label: "Profil",
    government_municipal: "Kommunalt & Offentligt",
    civic_digest: "Civic Digest",
    promise_due_today_singular: "{count} l\u00f8fte forfalder i dag",
    promise_due_today_plural: "{count} l\u00f8fter forfalder i dag",
    due_label: "forfalder",
    scout_paused: "Scout sat p\u00e5 pause",
    scout_health: "Scout-status",
    scout_type: "Scout-type",
    consecutive_failures: "Fejl i tr\u00e6k",
    scout_paused_summary:
      "**{name}** blev sat p\u00e5 pause efter {count} fejl i tr\u00e6k. Aktiv\u00e9r den igen i dashboardet, n\u00e5r problemet er l\u00f8st.",
    see_what_matched: "Se resultatet",
    email_disclaimer:
      "Denne e-mail indeholder AI-behandlet indhold. coJournalist er en forskningsassistent, ikke en nyhedskilde. Verificer altid med de originale kilder.",
    page_scout_cue:
      "AI fandt \u00e6ndringer der matcher dine kriterier \u2014 gennemg\u00e5 siden direkte.",
    beat_scout_cue:
      "Fakta blev automatisk udtrukket \u2014 klik videre til de originale artikler.",
    civic_scout_cue:
      "Udtrukket af AI \u2014 verificer med de originale kommunale dokumenter.",
    social_scout_cue:
      "Sociale data hentet fra platformen \u2014 kan v\u00e6re ufuldst\u00e6ndige.",
  },
  fi: {
    archived_evidence: "Arkistoitu todiste",
    view_archived_snapshot: "Näytä arkistoitu tilannekuva",
    scout_alert: "Scout-h\u00e4lytys!",
    top_stories: "P\u00e4\u00e4uutiset",
    matching_results: "Vastaavat tulokset",
    key_findings: "T\u00e4rkeimm\u00e4t l\u00f6yd\u00f6kset:",
    your_criteria: "Kriteerisi",
    view_in_cojournalist: "Katso coJournalistissa",
    view_source: "N\u00e4yt\u00e4 l\u00e4hde",
    and_more: "... ja {count} muuta tulosta",
    monitoring_url: "Valvottu URL",
    criteria: "Kriteerit",
    page_scout: "Page Scout",
    beat_scout: "Beat Scout",
    civic_scout: "Civic Scout",
    social_scout: "Social Scout -p\u00e4ivitys",
    new_posts: "Uudet julkaisut",
    removed_posts: "Poistetut julkaisut",
    removed_label: "Poistettu:",
    profile_label: "Profiili",
    government_municipal: "Hallinto ja kunta",
    civic_digest: "Civic Digest",
    promise_due_today_singular:
      "{count} lupaus er\u00e4\u00e4ntyy t\u00e4n\u00e4\u00e4n",
    promise_due_today_plural:
      "{count} lupausta er\u00e4\u00e4ntyy t\u00e4n\u00e4\u00e4n",
    due_label: "er\u00e4\u00e4ntyy",
    scout_paused: "Scout keskeytetty",
    scout_health: "Scoutin tila",
    scout_type: "Scout-tyyppi",
    consecutive_failures: "Per\u00e4kk\u00e4iset virheet",
    scout_paused_summary:
      "**{name}** keskeytettiin {count} per\u00e4kk\u00e4isen virheen j\u00e4lkeen. Ota se uudelleen k\u00e4ytt\u00f6\u00f6n hallintapaneelissa, kun ongelma on ratkaistu.",
    see_what_matched: "N\u00e4yt\u00e4 osuma",
    email_disclaimer:
      "T\u00e4m\u00e4 s\u00e4hk\u00f6posti sis\u00e4lt\u00e4\u00e4 teko\u00e4lyn k\u00e4sittelem\u00e4\u00e4 sis\u00e4lt\u00f6\u00e4. coJournalist on tutkimusavustaja, ei uutisl\u00e4hde. Tarkista aina alkuper\u00e4isist\u00e4 l\u00e4hteist\u00e4.",
    page_scout_cue:
      "Teko\u00e4ly havaitsi kriteerej\u00e4si vastaavia muutoksia \u2014 tarkista sivu suoraan.",
    beat_scout_cue:
      "Tiedot poimittiin automaattisesti \u2014 siirry alkuper\u00e4isiin artikkeleihin.",
    civic_scout_cue:
      "Teko\u00e4lyn poimima \u2014 tarkista alkuper\u00e4isist\u00e4 valtuuston asiakirjoista.",
    social_scout_cue:
      "Sosiaalisen median tiedot haettu alustalta \u2014 voivat olla puutteellisia.",
  },
  pl: {
    archived_evidence: "Zarchiwizowany dowód",
    view_archived_snapshot: "Zobacz zarchiwizowany zrzut",
    scout_alert: "Alert Scout!",
    top_stories: "Najwa\u017cniejsze wiadomo\u015bci",
    matching_results: "Pasuj\u0105ce wyniki",
    key_findings: "Kluczowe odkrycia:",
    your_criteria: "Twoje kryteria",
    view_in_cojournalist: "Zobacz w coJournalist",
    view_source: "Zobacz \u017ar\u00f3d\u0142o",
    and_more: "... i {count} wi\u0119cej wynik\u00f3w",
    monitoring_url: "Monitorowany URL",
    criteria: "Kryteria",
    page_scout: "Page Scout",
    beat_scout: "Beat Scout",
    civic_scout: "Civic Scout",
    social_scout: "Aktualizacja Social Scout",
    new_posts: "Nowe posty",
    removed_posts: "Usuni\u0119te posty",
    removed_label: "Usuni\u0119to:",
    profile_label: "Profil",
    government_municipal: "Rz\u0105d i samorz\u0105d",
    civic_digest: "Civic Digest",
    promise_due_today_singular: "{count} obietnica jest dzi\u015b wymagalna",
    promise_due_today_plural: "{count} obietnice s\u0105 dzi\u015b wymagalne",
    due_label: "termin",
    scout_paused: "Scout wstrzymany",
    scout_health: "Stan Scouta",
    scout_type: "Typ Scouta",
    consecutive_failures: "Kolejne niepowodzenia",
    scout_paused_summary:
      "**{name}** zosta\u0142 wstrzymany po {count} kolejnych niepowodzeniach. W\u0142\u0105cz go ponownie w panelu, gdy problem zostanie rozwi\u0105zany.",
    see_what_matched: "Zobacz wynik",
    email_disclaimer:
      "Ta wiadomo\u015b\u0107 zawiera tre\u015bci przetworzone przez AI. coJournalist to asystent badawczy, nie \u017ar\u00f3d\u0142o wiadomo\u015bci. Zawsze weryfikuj z oryginalnymi \u017ar\u00f3d\u0142ami.",
    page_scout_cue:
      "AI wykry\u0142a zmiany pasuj\u0105ce do Twoich kryteri\u00f3w \u2014 sprawd\u017a stron\u0119 bezpo\u015brednio.",
    beat_scout_cue:
      "Fakty zosta\u0142y automatycznie wyodr\u0119bnione \u2014 kliknij, aby przej\u015b\u0107 do oryginalnych artyku\u0142\u00f3w.",
    civic_scout_cue:
      "Wyodr\u0119bnione przez AI \u2014 zweryfikuj z oryginalnymi dokumentami rady.",
    social_scout_cue:
      "Dane z medi\u00f3w spo\u0142eczno\u015bciowych pobrane z platformy \u2014 mog\u0105 by\u0107 niekompletne.",
  },
};

/**
 * Resolve a localized string with English fallback.
 *
 *  - Unknown language falls back to English.
 *  - Unknown key within the language also falls back through English, then
 *    returns the key itself so missing strings are loud but non-fatal.
 *  - `{name}` placeholders are replaced with matching entries from `params`.
 */
export function getString(
  key: string,
  language: string | null | undefined,
  params?: Record<string, string | number>,
): string {
  const lang = language && EMAIL_STRINGS[language] ? language : "en";
  const template = EMAIL_STRINGS[lang][key] ?? EMAIL_STRINGS.en[key] ?? key;
  if (!params) return template;
  return template.replace(
    /\{(\w+)\}/g,
    (match, name: string) => name in params ? String(params[name]) : match,
  );
}
