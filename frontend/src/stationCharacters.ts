import stationNames from "./stationRotor.json";

// One shared, fixed drum of unique NFC syllables for every departure/arrival cell.
// Space is a real leaf so shorter names also finish through the normal sequence.
export const STATION_CHARACTER_ROTOR: readonly string[] = Object.freeze([
  " ", ...Array.from(new Set(stationNames.flatMap(name => Array.from(name.normalize("NFC"))))).sort(),
]);
