// Typed protocol between the extension pages (popup, options) and the
// background. Each entry maps a request type to its payload and result.
import type { DeviceInfo, VersionInfo } from '../api/client';
import type { PendingConfirmation, SyncStatus } from '../storage/state';

export interface StatusView {
  signedIn: boolean;
  /** Signed out by the server (401) but local state kept: offer to sign in again. */
  needsReLogin: boolean;
  username: string | null;
  serverUrl: string | null;
  status: SyncStatus;
  paused: boolean;
  lastSyncAt: number | null;
  lastError: string | null;
  /** Server vault version this browser last synced with. */
  version: number | null;
  nextAttemptAt: number;
  pendingConfirmation: PendingConfirmation | null;
  nativeSyncAck: boolean;
}

export interface EmergencyKit {
  text: string;
  syncId: string;
  fileName: string;
}

export interface Protocol {
  getStatus: { req: object; res: StatusView };
  syncNow: { req: object; res: StatusView };
  pauseSync: { req: object; res: StatusView };
  resumeSync: { req: object; res: StatusView };
  confirmPendingSync: { req: object; res: StatusView };
  useLocalVersion: { req: object; res: StatusView };
  acceptServerVersion: { req: object; res: StatusView };
  rejoin: { req: object; res: StatusView };
  acknowledgeNativeSync: { req: object; res: StatusView };

  register: { req: { serverUrl: string; username: string; password: string; deviceName: string }; res: EmergencyKit };
  login: { req: { serverUrl: string; username: string; password: string; syncId: string; deviceName: string }; res: StatusView };
  logout: { req: object; res: StatusView };
  listDevices: { req: object; res: DeviceInfo[] };
  revokeDevice: { req: { deviceId: string }; res: DeviceInfo[] };
  changePassword: { req: { currentPassword: string; newPassword: string; rotateKeys: boolean }; res: { kit: EmergencyKit | null } };
  deleteAccount: { req: { password: string }; res: StatusView };
  getEmergencyKit: { req: object; res: EmergencyKit };

  listVersions: { req: object; res: VersionInfo[] };
  restoreVersion: { req: { version: number }; res: StatusView };
}

export type MessageType = keyof Protocol;
export type Request<K extends MessageType = MessageType> = K extends MessageType ? { type: K } & Protocol[K]['req'] : never;
export type Response<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
