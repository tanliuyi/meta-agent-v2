/** User-visible configuration, delivered by Desktop via `pi.getConfig()`. */
export interface OfficeCliConfig {
  /** Absolute path to an existing officecli binary. When set, no download happens. */
  binaryPath?: string;
  /** Release tag to download, e.g. "v1.0.143". Default: latest verified version. */
  version?: string;
  /** Download the platform binary on first use when it is missing. Default: true. */
  autoDownload?: boolean;
  /** Override the auto-download directory. For tests and advanced setups only. */
  dataDir?: string;
}

/** Fully resolved configuration with defaults applied. */
export interface ResolvedOfficeCliConfig {
  binaryPath: string;
  version: string;
  autoDownload: boolean;
  /** Directory that holds the auto-downloaded binary. */
  dataDir: string;
}

/** A single batch operation in officecli's batch-item shape. */
export interface BatchItem {
  command?: string;
  op?: string;
  path?: string;
  parent?: string;
  type?: string;
  index?: number | string;
  after?: string;
  before?: string;
  to?: string;
  selector?: string;
  props?: Record<string, unknown>;
  [key: string]: unknown;
}
