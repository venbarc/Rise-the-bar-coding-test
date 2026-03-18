# LLM-Powered Chat Task Tracker

A small TypeScript/Node task tracker that turns chat messages into structured task operations, stores them in Postgres or Supabase Postgres, and exposes a simple web UI for viewing tasks and task details.

## Stack

- Backend: Node.js + TypeScript + Express
- Storage: PostgreSQL via `postgres` package
- Hosted DB option: Supabase Postgres
- LLM integration: OpenAI-compatible chat completion API with tool calling
- UI: static HTML/CSS/JS served by the backend

## Architecture

### Components

- `src/server.ts`
  Creates the Postgres repository, chooses the interpreter, ensures schema, and starts the HTTP server.
- `src/http/createApp.ts`
  Express routes for chat, tasks, reset, chat history, and static asset serving.
- `src/services/TaskService.ts`
  Orchestrates message processing, conversation history, idempotency checks, LLM interpretation, and deterministic summaries.
- `src/llm/OpenAICompatibleTaskInterpreter.ts`
  Primary LLM path. Uses tool calling to return a structured plan of task operations.
- `src/llm/HeuristicFallbackInterpreter.ts`
  Fallback-only local mode when an API key is unavailable.
- `src/repositories/PostgresTaskRepository.ts`
  Postgres persistence for tasks, details, conversation messages, and processed messages.
- `src/repositories/InMemoryTaskRepository.ts`
  Test/demo repository so automated checks do not need a live database.
- `public/*`
  Minimal chat UI plus a read-only task list and task detail view.

### Data model

- `tasks`
  Stores title, normalized title, status, and completion timestamp.
- `task_details`
  Stores free-text notes per task.
- `conversation_messages`
  Stores recent user/assistant turns so the LLM can use context.
- `processed_messages`
  Stores message idempotency keys and cached assistant responses.

## How the LLM is used

The primary behavior is LLM-powered.

- The backend sends the current task list, recent conversation, and latest user message to the model.
- The model must call a single tool, `submit_task_plan`, with one of:
  - `create_task`
  - `complete_task`
  - `append_detail`
  - `clarify`
  - `noop`
- The service executes the returned plan in the database and generates the final user-facing summary from actual write results.

This keeps interpretation model-driven while keeping state changes deterministic and auditable.

## Idempotency approach

There are multiple layers:

1. Inbound message dedupe
- Each inbound user message is normalized and hashed into an idempotency key.
- `processed_messages` has a unique constraint on `(chat_id, idempotency_key)`.
- If the same normalized message arrives again, the backend returns the cached assistant response and does not reapply writes.

2. Task dedupe
- `tasks` has a unique constraint on `(chat_id, normalized_title)`.
- Repeated create intents for the same task title do not create duplicates.

3. Detail dedupe
- `task_details` has a unique constraint on `(task_id, normalized_text)`.
- Replayed notes or details are ignored.

4. Completion idempotency
- Completing an already-completed task is a no-op.

This is enough for the test's same/similar retry requirement. The main tradeoff is that two intentionally repeated messages with the same normalized content in the same chat thread are treated as retries rather than new work.

## Conversational context

- Recent messages are stored in `conversation_messages`.
- The service only sends the latest few turns to the LLM, so prompt growth is bounded.
- The full current task list is included because the task set is intentionally small.
- The web client reloads recent chat history after page refresh so the visible transcript matches stored backend state.

## Reset support

Both are supported:

- CLI: `npm run reset`
- HTTP: `POST /api/admin/reset`

## Setup

### 1. Install

```bash
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in values.

```env
PORT=3000
DATABASE_URL=postgresql://...
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_API_KEY=...
LLM_MODEL=openai/gpt-4.1-mini
LLM_MODE=openai-compatible
LLM_MAX_TOKENS=512
OPENROUTER_SITE_URL=http://localhost:3000
OPENROUTER_SITE_NAME=Rise the Bar Task Tracker
```

### 3. Supabase setup

Supabase is PostgreSQL, so it satisfies the storage requirement.

- Create a Supabase project.
- Go to project settings -> database.
- Copy a Postgres connection string into `DATABASE_URL`.
- Use the pooler or direct connection string supplied by Supabase.
- No separate migration step is required; the app creates tables on startup.

### 4. Start the app

Preferred portable flow:

```bash
npm run build
npm start
```

Then open `http://localhost:3000`.

### Optional local smoke mode without an API key

If you only want to smoke-test the UI and backend wiring locally, set:

```env
LLM_MODE=heuristic
```

That fallback exists for local verification only. The intended primary runtime path is the OpenAI-compatible tool-calling interpreter.

## Demo path

### Browser demo

1. Create multiple tasks from one message

```text
Create tasks to draft the spec, email the team, and book the demo
```

2. Complete a task from natural language

```text
Mark the spec task as done
```

3. Attach a detail to a task

```text
Add detail to the demo task: waiting on final customer availability
```

### Idempotency demo

```bash
npm run demo:idempotency
```

This runs a deterministic script that proves:

- duplicate create messages do not create extra tasks
- completion works
- details attach correctly

## Automated verification

```bash
npm test
```

This runs compiled tests against the in-memory repository and covers:

- multi-task creation from one message
- duplicate-message idempotency
- completion flow
- clarify flow for ambiguous intent
- detail attachment dedupe

## API surface

- `POST /api/chat`
- `GET /api/chat/history`
- `GET /api/tasks`
- `GET /api/tasks/:taskId`
- `POST /api/tasks/:taskId/complete`
- `POST /api/admin/reset`
- `GET /api/health`

## Key tradeoffs and next improvements

- The current idempotency strategy intentionally favors retry safety over allowing identical repeated commands in the same chat thread.
- The fallback interpreter is intentionally lightweight; production use should stay on the tool-calling LLM path.
- Schema creation happens at startup for simplicity. In a larger system I would add real migrations.
- The UI is intentionally simple. Next steps would be richer task filters, friendlier unsupported-edit handling, and deeper ambiguity tests against the live LLM path.
- For stronger duplicate detection, the next step would be storing a canonicalized action fingerprint in addition to message fingerprinting.
