export const CYCLING = new Set(["ride", "mtb", "gravel", "virtual_ride", "ebike"]);

export function isCycling(sport) {
  if (!sport) return true;
  return CYCLING.has(sport);
}

const STRAVA_MAP = {
  Ride: "ride",
  MountainBikeRide: "mtb",
  GravelRide: "gravel",
  VirtualRide: "virtual_ride",
  EBikeRide: "ebike",
  EMountainBikeRide: "ebike",
  Run: "run",
  TrailRun: "trail_run",
  VirtualRun: "run",
  Walk: "walk",
  Hike: "hike",
  Swim: "swim",
  WeightTraining: "strength",
  Workout: "strength",
};

export function sportFromStrava(sportType) {
  return STRAVA_MAP[sportType] ?? "other";
}
