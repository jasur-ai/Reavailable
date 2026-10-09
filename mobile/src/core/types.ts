/**
 * Domain types shared by the sync engine, playback and the UI.
 *
 * The core layer is plain TypeScript with no React Native imports, so the business rules
 * (sync, playback, voice commands) can be unit-tested under Node.
 */

export type ChunkState = 'pending' | 'downloading' | 'stored' | 'failed';

export interface ChunkRecord {
  index: number;
  state: ChunkState;
  /** SHA-256 (hex) announced by the server. Downloaded bytes must match it. */
  sha256: string;
  sizeBytes: number;
  contentType: string;
  /** Path relative to the audio store root. Present once the chunk is stored on this device. */
  file?: string;
  /** True after the server confirmed deletion. Only stored chunks are ever acknowledged. */
  acked: boolean;
  attempts: number;
  lastError?: string;
  /**
   * How many times the server rejected this part's checksum at acknowledgement. After
   * MAX_ACK_REJECTIONS the book fails instead of downloading the part again. Reset by a manual retry.
   */
  ackRejections?: number;
}

export type BookStatus = 'processing' | 'downloading' | 'ready' | 'failed';

/** Where a failed book stopped: server-side synthesis, or the device download. */
export type FailureStage = 'synthesis' | 'download';

export interface BookRecord {
  /** Equals the server job identifier. */
  id: string;
  /** Base URL of the server that owns the job. */
  apiBaseUrl: string;
  title: string;
  voice: string;
  status: BookStatus;
  failedStage?: FailureStage;
  errorCode?: string;
  errorMessage?: string;
  /** Short sync note shown to the user, for example "Waiting for a connection". */
  syncNote?: string;
  warnings: string[];
  totalChunks: number;
  chunks: ChunkRecord[];
  /** Chunk index the listener last reached. Used to resume playback. */
  position: number;
  /** True once every chunk was acknowledged and the server copy has been removed. */
  serverReleased: boolean;
  /** True when the server reported the job as gone before this device had every chunk. */
  serverGone: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AppSettings {
  apiBaseUrl: string | null;
}

export interface LibraryData {
  version: 1;
  settings: AppSettings;
  books: BookRecord[];
}
