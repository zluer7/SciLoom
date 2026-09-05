import {
  literatureLinkRepositoryConfig,
  literatureRepositoryConfig
} from "./entityConfig";
import { createRepository } from "./repositoryFactory";
import type {
  Literature,
  LiteratureLink
} from "../types";

export const literatureRepository = createRepository<Literature>(literatureRepositoryConfig);

export const literatureLinkRepository = createRepository<LiteratureLink>(
  literatureLinkRepositoryConfig
);
