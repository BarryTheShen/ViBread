export { evaluateRun, calibrationMacros } from "./evaluate.js";
export { planSelfTest } from "./plan.js";
export { promptFor } from "./prompts.js";
export { LineDecoder } from "./serial.js";
export { FAULT_IDS, FAULTS, applyFault, buildFaultDictionary, rankFaults } from "./faults.js";
export type { AppliedFault, FaultDefinition, FaultDictionary, FaultDictionaryEntry, FaultId } from "./faults.js";
