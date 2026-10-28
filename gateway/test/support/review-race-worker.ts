import { TaskStore } from "../../src/task-store.js";
const store = new TaskStore(process.argv[2]!);
try {
  const result = store.reviews.accept(JSON.parse(process.argv[3]!));
  process.stdout.write(JSON.stringify({ ok: true, state: result.task.state, reviewId: result.reviewId }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: (error as { code?: string }).code ?? "ERROR" }));
} finally { store.close(); }
