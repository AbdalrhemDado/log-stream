export type ReadinessState = "starting" | "ready" | "degraded" | "stopping";

export interface Readiness {
  readonly state: ReadinessState;
  readonly isReady: boolean;
  markReady(): void;
  markUnavailable(): void;
  beginShutdown(): void;
}

export function createReadiness(): Readiness {
  let state: ReadinessState = "starting";

  return {
    get state(): ReadinessState {
      return state;
    },
    get isReady(): boolean {
      return state === "ready";
    },
    markReady(): void {
      if (state !== "stopping") {
        state = "ready";
      }
    },
    markUnavailable(): void {
      if (state === "ready" || state === "degraded") {
        state = "degraded";
      }
    },
    beginShutdown(): void {
      state = "stopping";
    },
  };
}
