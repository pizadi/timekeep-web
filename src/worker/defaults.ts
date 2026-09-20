// Fresh accounts are usable with zero settings changes (FR-C2).
import { POMODORO_DEFAULTS, SESSION_RULES } from '../shared/constants';

export const DEFAULT_SETTINGS = {
  pomodoro: {
    enabled: false,                        // opt-in: plain timer vs pomodoro mode (FR-F0)
    focus_min: POMODORO_DEFAULTS.focusMin,
    break_min: POMODORO_DEFAULTS.breakMin,
    auto_start: POMODORO_DEFAULTS.autoStart
  },
  grace_min: SESSION_RULES.graceMin,      // recovery "Discard" suggestion (FR-S3)
  notifications_enabled: false,           // permission is never requested unprompted (FR-Nt1)
  sound_enabled: false,
  theme: 'system' as 'system' | 'light' | 'dark'
};

export type AppSettings = typeof DEFAULT_SETTINGS;
