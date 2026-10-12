/** Unit conversion and display formatting. All internal values are metric. */

export type Units = "imperial" | "metric";

export const M_PER_FT = 0.3048;
export const M_PER_MI = 1609.344;

export const feetToMetres = (feet: number): number => feet * M_PER_FT;
export const metresToFeet = (metres: number): number => metres / M_PER_FT;

const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** "7.4 mi" or "11.9 km". */
export function formatDistance(metres: number, units: Units): string {
  return units === "imperial"
    ? `${oneDecimal.format(metres / M_PER_MI)} mi`
    : `${oneDecimal.format(metres / 1000)} km`;
}

/** "1,850 ft" or "564 m". Used for elevations, climbs and descents. */
export function formatHeight(metres: number, units: Units): string {
  return units === "imperial"
    ? `${whole.format(metresToFeet(metres))} ft`
    : `${whole.format(metres)} m`;
}

/** "2 h 05 min" or "45 min". */
export function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return hours === 0 ? `${rest} min` : `${hours} h ${String(rest).padStart(2, "0")} min`;
}

/** "18%". */
export function formatGrade(percent: number): string {
  return `${whole.format(Math.abs(percent))}%`;
}
