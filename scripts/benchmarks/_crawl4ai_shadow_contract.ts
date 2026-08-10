export interface ShadowContractValue {
  title: string | null;
  rawHtml: string | null;
  metadata: Record<string, unknown>;
  requested_url: string;
  source_url: string;
  status_code: number | null;
}

export interface ShadowContractComparison {
  requested_url_equal: boolean;
  source_url_equal: boolean;
  status_code_equal: boolean;
  title_retained: boolean;
  raw_html_retained: boolean;
  missing_metadata_keys: string[];
  passed: boolean;
}

export function compareShadowContract(
  control: ShadowContractValue,
  candidate: ShadowContractValue,
): ShadowContractComparison {
  const requestedUrlEqual = control.requested_url === candidate.requested_url;
  const sourceUrlEqual = control.source_url === candidate.source_url;
  const statusCodeEqual = control.status_code === candidate.status_code;
  const titleRetained = control.title === null ||
    control.title === candidate.title;
  const rawHtmlRetained = !control.rawHtml || Boolean(candidate.rawHtml);
  const missingMetadataKeys = Object.keys(control.metadata)
    .filter((key) => !(key in candidate.metadata))
    .sort();
  return {
    requested_url_equal: requestedUrlEqual,
    source_url_equal: sourceUrlEqual,
    status_code_equal: statusCodeEqual,
    title_retained: titleRetained,
    raw_html_retained: rawHtmlRetained,
    missing_metadata_keys: missingMetadataKeys,
    passed: requestedUrlEqual && sourceUrlEqual && statusCodeEqual &&
      titleRetained && rawHtmlRetained && missingMetadataKeys.length === 0,
  };
}
