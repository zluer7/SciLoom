import type { Milestone } from "../types/milestone";
import { milestoneRepositoryConfig } from "../repositories/entityConfig";
import { createRepository } from "../repositories/repositoryFactory";
import type { Repository } from "../repositories/types";

export type MilestoneService = Repository<Milestone> & {
  listMilestones: () => Promise<Milestone[]>;
};

const repository = createRepository<Milestone>(milestoneRepositoryConfig);

export const milestoneService: MilestoneService = {
  ...repository,
  listMilestones: repository.list
};
