export interface PageScoutAlertFixture {
  id: string;
  language: string;
  criteria: string;
  before: string;
  after: string;
  expectedAlert: boolean;
  failureClass: string;
}

/**
 * Synthetic acceptance cases for the semantic Page Scout alert gate. They do
 * not contain customer page content or criteria and are safe to send to the
 * configured model provider.
 */
export const PAGE_SCOUT_ALERT_FIXTURES: PageScoutAlertFixture[] = [
  {
    id: "en-ignore-player-help",
    language: "en",
    criteria:
      "Alert only for substantive changes to the advertising policy. Ignore navigation, styling, help text, and boilerplate.",
    before:
      "Policy: Misleading advertisements are prohibited.\nPlayer help: Open Settings at the bottom of the player and choose Subtitles.",
    after:
      "Policy: Misleading advertisements are prohibited.\nPlayer help: Open Settings at the top right of the player and choose Captions.",
    expectedAlert: false,
    failureClass: "unrelated-ui-copy",
  },
  {
    id: "de-ignore-historical-date",
    language: "de",
    criteria:
      "Melde Änderungen an den derzeit geltenden Werberichtlinien oder ihrem aktuellen Gültigkeitsdatum. Ignoriere Datumsänderungen in der historischen Versionsliste.",
    before:
      "Aktuelle Richtlinie: Irreführende Werbung ist verboten.\nVersionsverlauf: 15. März 2020 – redaktionelle Korrektur.",
    after:
      "Aktuelle Richtlinie: Irreführende Werbung ist verboten.\nVersionsverlauf: 16. März 2020 – redaktionelle Korrektur.",
    expectedAlert: false,
    failureClass: "historical-date-churn",
  },
  {
    id: "fr-ignore-list-marker",
    language: "fr",
    criteria:
      "Alerte uniquement en cas de modification substantielle des règles publicitaires, pas pour la mise en forme.",
    before: "Règles en vigueur\n* Les annonces trompeuses sont interdites.",
    after: "Règles en vigueur\n- Les annonces trompeuses sont interdites.",
    expectedAlert: false,
    failureClass: "format-only-list-marker",
  },
  {
    id: "es-ignore-traffic-count",
    language: "es",
    criteria:
      "Avisa solo si cambian los requisitos de elegibilidad para solicitar la ayuda. Ignora métricas de visitas y otros contadores.",
    before:
      "Requisitos: pueden solicitarla las organizaciones sin ánimo de lucro.\nVisitas a esta página: 18.204.",
    after:
      "Requisitos: pueden solicitarla las organizaciones sin ánimo de lucro.\nVisitas a esta página: 18.391.",
    expectedAlert: false,
    failureClass: "unrelated-number-churn",
  },
  {
    id: "ar-ignore-navigation-label",
    language: "ar",
    criteria:
      "أرسل تنبيهاً فقط عند تغيير شروط الأهلية للمنحة، وتجاهل تغييرات التنقل والتنسيق.",
    before:
      "شروط الأهلية: المؤسسات غير الربحية مؤهلة.\nرابط التنقل: الأسئلة الشائعة",
    after:
      "شروط الأهلية: المؤسسات غير الربحية مؤهلة.\nرابط التنقل: المساعدة والأسئلة الشائعة",
    expectedAlert: false,
    failureClass: "unrelated-navigation-copy",
  },
  {
    id: "ja-ignore-copyright-year",
    language: "ja",
    criteria:
      "申請の締切または応募資格が変更された場合だけ通知してください。著作権表記は無視してください。",
    before: "応募資格：国内の非営利団体。\n© 2025 Example Foundation",
    after: "応募資格：国内の非営利団体。\n© 2026 Example Foundation",
    expectedAlert: false,
    failureClass: "boilerplate-number-churn",
  },
  {
    id: "en-match-current-effective-date",
    language: "en",
    criteria:
      "Alert if the current advertising terms change their effective date or last-updated date.",
    before:
      "Advertising Terms\nEffective date: 1 September 2026.\nMisleading advertisements are prohibited.",
    after:
      "Advertising Terms\nEffective date: 15 September 2026.\nMisleading advertisements are prohibited.",
    expectedAlert: true,
    failureClass: "requested-current-date-change",
  },
  {
    id: "de-match-policy-rule",
    language: "de",
    criteria:
      "Melde jede inhaltliche Änderung der Regeln für politische Werbung.",
    before: "Politische Werbung ist mit einer Kennzeichnung zulässig.",
    after: "Politische Werbung ist auf dieser Plattform nicht mehr zulässig.",
    expectedAlert: true,
    failureClass: "requested-policy-change",
  },
  {
    id: "fr-match-fee-threshold",
    language: "fr",
    criteria: "Alerte si le montant des frais de dossier change.",
    before: "Les frais de dossier sont de 25 euros.",
    after: "Les frais de dossier sont de 40 euros.",
    expectedAlert: true,
    failureClass: "requested-numeric-change",
  },
  {
    id: "es-match-eligibility",
    language: "es",
    criteria:
      "Avisa si cambian los requisitos de elegibilidad para solicitar la ayuda.",
    before: "Pueden solicitarla todas las organizaciones sin ánimo de lucro.",
    after:
      "Solo pueden solicitarla las organizaciones sin ánimo de lucro con al menos tres años de actividad.",
    expectedAlert: true,
    failureClass: "requested-eligibility-change",
  },
  {
    id: "ar-match-deadline",
    language: "ar",
    criteria: "أرسل تنبيهاً عند تغيير الموعد النهائي لتقديم الطلبات.",
    before: "الموعد النهائي لتقديم الطلبات هو 1 أكتوبر 2026.",
    after: "الموعد النهائي لتقديم الطلبات هو 15 أكتوبر 2026.",
    expectedAlert: true,
    failureClass: "requested-deadline-change",
  },
  {
    id: "ja-match-registration-closed",
    language: "ja",
    criteria: "募集が締め切られた場合に通知してください。",
    before: "現在、応募を受け付けています。",
    after: "応募受付は終了しました。",
    expectedAlert: true,
    failureClass: "requested-status-change",
  },
];
