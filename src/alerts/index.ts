export { buildRegistry, type AdapterRegistry } from "./registry.ts";
export { safeNotify, type AlertOutcome, type AlertOutcomeStatus } from "./safe.ts";
export { createSlackAdapter, buildSlackBlocks } from "./slack.ts";
export { createShellAdapter, payloadEnv } from "./shell.ts";
export {
  alertStatusFor,
  buildUiUrl,
  chooseAdapterName,
  dispatchAlert,
  loadConsumerAlertsConfig,
  readLogTail,
  type ConsumerAlertsConfig,
  type DispatchInput,
  type DispatchOutcome,
} from "./dispatch.ts";
export type {
  Adapter,
  AlertPayload,
  AlertStatus,
  AlertsConfig,
} from "./types.ts";
