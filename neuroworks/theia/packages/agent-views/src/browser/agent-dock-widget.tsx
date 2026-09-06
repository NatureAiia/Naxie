import { Message } from "@theia/core/shared/inversify";
import { BaseWidget } from "@theia/core/lib/browser";
import { Event, Emitter } from "@theia/core";
import { AgentDefinition } from "../common/agent-types";

export class AgentDockWidget extends BaseWidget {
  static readonly ID_PREFIX = "naxion-agent-dock";

  protected readonly onDidChangeDirtyEmitter = new Emitter<boolean>();
  readonly onDidChangeDirty: Event<boolean> = this.onDidChangeDirtyEmitter.event;

  protected readonly onDidSaveEmitter = new Emitter<void>();
  readonly onDidSave: Event<void> = this.onDidSaveEmitter.event;

  constructor(protected readonly agent: AgentDefinition) {
    super();
    this.id = `${AgentDockWidget.ID_PREFIX}-${agent.id}`;
    this.title.label = agent.label;
    this.title.caption = agent.description;
    this.title.closable = true;
    this.addClass("naxion-agent-dock-widget");
    this.init();
  }

  protected init(): void {
    const content = document.createElement("div");
    content.className = "naxion-agent-dock";

    content.innerHTML = `
      <div class="naxion-agent-header" style="border-left: 3px solid ${this.agent.color}">
        <div class="naxion-agent-info">
          <h3>${this.agent.label}</h3>
          <p>${this.agent.description}</p>
        </div>
        <div class="naxion-agent-status">
          <span class="naxion-status-dot" style="background: ${this.agent.color}"></span>
          <span>Ready</span>
        </div>
      </div>
      <div class="naxion-agent-messages" id="messages-${this.agent.id}">
        <div class="naxion-agent-welcome">
          <p>Welcome to ${this.agent.label}. How can I help you today?</p>
        </div>
      </div>
      <div class="naxion-agent-input-area">
        <textarea
          class="naxion-agent-input"
          id="input-${this.agent.id}"
          placeholder="Ask ${this.agent.label} anything..."
          rows="3"
        ></textarea>
        <button class="naxion-agent-send" id="send-${this.agent.id}" style="background: ${this.agent.color}">
          Send
        </button>
      </div>
    `;

    this.node.appendChild(content);

    const input = document.getElementById(
      `input-${this.agent.id}`
    ) as HTMLTextAreaElement;
    const sendBtn = document.getElementById(
      `send-${this.agent.id}`
    ) as HTMLButtonElement;
    const messages = document.getElementById(
      `messages-${this.agent.id}`
    ) as HTMLDivElement;

    const sendMessage = () => {
      const text = input.value.trim();
      if (!text) return;

      const userMsg = document.createElement("div");
      userMsg.className = "naxion-message naxion-message-user";
      userMsg.textContent = text;
      messages.appendChild(userMsg);

      input.value = "";
      messages.scrollTop = messages.scrollHeight;

      // Placeholder — real implementation proxies through agent gateway
      setTimeout(() => {
        const agentMsg = document.createElement("div");
        agentMsg.className = "naxion-message naxion-message-agent";
        agentMsg.textContent = `[${this.agent.label}] Processing: "${text}"`;
        messages.appendChild(agentMsg);
        messages.scrollTop = messages.scrollHeight;
      }, 500);
    };

    sendBtn.addEventListener("click", sendMessage);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        sendMessage();
      }
    });
  }

  protected onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg);
    const input = this.node.querySelector(
      ".naxion-agent-input"
    ) as HTMLTextAreaElement;
    if (input) input.focus();
  }
}
