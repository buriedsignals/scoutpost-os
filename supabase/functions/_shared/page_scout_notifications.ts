export interface PageScoutNotificationResult {
  /** Decided from the normalized page delta (and criteria result when set)
   * before optional extraction or unit deduplication. */
  alert_eligible: boolean;
  articles_count: number;
  criteria_ran: boolean;
  summary?: string | null;
}

export function shouldSendPageScoutAlert(
  result: PageScoutNotificationResult,
): boolean {
  return result.alert_eligible;
}
