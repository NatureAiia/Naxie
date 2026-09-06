import { injectable, inject, postConstruct } from "@theia/core/shared/inversify";
import { WidgetFactory, LabelProvider } from "@theia/core/lib/browser";
import { Widget } from "@theia/core/lib/common";
import { AgentDefinition, AGENT_DEFINITIONS } from "../common/agent-types";
import { AgentDockWidget } from "./agent-dock-widget";

@injectable()
export class AgentDockFactory implements WidgetFactory {
  static readonly ID = "naxion-agent-dock-factory";

  readonly id = AgentDockFactory.ID;

  @inject(LabelProvider)
  protected readonly labelProvider: LabelProvider;

  async createWidget(agentId: string): Promise<Widget> {
    const agent = AGENT_DEFINITIONS.find((a) => a.id === agentId);
    if (!agent) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    const widget = new AgentDockWidget(agent);
    return widget;
  }
}
