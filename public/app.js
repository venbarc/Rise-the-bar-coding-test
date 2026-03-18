const state = {
  tasks: [],
  selectedTaskId: null,
  busy: false,
  pendingBubbleId: null
};

const chatLog = document.getElementById("chat-log");
const chatForm = document.getElementById("chat-form");
const messageInput = document.getElementById("message-input");
const taskList = document.getElementById("task-list");
const taskDetail = document.getElementById("task-detail");
const resetButton = document.getElementById("reset-button");
const submitButton = document.getElementById("submit-button");
const composerStatus = document.getElementById("composer-status");
const liveIndicator = document.getElementById("live-indicator");

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildRoleIcon(role) {
  if (role === "assistant") {
    return `
      <span class="chat-avatar assistant" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3 13.7 8.3 19 10 13.7 11.7 12 17 10.3 11.7 5 10 10.3 8.3 12 3Z"></path>
          <path d="M18.4 16.8 19 18.5 20.7 19.1 19 19.7 18.4 21.4 17.8 19.7 16.1 19.1 17.8 18.5 18.4 16.8Z"></path>
        </svg>
      </span>
    `;
  }

  return `
    <span class="chat-avatar user" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="8" r="3.4"></circle>
        <path d="M5.5 19c1.5-3.1 4-4.6 6.5-4.6S17 15.9 18.5 19"></path>
      </svg>
    </span>
  `;
}

function setBusy(isBusy, label = "Ready.") {
  state.busy = isBusy;
  messageInput.disabled = isBusy;
  submitButton.disabled = isBusy;
  resetButton.disabled = isBusy;
  composerStatus.textContent = label;
  liveIndicator.textContent = isBusy ? "Processing" : "Idle";
  liveIndicator.classList.toggle("busy", isBusy);
  document.body.classList.toggle("busy", isBusy);
}

function scrollChatToBottom() {
  chatLog.scrollTop = chatLog.scrollHeight;
}

function buildBubbleMarkup(role, text, meta = "", pending = false) {
  return `
    <div class="chat-head">
      ${buildRoleIcon(role)}
      <span class="chat-role">${role === "user" ? "You" : "Assistant"}</span>
    </div>
    <p>${escapeHtml(text)}</p>
    ${meta ? `<span class="chat-meta">${escapeHtml(meta)}</span>` : ""}
    ${pending ? '<span class="chat-pending-dots"><i></i><i></i><i></i></span>' : ""}
  `;
}

function appendChatBubble(role, text, options = {}) {
  const bubble = document.createElement("div");
  bubble.className = `chat-bubble ${role}${options.pending ? " pending" : ""}`;
  bubble.dataset.role = role;
  bubble.innerHTML = buildBubbleMarkup(role, text, options.meta || "", options.pending);
  chatLog.appendChild(bubble);
  scrollChatToBottom();
  return bubble;
}

function replacePendingBubble(text, options = {}) {
  if (!state.pendingBubbleId) {
    appendChatBubble("assistant", text, options);
    return;
  }

  const pendingBubble = document.getElementById(state.pendingBubbleId);

  if (!pendingBubble) {
    state.pendingBubbleId = null;
    appendChatBubble("assistant", text, options);
    return;
  }

  pendingBubble.className = "chat-bubble assistant";
  pendingBubble.innerHTML = buildBubbleMarkup("assistant", text, options.meta || "", false);
  state.pendingBubbleId = null;
  scrollChatToBottom();
}

function showPendingAssistant(text) {
  const bubble = appendChatBubble("assistant", text, { pending: true });
  bubble.id = `pending-${Date.now()}`;
  state.pendingBubbleId = bubble.id;
}

function renderConversation(messages) {
  chatLog.innerHTML = "";

  if (!messages || messages.length === 0) {
    appendChatBubble("assistant", "Ask me to create, complete, or update a task.");
    return;
  }

  messages.forEach((message) => {
    appendChatBubble(message.role, message.content);
  });
}

function renderTaskList() {
  taskList.innerHTML = "";

  if (state.tasks.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-list";
    empty.textContent = "No tasks yet.";
    taskList.appendChild(empty);
    renderTaskDetail(null);
    return;
  }

  state.tasks.forEach((task, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `task-row ${task.id === state.selectedTaskId ? "selected" : ""}`;
    button.innerHTML = `
      <span class="task-index">${index + 1}</span>
      <span class="task-copy">
        <strong>${escapeHtml(task.title)}</strong>
        <small>${task.status === "completed" ? "Completed" : "Open"} <span class="separator">/</span> ${task.details.length} details</small>
      </span>
    `;
    button.addEventListener("click", () => {
      state.selectedTaskId = task.id;
      renderTaskList();
      renderTaskDetail(task);
    });

    const item = document.createElement("li");
    item.appendChild(button);
    taskList.appendChild(item);
  });

  const selectedTask = state.tasks.find((task) => task.id === state.selectedTaskId) ?? state.tasks[0];
  state.selectedTaskId = selectedTask.id;
  renderTaskDetail(selectedTask);
}

function renderTaskDetail(task) {
  if (!task) {
    taskDetail.className = "task-detail empty-state";
    taskDetail.innerHTML = "Select a task to view its notes, status, and detail history.";
    return;
  }

  const details = task.details.length
    ? task.details
        .map(
          (detail) => `
            <li>
              <span>${escapeHtml(detail.text)}</span>
              <time>${new Date(detail.createdAt).toLocaleString()}</time>
            </li>
          `
        )
        .join("")
    : '<li class="empty-list">No details yet.</li>';

  taskDetail.className = "task-detail";
  taskDetail.innerHTML = `
    <div class="task-detail-header">
      <div>
        <p class="eyebrow">Task Detail</p>
        <h3>${escapeHtml(task.title)}</h3>
        <p class="detail-status ${task.status === "completed" ? "done" : "open"}">${task.status === "completed" ? "Completed" : "Open"}</p>
      </div>
      <button class="ghost-button complete-button" type="button" ${task.status === "completed" || state.busy ? "disabled" : ""} id="complete-task-button">
        ${task.status === "completed" ? "Completed" : "Mark complete"}
      </button>
    </div>
    <ul class="detail-list">${details}</ul>
  `;

  const completeButton = document.getElementById("complete-task-button");

  if (completeButton && task.status !== "completed") {
    completeButton.addEventListener("click", async () => {
      setBusy(true, `Completing \"${task.title}\"...`);
      showPendingAssistant("Updating task status");

      try {
        const response = await fetch(`/api/tasks/${task.id}/complete`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({})
        });

        const payload = await response.json();

        if (!response.ok) {
          throw new Error(payload.error || "Failed to complete task.");
        }

        replacePendingBubble(payload.assistantResponse);
        await refreshData();
      } catch (error) {
        replacePendingBubble(error.message || "Failed to complete task.");
      } finally {
        setBusy(false, "Ready.");
      }
    });
  }
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || `Request failed for ${url}`);
  }

  return payload;
}

async function loadTasks() {
  const payload = await fetchJson("/api/tasks");
  state.tasks = payload.tasks;
  renderTaskList();
}

async function loadConversation() {
  const payload = await fetchJson("/api/chat/history?limit=40");
  renderConversation(payload.messages);
}

async function refreshData() {
  await Promise.all([loadTasks(), loadConversation()]);
}

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = messageInput.value.trim();

  if (!message || state.busy) {
    return;
  }

  appendChatBubble("user", message);
  messageInput.value = "";
  setBusy(true, "Interpreting message...");
  showPendingAssistant("Processing request");

  try {
    const payload = await fetchJson("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ message })
    });

    replacePendingBubble(payload.assistantResponse, payload.idempotentReplay ? { meta: "Idempotent replay" } : {});
    await refreshData();
  } catch (error) {
    replacePendingBubble(error.message || "Failed to process message.");
  } finally {
    setBusy(false, "Ready.");
    messageInput.focus();
  }
});


resetButton.addEventListener("click", async () => {
  if (state.busy) {
    return;
  }

  setBusy(true, "Resetting system state...");
  showPendingAssistant("Resetting state");

  try {
    await fetchJson("/api/admin/reset", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({})
    });

    state.tasks = [];
    state.selectedTaskId = null;
    renderTaskList();
    renderConversation([]);
    replacePendingBubble("System state reset.");
  } catch (error) {
    replacePendingBubble(error.message || "Failed to reset state.");
  } finally {
    setBusy(false, "Ready.");
  }
});

setBusy(false, "Loading saved state...");
Promise.all([loadTasks(), loadConversation()])
  .catch((error) => {
    appendChatBubble("assistant", error.message || "Failed to load initial state.");
  })
  .finally(() => {
    setBusy(false, "Ready.");
  });

