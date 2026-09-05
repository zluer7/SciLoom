import type { ResearchTask } from "../types/task";
import { taskRepositoryConfig } from "../repositories/entityConfig";
import { createRepository } from "../repositories/repositoryFactory";
import type { Repository } from "../repositories/types";

export type TaskService = Repository<ResearchTask> & {
  listTasks: () => Promise<ResearchTask[]>;
};

const repository = createRepository<ResearchTask>(taskRepositoryConfig);

export const taskService: TaskService = {
  ...repository,
  listTasks: repository.list
};
