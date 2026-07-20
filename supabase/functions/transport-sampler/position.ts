import type { VesselClass } from "../_shared/vessel_classify.ts";

/** Provider-neutral latest known state for one watched vessel. */
export interface VesselPosition {
  mmsi: string;
  lat: number;
  lon: number;
  course: number | null;
  speedKnots: number | null;
  heading: number | null;
  navStatus: number | null;
  shipType: number | null;
  classification: VesselClass;
  military: boolean;
  name: string | null;
  flag: string | null;
  seenAt: string;
}
