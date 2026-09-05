export type DatabaseStatus = {
  isConfigured: boolean;
  schemaVersion: number;
  driver: "sqlite";
  fallbackDriver: "localStorage";
};

export const databaseStatus: DatabaseStatus = {
  isConfigured: true,
  schemaVersion: 1,
  driver: "sqlite",
  fallbackDriver: "localStorage"
};
