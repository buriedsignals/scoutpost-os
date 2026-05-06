export interface PageScoutNotificationResult {
  articles_count: number;
  criteria_ran: boolean;
  summary?: string | null;
}

export function shouldSendPageScoutAlert(
  result: PageScoutNotificationResult,
): boolean {
  return result.articles_count > 0 && Boolean(result.summary?.trim());
}
