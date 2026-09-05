import { useEffect, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import {
  localStorageMigrationService,
  type LocalStorageMigrationResult
} from "../../services/localStorageMigrationService";

type MigrationInspection = {
  isDesktopRuntime: boolean;
  hasLocalStorageData: boolean;
  sqliteIsEmpty: boolean;
  sqliteRecordCount: number;
  localStorageRecordCount: number;
};

export function LocalStorageMigrationPanel() {
  const { t } = useI18n();
  const [inspection, setInspection] = useState<MigrationInspection | null>(null);
  const [result, setResult] = useState<LocalStorageMigrationResult | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  async function refreshInspection() {
    setInspection(await localStorageMigrationService.inspect());
  }

  useEffect(() => {
    refreshInspection();
  }, []);

  async function runMigration() {
    setIsRunning(true);
    try {
      const migrationResult = await localStorageMigrationService.migrateToSQLite();
      setResult(migrationResult);
      await refreshInspection();
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <section className="chart-panel">
      <h2>{t("migrationTitle")}</h2>
      <div className="meta-row">
        <span>{t("runtime")}: {inspection?.isDesktopRuntime ? t("tauriDesktop") : t("browser")}</span>
        <span>localStorage: {inspection?.localStorageRecordCount ?? 0}</span>
        <span>SQLite: {inspection?.sqliteRecordCount ?? 0}</span>
      </div>
      <p>{t("migrateDescription")}</p>
      <div className="button-row">
        <button
          type="button"
          disabled={
            isRunning ||
            !inspection?.isDesktopRuntime ||
            !inspection?.hasLocalStorageData ||
            !inspection?.sqliteIsEmpty
          }
          onClick={runMigration}
        >
          {isRunning ? t("migrating") : t("migrateToSQLite")}
        </button>
        <button type="button" className="secondary-button" onClick={refreshInspection}>
          {t("refresh")}
        </button>
      </div>
      {result ? (
        <div className="migration-result">
          <strong>{result.message}</strong>
          {result.entities.map((entity) => (
            <div key={entity.entityName}>
              {entity.entityName}: {entity.migrated}/{entity.total} migrated, {entity.failed} failed
              {entity.errors.length > 0 ? (
                <ul>
                  {entity.errors.map((error) => (
                    <li key={error}>{error}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
