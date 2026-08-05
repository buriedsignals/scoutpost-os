export interface PageScoutNotificationResult {
  /** Decided from the normalized page delta (and criteria result when set)
   * before optional extraction or unit deduplication. */
  alert_eligible: boolean;
  articles_count: number;
  criteria_ran: boolean;
  summary?: string | null;
}

export type PageScoutNotificationMode = "deliver" | "disabled";

export interface PageScoutNotificationPlan {
  alertEligible: boolean;
  shouldSend: boolean;
  notificationStatus: "pending" | "skipped";
  suppressionReason: "test_delivery_disabled" | null;
}

export function shouldSendPageScoutAlert(
  result: PageScoutNotificationResult,
): boolean {
  return result.alert_eligible;
}

/**
 * Keep the semantic alert result observable while allowing an internal test
 * run to exercise the production pipeline without invoking mail delivery.
 */
export function planPageScoutNotification(
  result: PageScoutNotificationResult,
  mode: PageScoutNotificationMode = "deliver",
): PageScoutNotificationPlan {
  const alertEligible = shouldSendPageScoutAlert(result);
  const deliveryDisabled = mode === "disabled";
  const shouldSend = alertEligible && !deliveryDisabled;
  return {
    alertEligible,
    shouldSend,
    notificationStatus: shouldSend ? "pending" : "skipped",
    suppressionReason: alertEligible && deliveryDisabled
      ? "test_delivery_disabled"
      : null,
  };
}
