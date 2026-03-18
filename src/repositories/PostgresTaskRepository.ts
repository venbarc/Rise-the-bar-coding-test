// @ts-nocheck
import postgres from "postgres";
import { normalizeDetail, normalizeMessageText, normalizeTitle } from "../utils/normalize.js";
import type {
  AddDetailResult,
  ChatRole,
  CompleteTaskResult,
  ConversationMessage,
  CreateTaskResult,
  ProcessedMessage,
  Task,
  TaskDetail
} from "../types.js";
import type { TaskRepository, TaskRepositoryTransaction } from "./TaskRepository.js";

interface TaskRow {
  id: string;
  chat_id: string;
  title: string;
  normalized_title: string;
  status: "open" | "completed";
  created_at: string;
  completed_at: string | null;
}

interface TaskDetailRow {
  id: string;
  task_id: string;
  text: string;
  normalized_text: string;
  created_at: string;
}

interface ConversationRow {
  id: string;
  chat_id: string;
  role: ChatRole;
  content: string;
  created_at: string;
}

interface ProcessedMessageRow {
  id: string;
  chat_id: string;
  idempotency_key: string;
  original_text: string;
  normalized_text: string;
  assistant_response: string;
  created_at: string;
}

type SqlClient = postgres.Sql<{}> | postgres.TransactionSql<{}>;

function mapTaskDetail(row: TaskDetailRow): TaskDetail {
  return {
    id: row.id,
    taskId: row.task_id,
    text: row.text,
    normalizedText: row.normalized_text,
    createdAt: row.created_at
  };
}

function mapConversation(row: ConversationRow): ConversationMessage {
  return {
    id: row.id,
    chatId: row.chat_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at
  };
}

function mapProcessedMessage(row: ProcessedMessageRow): ProcessedMessage {
  return {
    id: row.id,
    chatId: row.chat_id,
    idempotencyKey: row.idempotency_key,
    originalText: row.original_text,
    normalizedText: row.normalized_text,
    assistantResponse: row.assistant_response,
    createdAt: row.created_at
  };
}

async function loadTasks(sql: SqlClient, chatId: string): Promise<Task[]> {
  const taskRows = await sql<TaskRow[]>`
    select id, chat_id, title, normalized_title, status, created_at, completed_at
    from tasks
    where chat_id = ${chatId}
    order by case when status = 'open' then 0 else 1 end, created_at desc
  `;

  if (taskRows.length === 0) {
    return [];
  }

  const taskIds = taskRows.map((row) => row.id);
  const detailRows = await sql<TaskDetailRow[]>`
    select id, task_id, text, normalized_text, created_at
    from task_details
    where task_id in ${sql(taskIds)}
    order by created_at asc
  `;

  const detailsByTaskId = new Map<string, TaskDetail[]>();

  for (const row of detailRows) {
    const current = detailsByTaskId.get(row.task_id) ?? [];
    current.push(mapTaskDetail(row));
    detailsByTaskId.set(row.task_id, current);
  }

  return taskRows.map((row) => ({
    id: row.id,
    chatId: row.chat_id,
    title: row.title,
    normalizedTitle: row.normalized_title,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    details: detailsByTaskId.get(row.id) ?? []
  }));
}

class PostgresTaskRepositoryTransaction implements TaskRepositoryTransaction {
  constructor(private readonly sql: SqlClient) {}

  async listTasks(chatId: string): Promise<Task[]> {
    return loadTasks(this.sql, chatId);
  }

  async getTask(chatId: string, taskId: string): Promise<Task | null> {
    const tasks = await this.sql<TaskRow[]>`
      select id, chat_id, title, normalized_title, status, created_at, completed_at
      from tasks
      where chat_id = ${chatId} and id = ${taskId}
      limit 1
    `;

    if (tasks.length === 0) {
      return null;
    }

    const details = await this.sql<TaskDetailRow[]>`
      select id, task_id, text, normalized_text, created_at
      from task_details
      where task_id = ${taskId}
      order by created_at asc
    `;

    const row = tasks[0];

    return {
      id: row.id,
      chatId: row.chat_id,
      title: row.title,
      normalizedTitle: row.normalized_title,
      status: row.status,
      createdAt: row.created_at,
      completedAt: row.completed_at,
      details: details.map(mapTaskDetail)
    };
  }

  async upsertTask(chatId: string, title: string): Promise<CreateTaskResult> {
    const normalized = normalizeTitle(title);
    const inserted = await this.sql<TaskRow[]>`
      insert into tasks (chat_id, title, normalized_title)
      values (${chatId}, ${title.trim()}, ${normalized})
      on conflict (chat_id, normalized_title) do nothing
      returning id, chat_id, title, normalized_title, status, created_at, completed_at
    `;

    if (inserted.length > 0) {
      const task = inserted[0];

      return {
        created: true,
        task: {
          id: task.id,
          chatId: task.chat_id,
          title: task.title,
          normalizedTitle: task.normalized_title,
          status: task.status,
          createdAt: task.created_at,
          completedAt: task.completed_at,
          details: []
        }
      };
    }

    const existingRows = await this.sql<TaskRow[]>`
      select id, chat_id, title, normalized_title, status, created_at, completed_at
      from tasks
      where chat_id = ${chatId} and normalized_title = ${normalized}
      limit 1
    `;

    if (existingRows.length === 0) {
      throw new Error(`Task lookup failed after upsert for "${title}".`);
    }

    const existing = existingRows[0];
    const details = await this.sql<TaskDetailRow[]>`
      select id, task_id, text, normalized_text, created_at
      from task_details
      where task_id = ${existing.id}
      order by created_at asc
    `;

    return {
      created: false,
      task: {
        id: existing.id,
        chatId: existing.chat_id,
        title: existing.title,
        normalizedTitle: existing.normalized_title,
        status: existing.status,
        createdAt: existing.created_at,
        completedAt: existing.completed_at,
        details: details.map(mapTaskDetail)
      }
    };
  }

  async addDetail(taskId: string, text: string): Promise<AddDetailResult> {
    const normalized = normalizeDetail(text);
    const inserted = await this.sql<TaskDetailRow[]>`
      insert into task_details (task_id, text, normalized_text)
      values (${taskId}, ${text.trim()}, ${normalized})
      on conflict (task_id, normalized_text) do nothing
      returning id, task_id, text, normalized_text, created_at
    `;

    if (inserted.length > 0) {
      return {
        detail: mapTaskDetail(inserted[0]),
        created: true
      };
    }

    const existing = await this.sql<TaskDetailRow[]>`
      select id, task_id, text, normalized_text, created_at
      from task_details
      where task_id = ${taskId} and normalized_text = ${normalized}
      limit 1
    `;

    if (existing.length === 0) {
      throw new Error(`Detail lookup failed after upsert for task ${taskId}.`);
    }

    return {
      detail: mapTaskDetail(existing[0]),
      created: false
    };
  }

  async completeTask(chatId: string, taskId: string): Promise<CompleteTaskResult | null> {
    const currentRows = await this.sql<TaskRow[]>`
      select id, chat_id, title, normalized_title, status, created_at, completed_at
      from tasks
      where chat_id = ${chatId} and id = ${taskId}
      limit 1
    `;

    if (currentRows.length === 0) {
      return null;
    }

    const current = currentRows[0];

    if (current.status === "completed") {
      const details = await this.sql<TaskDetailRow[]>`
        select id, task_id, text, normalized_text, created_at
        from task_details
        where task_id = ${taskId}
        order by created_at asc
      `;

      return {
        changed: false,
        task: {
          id: current.id,
          chatId: current.chat_id,
          title: current.title,
          normalizedTitle: current.normalized_title,
          status: current.status,
          createdAt: current.created_at,
          completedAt: current.completed_at,
          details: details.map(mapTaskDetail)
        }
      };
    }

    const updatedRows = await this.sql<TaskRow[]>`
      update tasks
      set status = 'completed', completed_at = now()
      where chat_id = ${chatId} and id = ${taskId}
      returning id, chat_id, title, normalized_title, status, created_at, completed_at
    `;

    const updated = updatedRows[0];
    const details = await this.sql<TaskDetailRow[]>`
      select id, task_id, text, normalized_text, created_at
      from task_details
      where task_id = ${taskId}
      order by created_at asc
    `;

    return {
      changed: true,
      task: {
        id: updated.id,
        chatId: updated.chat_id,
        title: updated.title,
        normalizedTitle: updated.normalized_title,
        status: updated.status,
        createdAt: updated.created_at,
        completedAt: updated.completed_at,
        details: details.map(mapTaskDetail)
      }
    };
  }

  async getRecentConversation(chatId: string, limit: number): Promise<ConversationMessage[]> {
    const rows = await this.sql<ConversationRow[]>`
      select id, chat_id, role, content, created_at
      from (
        select id, chat_id, role, content, created_at
        from conversation_messages
        where chat_id = ${chatId}
        order by created_at desc
        limit ${limit}
      ) recent
      order by created_at asc
    `;

    return rows.map(mapConversation);
  }

  async storeConversationMessage(chatId: string, role: ChatRole, content: string): Promise<void> {
    await this.sql`
      insert into conversation_messages (chat_id, role, content)
      values (${chatId}, ${role}, ${content})
    `;
  }

  async getProcessedMessage(chatId: string, idempotencyKey: string): Promise<ProcessedMessage | null> {
    const rows = await this.sql<ProcessedMessageRow[]>`
      select id, chat_id, idempotency_key, original_text, normalized_text, assistant_response, created_at
      from processed_messages
      where chat_id = ${chatId} and idempotency_key = ${idempotencyKey}
      limit 1
    `;

    return rows[0] ? mapProcessedMessage(rows[0]) : null;
  }

  async storeProcessedMessage(
    chatId: string,
    idempotencyKey: string,
    originalText: string,
    normalizedText: string,
    assistantResponse: string
  ): Promise<void> {
    await this.sql`
      insert into processed_messages (chat_id, idempotency_key, original_text, normalized_text, assistant_response)
      values (${chatId}, ${idempotencyKey}, ${originalText}, ${normalizeMessageText(normalizedText)}, ${assistantResponse})
      on conflict (chat_id, idempotency_key) do nothing
    `;
  }

  async reset(chatId?: string): Promise<void> {
    if (!chatId) {
      await this.sql`truncate table task_details, tasks, conversation_messages, processed_messages restart identity cascade`;
      return;
    }

    await this.sql`delete from task_details where task_id in (select id from tasks where chat_id = ${chatId})`;
    await this.sql`delete from tasks where chat_id = ${chatId}`;
    await this.sql`delete from conversation_messages where chat_id = ${chatId}`;
    await this.sql`delete from processed_messages where chat_id = ${chatId}`;
  }
}

export class PostgresTaskRepository implements TaskRepository {
  private readonly sql: postgres.Sql<{}>;
  private readonly transaction: PostgresTaskRepositoryTransaction;

  constructor(connectionString: string) {
    if (!connectionString) {
      throw new Error("DATABASE_URL is required for the Postgres repository.");
    }

    this.sql = postgres(connectionString, {
      max: 1
    });
    this.transaction = new PostgresTaskRepositoryTransaction(this.sql);
  }

  async ensureSchema(): Promise<void> {
    await this.sql`create extension if not exists pgcrypto`;
    await this.sql`
      create table if not exists tasks (
        id uuid primary key default gen_random_uuid(),
        chat_id text not null,
        title text not null,
        normalized_title text not null,
        status text not null default 'open',
        created_at timestamptz not null default now(),
        completed_at timestamptz null,
        constraint tasks_status_check check (status in ('open', 'completed')),
        constraint tasks_chat_title_unique unique (chat_id, normalized_title)
      )
    `;
    await this.sql`
      create table if not exists task_details (
        id uuid primary key default gen_random_uuid(),
        task_id uuid not null references tasks(id) on delete cascade,
        text text not null,
        normalized_text text not null,
        created_at timestamptz not null default now(),
        constraint task_details_task_text_unique unique (task_id, normalized_text)
      )
    `;
    await this.sql`
      create table if not exists conversation_messages (
        id uuid primary key default gen_random_uuid(),
        chat_id text not null,
        role text not null,
        content text not null,
        created_at timestamptz not null default now(),
        constraint conversation_role_check check (role in ('user', 'assistant'))
      )
    `;
    await this.sql`
      create table if not exists processed_messages (
        id uuid primary key default gen_random_uuid(),
        chat_id text not null,
        idempotency_key text not null,
        original_text text not null,
        normalized_text text not null,
        assistant_response text not null,
        created_at timestamptz not null default now(),
        constraint processed_messages_unique unique (chat_id, idempotency_key)
      )
    `;
    await this.sql`create index if not exists tasks_chat_id_idx on tasks(chat_id)`;
    await this.sql`create index if not exists details_task_id_idx on task_details(task_id)`;
    await this.sql`create index if not exists conversation_chat_created_idx on conversation_messages(chat_id, created_at desc)`;
  }

  async listTasks(chatId: string): Promise<Task[]> {
    return this.transaction.listTasks(chatId);
  }

  async getTask(chatId: string, taskId: string): Promise<Task | null> {
    return this.transaction.getTask(chatId, taskId);
  }

  async upsertTask(chatId: string, title: string): Promise<CreateTaskResult> {
    return this.transaction.upsertTask(chatId, title);
  }

  async addDetail(taskId: string, text: string): Promise<AddDetailResult> {
    return this.transaction.addDetail(taskId, text);
  }

  async completeTask(chatId: string, taskId: string): Promise<CompleteTaskResult | null> {
    return this.transaction.completeTask(chatId, taskId);
  }

  async getRecentConversation(chatId: string, limit: number): Promise<ConversationMessage[]> {
    return this.transaction.getRecentConversation(chatId, limit);
  }

  async storeConversationMessage(chatId: string, role: ChatRole, content: string): Promise<void> {
    return this.transaction.storeConversationMessage(chatId, role, content);
  }

  async getProcessedMessage(chatId: string, idempotencyKey: string): Promise<ProcessedMessage | null> {
    return this.transaction.getProcessedMessage(chatId, idempotencyKey);
  }

  async storeProcessedMessage(
    chatId: string,
    idempotencyKey: string,
    originalText: string,
    normalizedText: string,
    assistantResponse: string
  ): Promise<void> {
    return this.transaction.storeProcessedMessage(chatId, idempotencyKey, originalText, normalizedText, assistantResponse);
  }

  async reset(chatId?: string): Promise<void> {
    return this.transaction.reset(chatId);
  }

  async withTransaction<T>(work: (tx: TaskRepositoryTransaction) => Promise<T>): Promise<T> {
    const result = await this.sql.begin(async (sql) => {
      const tx = new PostgresTaskRepositoryTransaction(sql);
      return work(tx);
    });

    return result as T;
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}

