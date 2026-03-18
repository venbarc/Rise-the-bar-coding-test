import { config } from "../config.js";
import { PostgresTaskRepository } from "../repositories/PostgresTaskRepository.js";

async function run() {
  const repository = new PostgresTaskRepository(config.databaseUrl);

  try {
    await repository.ensureSchema();
    await repository.reset();
    console.log("System state reset.");
  } finally {
    await repository.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
