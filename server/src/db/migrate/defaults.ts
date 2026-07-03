import type Database from 'better-sqlite3';
import * as legacyBaseline from '../migrations/20260101_000000_legacy_baseline.js';
import * as customProviderModalities from '../migrations/20260627_000001_custom_provider_modalities.js';
import * as catalogModelState from '../migrations/20260627_000002_catalog_model_state.js';
import * as syncCustomModelsToProfiles from '../migrations/20260628_000001_sync_custom_models_to_profiles.js';
import * as customProviderName from '../migrations/20260628_000002_custom_provider_name.js';
import * as anthropicBaseUrl from '../migrations/20260703_000001_anthropic_base_url.js';

export interface MigrationModule {
  up(db: Database.Database): void;
  down(db: Database.Database): void;
}

export interface DefaultMigration {
  filename: string;
  module: MigrationModule;
}

export const LEGACY_BASELINE_FILENAME = '20260101_000000_legacy_baseline.ts';
export const CUSTOM_PROVIDER_MODALITIES_FILENAME = '20260627_000001_custom_provider_modalities.ts';
export const CATALOG_MODEL_STATE_FILENAME = '20260627_000002_catalog_model_state.ts';
export const SYNC_CUSTOM_MODELS_TO_PROFILES_FILENAME = '20260628_000001_sync_custom_models_to_profiles.ts';
export const CUSTOM_PROVIDER_NAME_FILENAME = '20260628_000002_custom_provider_name.ts';
export const ANTHROPIC_BASE_URL_FILENAME = '20260703_000001_anthropic_base_url.ts';

export const DEFAULT_MIGRATIONS: readonly DefaultMigration[] = [
  { filename: LEGACY_BASELINE_FILENAME, module: legacyBaseline },
  { filename: CUSTOM_PROVIDER_MODALITIES_FILENAME, module: customProviderModalities },
  { filename: CATALOG_MODEL_STATE_FILENAME, module: catalogModelState },
  { filename: SYNC_CUSTOM_MODELS_TO_PROFILES_FILENAME, module: syncCustomModelsToProfiles },
  { filename: CUSTOM_PROVIDER_NAME_FILENAME, module: customProviderName },
  { filename: ANTHROPIC_BASE_URL_FILENAME, module: anthropicBaseUrl },
];
