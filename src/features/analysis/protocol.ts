import type { AnalysisResult, ParcelPose, Placement } from '../../geometry/types';

export interface AnalysisRequest {
  readonly id: number;
  readonly parcel: ParcelPose | null;
  readonly placement: Placement;
  readonly requiredClearWidth: number;
}

export interface AnalysisResponse {
  readonly id: number;
  readonly result?: AnalysisResult;
  readonly error?: string;
}
