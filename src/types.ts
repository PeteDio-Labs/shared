// Core Pete-Vision types shared across backend, web, and desktop

// ── Raw UDP frames from firmware ──────────────────────────────────────────

/**
 * Raw CSI frame from a single ESP32-S3 node (packet type 0xC5110001)
 * Parsed from binary UDP payload by the backend frame-parser.
 */
export interface CsiFrame {
  /** Unique node identifier (0, 1, or 2) */
  node_id: number;
  /** TDM slot this node occupies (0, 1, or 2) */
  tdm_slot: number;
  /** Monotonic frame counter from the node */
  seq: number;
  /** Unix timestamp (ms) when the backend received this frame */
  received_at: number;
  /** RSSI in dBm */
  rssi: number;
  /** Number of subcarriers */
  num_subcarriers: number;
  /** CSI amplitude values per subcarrier */
  amplitude: Float32Array;
  /** CSI phase values per subcarrier */
  phase: Float32Array;
}

/**
 * Edge vitals packet from firmware (packet type 0xC5110002)
 * 32-byte pre-processed vitals computed on-chip.
 */
export interface EdgeVitals {
  node_id: number;
  received_at: number;
  /** Breaths per minute (0 = not detected) */
  breathing_rate: number;
  /** Beats per minute (0 = not detected) */
  heart_rate: number;
}

// ── Aggregated / fused data ───────────────────────────────────────────────

/** State of a single ESP32-S3 node as tracked by the backend */
export interface NodeState {
  node_id: number;
  tdm_slot: number;
  /** Whether the node has sent frames in the last 5 seconds */
  online: boolean;
  last_seen: number;
  frames_received: number;
  /** Most recent RSSI */
  rssi: number;
}

/**
 * Multi-node fused frame — one per TDM cycle (~20 Hz).
 * Combines amplitude/phase from all active nodes via attention-weighted fusion.
 */
export interface FusedFrame {
  /** Unix timestamp (ms) of the TDM cycle */
  timestamp: number;
  /** Which nodes contributed to this cycle */
  contributing_nodes: number[];
  /** Fused amplitude values (same length as individual node subcarriers) */
  amplitude: Float32Array;
  /** Fused phase values */
  phase: Float32Array;
  /** Per-node attention weights used for fusion (sum to 1.0) */
  attention_weights: number[];
}

// ── Signal processing outputs ─────────────────────────────────────────────

export interface PresenceResult {
  /** Whether a person is detected */
  present: boolean;
  /** Confidence 0.0–1.0 */
  confidence: number;
  /** Adaptive detection threshold (amplitude units) */
  threshold: number;
  /** Current amplitude variance */
  variance: number;
}

export interface MotionResult {
  /** Weighted motion score 0.0–1.0 */
  score: number;
  /** Variance contribution */
  variance_component: number;
  /** Phase correlation contribution */
  phase_component: number;
  /** Correlation contribution */
  correlation_component: number;
}

export interface VitalSigns {
  /** Breaths per minute (null = not detected) */
  breathing_rate: number | null;
  /** Beats per minute (null = not detected) */
  heart_rate: number | null;
  /** Dominant breathing frequency (Hz) */
  breathing_freq_hz: number | null;
  /** Dominant heart rate frequency (Hz) */
  heart_freq_hz: number | null;
}

/** Full sensing result for one processing cycle */
export interface SensingResult {
  timestamp: number;
  presence: PresenceResult;
  motion: MotionResult;
  vitals: VitalSigns;
  /** Raw fused frame this result was derived from */
  fused_frame?: FusedFrame;
}

// ── Ollama / activity ─────────────────────────────────────────────────────

export interface ActivityEvent {
  id: string;
  timestamp: number;
  /** Natural language description from Ollama */
  narration: string;
  /** Sensing state that triggered this event */
  context: {
    present: boolean;
    motion_score: number;
    breathing_rate: number | null;
    heart_rate: number | null;
  };
}

// ── Serializable versions (no TypedArrays) for JSON/WebSocket ────────────

/** JSON-safe version of FusedFrame (amplitude/phase as plain number[]) */
export interface FusedFrameJSON {
  timestamp: number;
  contributing_nodes: number[];
  amplitude: number[];
  phase: number[];
  attention_weights: number[];
}

/** JSON-safe version of CsiFrame */
export interface CsiFrameJSON {
  node_id: number;
  tdm_slot: number;
  seq: number;
  received_at: number;
  rssi: number;
  num_subcarriers: number;
  amplitude: number[];
  phase: number[];
}

/** Full sensing snapshot — what the REST API returns */
export interface SensingSnapshot {
  timestamp: number;
  presence: PresenceResult;
  motion: MotionResult;
  vitals: VitalSigns;
  nodes: NodeState[];
}
